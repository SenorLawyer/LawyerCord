/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { generateWaveform } from "@plugins/voiceMessages/waveform";
import { sleep } from "@utils/misc";
import { ChannelStore, GuildStore, SnowflakeUtils } from "@webpack/common";

import { decodeAudio } from "../voiceMessageTranscriber.desktop/utils";
import {
    type Args,
    type ChannelInfo,
    fetchMessage,
    requireChannel,
    requireGuild,
    type ToolEnv,
} from "./context";
import {
    normalizeBoundedInteger,
    normalizeEmoji,
    normalizeMessageLimit,
    normalizeSearchHas,
    normalizeSearchOffset,
    normalizeSearchQuery,
    normalizeSearchSortOrder,
    normalizeSnowflakeList,
    optionalBoolean,
    optionalText,
    parseDiscordLink,
    requireOneOf,
    requireSnowflake,
} from "./policy";
import { api, bodyList, bodyRecord, failureStatus, routes } from "./rest";
import {
    isRaw,
    MESSAGE_FLAGS,
    type Raw,
    serializeAttachment,
    serializeChannel,
    serializeChannelDetails,
    serializeMessage,
    serializeUser,
    str,
    THREAD_TYPES,
} from "./serialize";

const MAX_WAVEFORM_CACHE_ENTRIES = 25;
const MAX_SEARCH_OFFSET = 5_000;
const MAX_INDEX_RETRIES = 4;
const waveformCache = new Map<string, Promise<string>>();

export function clearWaveformCache() {
    waveformCache.clear();
}

async function waveformFromBytes(bytes: Uint8Array, contentType: string): Promise<string> {
    const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
    return generateWaveform(await decodeAudio(blob), 16_000);
}

function generateAttachmentWaveform(url: string, env: ToolEnv): Promise<string> {
    const cached = waveformCache.get(url);
    if (cached) return cached;

    const pending = env.native.fetchDiscordAttachment(url)
        .then(({ contentType, data }) => { env.check(); return waveformFromBytes(data, contentType); })
        .catch(error => {
            if (waveformCache.get(url) === pending) waveformCache.delete(url);
            throw error;
        });
    waveformCache.set(url, pending);
    if (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
        const oldest = waveformCache.keys().next();
        if (!oldest.done) waveformCache.delete(oldest.value);
    }
    return pending;
}

async function serializeWithWaveform(message: Raw, env: ToolEnv) {
    const serialized = serializeMessage(message);
    if (!serialized.isVoiceMessage) return serialized;

    const rawAttachments = Array.isArray(message.attachments) ? message.attachments.filter(isRaw) : [];
    await Promise.all(serialized.attachments.map(async (attachment, index) => {
        const url = rawAttachments[index]?.url;
        if (attachment.waveform || typeof url !== "string") return;
        attachment.waveform = await generateAttachmentWaveform(url, env);
        attachment.waveformSource = "generated";
    }));
    return serialized;
}

function describeChannel(info: { id: string; name: string | null; guildId: string | null; type: number; }) {
    return { id: info.id, name: info.name, guildId: info.guildId, type: info.type };
}

async function fetchPage(channelId: string, anchors: { before?: string; after?: string; around?: string; }, limit: number, env: ToolEnv) {
    const response = await api("get", { url: routes.messages(channelId), query: { limit, ...anchors } }, env.check);
    return bodyList(response, "message list");
}

function readAnchors(args: Args) {
    const anchors = {
        before: args.before === undefined ? undefined : requireSnowflake(args.before, "before"),
        after: args.after === undefined ? undefined : requireSnowflake(args.after, "after"),
        around: args.around === undefined ? undefined : requireSnowflake(args.around, "around"),
    };
    if (Object.values(anchors).filter(Boolean).length > 1)
        throw new Error("Only one of before, after, or around may be provided");
    return anchors;
}

function page(messages: Raw[], limit: number, anchors: { around?: string; }) {
    const serialized = messages.map(serializeMessage);
    const full = messages.length >= limit;
    return {
        order: "newest_first",
        messages: serialized,
        count: serialized.length,
        hasMore: anchors.around ? null : full,
        nextBefore: !anchors.around && full ? serialized[serialized.length - 1]?.id ?? null : null,
        nextAfter: serialized[0]?.id ?? null,
    };
}

export async function readMessages(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const anchors = readAnchors(args);
    const limit = normalizeMessageLimit(args.limit);
    return { channel: describeChannel(channel), ...page(await fetchPage(channel.id, anchors, limit, env), limit, anchors) };
}

export async function bulkReadMessages(args: Args, env: ToolEnv) {
    if (!Array.isArray(args.channel_ids) || args.channel_ids.length < 1 || args.channel_ids.length > 10)
        throw new Error("channel_ids must contain 1 to 10 channel IDs available to the authenticated account");
    const ids = [...new Set(args.channel_ids.map(id => requireSnowflake(id, "channel_ids")))];
    const limitPerChannel = normalizeMessageLimit(args.limit_per_channel);
    if (ids.length * limitPerChannel > 500) throw new Error("bulk reads are capped at 500 total requested messages");

    const infos: ChannelInfo[] = [];
    for (const id of ids) infos.push(await requireChannel(id, "channel_ids"));
    const channels: Array<{ channelId: string; channel: ReturnType<typeof describeChannel>; } & ReturnType<typeof page>> = [];
    for (const info of infos) {
        env.check();
        const messages = await fetchPage(info.id, {}, limitPerChannel, env);
        channels.push({ channelId: info.id, channel: describeChannel(info), ...page(messages, limitPerChannel, {}) });
    }
    return { channels, totalMessages: channels.reduce((total, channel) => total + channel.count, 0) };
}

function extractSearchHit(group: unknown): Raw | null {
    if (!Array.isArray(group)) return null;
    return group.find(message => isRaw(message) && message.hit === true && message.id)
        ?? group.find(message => isRaw(message) && message.id) ?? null;
}

function dateToSnowflake(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(time)) throw new Error(`${field} must be an ISO 8601 date such as 2026-01-31 or 2026-01-31T12:00:00Z`);
    return SnowflakeUtils.fromTimestamp(time);
}

function boundary(id: unknown, date: unknown, idField: string, dateField: string): string | undefined {
    if (id !== undefined && date !== undefined) throw new Error(`Use either ${idField} or ${dateField}, not both`);
    return id === undefined ? dateToSnowflake(date, dateField) : requireSnowflake(id, idField);
}

export async function searchMessages(args: Args, env: ToolEnv) {
    if (args.channel_id === undefined && args.guild_id === undefined)
        throw new Error("One of channel_id or guild_id is required for message search");
    const channel = args.channel_id === undefined ? undefined : await requireChannel(args.channel_id);
    const requestedGuildId = args.guild_id === undefined ? undefined : requireGuild(args.guild_id).id;
    if (requestedGuildId && channel && requestedGuildId !== channel.guildId) throw new Error("channel_id does not belong to guild_id");
    const guildId = requestedGuildId ?? channel?.guildId ?? undefined;
    if (args.channel_ids !== undefined && !guildId) throw new Error("channel_ids needs a guild_id");
    const extraChannels = normalizeSnowflakeList(args.channel_ids, "channel_ids", 10);

    const query = normalizeSearchQuery(args.query);
    const authorId = args.author_id === undefined ? undefined : requireSnowflake(args.author_id, "author_id");
    const mentionsUserId = args.mentions_user_id === undefined ? undefined : requireSnowflake(args.mentions_user_id, "mentions_user_id");
    const has = normalizeSearchHas(args.has);
    const pinned = optionalBoolean(args.pinned, "pinned");
    const authorType = args.author_type === undefined ? undefined : requireOneOf(args.author_type, "author_type", ["user", "bot", "webhook"] as const);
    const linkHostname = optionalText(args.link_hostname, "link_hostname", 255);
    const attachmentExtension = optionalText(args.attachment_extension, "attachment_extension", 20);
    const attachmentFilename = optionalText(args.attachment_filename, "attachment_filename", 255);
    const mentionEveryone = optionalBoolean(args.mention_everyone, "mention_everyone");
    const includeNsfw = optionalBoolean(args.include_nsfw, "include_nsfw");
    const beforeId = boundary(args.before_message_id, args.before_date, "before_message_id", "before_date");
    const afterId = boundary(args.after_message_id, args.after_date, "after_message_id", "after_date");
    const sortBy = requireOneOf(args.sort_by, "sort_by", ["timestamp", "relevance"] as const, "timestamp");
    const sortOrder = normalizeSearchSortOrder(args.sort_order);
    const limit = normalizeMessageLimit(args.limit);
    const initialOffset = normalizeSearchOffset(args.offset);

    const filters = [query, authorId, mentionsUserId, has.length || undefined, pinned, authorType, linkHostname, attachmentExtension,
        attachmentFilename, mentionEveryone, beforeId, afterId];
    if (filters.every(value => value === undefined)) throw new Error("Search requires query or at least one message filter");

    const baseUrl = guildId ? routes.guildSearch(guildId) : channel ? routes.channelSearch(channel.id) : null;
    if (!baseUrl) throw new Error("One of channel_id or guild_id is required for message search");
    const fixed = new URLSearchParams({ sort_by: sortBy, sort_order: sortOrder });
    if (channel && guildId) fixed.append("channel_id", channel.id);
    for (const id of extraChannels) fixed.append("channel_id", id);
    const optional: Array<[string, string | undefined]> = [
        ["content", query], ["author_id", authorId], ["mentions", mentionsUserId], ["author_type", authorType],
        ["link_hostname", linkHostname], ["attachment_extension", attachmentExtension], ["attachment_filename", attachmentFilename],
        ["mention_everyone", mentionEveryone === undefined ? undefined : String(mentionEveryone)],
        ["include_nsfw", includeNsfw === undefined ? undefined : String(includeNsfw)],
        ["pinned", pinned === undefined ? undefined : String(pinned)], ["max_id", beforeId], ["min_id", afterId],
    ];
    for (const [key, value] of optional) if (value !== undefined) fixed.set(key, value);
    for (const filter of has) fixed.append("has", filter);

    const messages: Array<ReturnType<typeof serializeMessage> & { channel: ReturnType<typeof serializeChannel> | { id: string; }; }> = [];
    const seen = new Set<string>();
    let totalResults: number | null = null;
    let consumed = 0;
    let exhausted = false;
    let indexRetries = 0;

    while (messages.length < limit && initialOffset + consumed <= MAX_SEARCH_OFFSET) {
        env.check();
        const parameters = new URLSearchParams(fixed);
        parameters.set("offset", String(initialOffset + consumed));
        const body = bodyRecord(await api("get", { url: `${baseUrl}?${parameters}` }, env.check), "search result");
        if (!Array.isArray(body.messages)) {
            if (typeof body.retry_after === "number" && indexRetries++ < MAX_INDEX_RETRIES) {
                await sleep(Math.min(5_000, Math.ceil(body.retry_after * 1_000)));
                continue;
            }
            throw new Error(typeof body.retry_after === "number" ? "Discord is still indexing this search. Try again shortly." : "Discord returned an invalid search result");
        }
        if (typeof body.total_results === "number") totalResults = body.total_results;

        let pageConsumed = 0;
        for (const group of body.messages) {
            pageConsumed++;
            const hit = extractSearchHit(group);
            if (hit?.id && !seen.has(String(hit.id))) {
                seen.add(String(hit.id));
                const hitChannel = ChannelStore.getChannel(String(hit.channel_id));
                const serialized = serializeMessage(hit);
                if (!serialized.guildId && hitChannel?.guild_id) serialized.guildId = hitChannel.guild_id;
                messages.push({ ...serialized, channel: hitChannel ? serializeChannel(hitChannel) : { id: String(hit.channel_id) } });
            }
            if (messages.length >= limit) break;
        }

        consumed += pageConsumed;
        if (body.messages.length === 0 || (pageConsumed === body.messages.length && body.messages.length < 25)) {
            exhausted = true;
            break;
        }
    }

    const nextOffset = initialOffset + consumed;
    const hasMore = !exhausted && nextOffset <= MAX_SEARCH_OFFSET && (totalResults === null || nextOffset < totalResults);
    return {
        scope: guildId
            ? { type: "guild", guild: { id: guildId, name: GuildStore.getGuild(guildId)?.name ?? null }, channel: channel ? serializeChannel(channel.object) : null }
            : { type: "channel", channel: channel ? serializeChannel(channel.object) : null },
        filters: {
            query: query ?? null,
            authorId: authorId ?? null,
            mentionsUserId: mentionsUserId ?? null,
            has,
            pinned: pinned ?? null,
            authorType: authorType ?? null,
            linkHostname: linkHostname ?? null,
            attachmentExtension: attachmentExtension ?? null,
            attachmentFilename: attachmentFilename ?? null,
            mentionEveryone: mentionEveryone ?? null,
            channelIds: extraChannels,
            beforeMessageId: beforeId ?? null,
            afterMessageId: afterId ?? null,
            sortBy,
            sortOrder,
        },
        offset: initialOffset,
        nextOffset: hasMore ? nextOffset : null,
        hasMore,
        totalResults,
        resultCount: messages.length,
        messages,
    };
}

export async function getMessage(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const message = await fetchMessage(channel.id, requireSnowflake(args.message_id, "message_id"));
    env.check();
    return serializeWithWaveform(message, env);
}

export async function downloadAttachment(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const attachmentId = requireSnowflake(args.attachment_id, "attachment_id");
    const message = await fetchMessage(channel.id, messageId);
    env.check();
    const attachment = (Array.isArray(message.attachments) ? message.attachments.filter(isRaw) : []).find(item => String(item.id) === attachmentId);
    if (!attachment || typeof attachment.url !== "string" || typeof attachment.filename !== "string")
        throw new Error("Attachment was not found on that message");

    const { data, ...download } = await env.native.downloadDiscordAttachment(attachment.url, attachment.filename);
    env.check();
    const serialized = serializeAttachment(attachment);
    if (!serialized.waveform && Boolean(Number(message.flags ?? 0) & MESSAGE_FLAGS.IS_VOICE_MESSAGE)) {
        serialized.waveform = await waveformFromBytes(data, download.contentType);
        serialized.waveformSource = "generated";
    }
    return { messageId, attachment: serialized, download };
}

export async function getPinnedMessages(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const limit = normalizeBoundedInteger(args.limit, "limit", 50, 1, 50);
    const before = optionalText(args.before_pinned_at, "before_pinned_at", 40);
    const modern = await api("get", { url: routes.pins(channel.id), query: { limit, ...(before ? { before } : {}) } }, env.check).catch(error => {
        if (failureStatus(error) === 404 || failureStatus(error) === 405) return null;
        throw error;
    });

    if (modern) {
        const body = bodyRecord(modern, "pin list");
        const items = (Array.isArray(body.items) ? body.items.filter(isRaw) : []).flatMap(item =>
            isRaw(item.message) ? [{ pinnedAt: str(item.pinned_at), message: serializeMessage(item.message) }] : []);
        return {
            channelId: channel.id,
            pins: items,
            count: items.length,
            hasMore: Boolean(body.has_more),
            nextBeforePinnedAt: body.has_more ? items[items.length - 1]?.pinnedAt ?? null : null,
        };
    }

    const legacy = bodyList(await api("get", { url: routes.legacyPins(channel.id) }, env.check), "pin list").slice(0, limit);
    return {
        channelId: channel.id,
        pins: legacy.map(message => ({ pinnedAt: null, message: serializeMessage(message) })),
        count: legacy.length,
        hasMore: false,
        nextBeforePinnedAt: null,
    };
}

export async function getReactions(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    if (args.emoji === undefined) {
        const message = serializeMessage(await fetchMessage(channel.id, messageId));
        return { channelId: channel.id, messageId, reactions: message.reactions };
    }

    const limit = normalizeBoundedInteger(args.limit, "limit", 25, 1, 100);
    const after = args.after === undefined ? undefined : requireSnowflake(args.after, "after");
    const users = bodyList(await api("get", {
        url: routes.reactions(channel.id, messageId, normalizeEmoji(args.emoji)),
        query: { limit, type: 0, ...(after ? { after } : {}) },
    }, env.check), "reaction list");
    return {
        channelId: channel.id,
        messageId,
        emoji: args.emoji,
        users: users.map(serializeUser),
        count: users.length,
        hasMore: users.length === limit,
        nextAfter: users.length === limit ? String(users[users.length - 1].id) : null,
    };
}

export async function getMessageContext(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const radius = normalizeBoundedInteger(args.radius, "radius", 5, 0, 25);
    const target = await fetchMessage(channel.id, messageId);
    env.check();

    const around = radius === 0 ? [] : await fetchPage(channel.id, { around: messageId }, radius * 2 + 1, env);
    const ordered = around.filter(message => String(message.id) !== messageId).sort((a, b) => (BigInt(String(a.id)) < BigInt(String(b.id)) ? -1 : 1));
    const earlier = ordered.filter(message => BigInt(String(message.id)) < BigInt(messageId));
    const later = ordered.filter(message => BigInt(String(message.id)) > BigInt(messageId));

    const isThread = (THREAD_TYPES as readonly number[]).includes(channel.type);
    const parentId = channel.record?.parent_id;
    const parentType = parentId ? ChannelStore.getChannel(parentId)?.type : undefined;
    const starterLocation = !isThread || !parentId ? null : parentType === 15 || parentType === 16 ? channel.id : parentId;
    const starter = starterLocation
        ? await fetchMessage(starterLocation, channel.id).then(serializeMessage, () => null)
        : null;
    const thread = isRaw(target.thread) ? target.thread : null;
    return {
        channelId: channel.id,
        message: serializeMessage(target),
        referencedMessage: isRaw(target.referenced_message) ? serializeMessage(target.referenced_message) : null,
        thread: thread ? serializeChannelDetails(thread) : null,
        threadStarter: starter,
        before: earlier.map(serializeMessage),
        after: later.map(serializeMessage),
        replies: later.filter(message => isRaw(message.message_reference) && String(message.message_reference.message_id) === messageId).map(serializeMessage),
    };
}

export function resolveLink(args: Args) {
    const link = parseDiscordLink(args.url);
    if (!link) throw new Error("url must be a discord.com/channels link");
    const channel = ChannelStore.getChannel(link.channelId);
    return {
        guildId: link.guildId,
        channelId: link.channelId,
        messageId: link.messageId,
        guildName: link.guildId ? GuildStore.getGuild(link.guildId)?.name ?? null : null,
        channel: channel ? serializeChannel(channel) : null,
    };
}

export async function listMentions(args: Args, env: ToolEnv) {
    const limit = normalizeBoundedInteger(args.limit, "limit", 25, 1, 100);
    const guildId = args.guild_id === undefined ? undefined : requireSnowflake(args.guild_id, "guild_id");
    const before = args.before === undefined ? undefined : requireSnowflake(args.before, "before");
    const messages = bodyList(await api("get", {
        url: routes.mentions(),
        query: {
            limit,
            roles: optionalBoolean(args.include_roles, "include_roles") ?? true,
            everyone: optionalBoolean(args.include_everyone, "include_everyone") ?? true,
            ...(guildId ? { guild_id: guildId } : {}),
            ...(before ? { before } : {}),
        },
    }, env.check), "mention list");
    return { messages: messages.map(serializeMessage), count: messages.length, hasMore: messages.length === limit, nextBefore: messages.length === limit ? String(messages[messages.length - 1].id) : null };
}
