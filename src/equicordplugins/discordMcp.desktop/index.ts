/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { generateWaveform } from "@plugins/voiceMessages/waveform";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelType, MessageFlags } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    Constants,
    GuildChannelStore,
    GuildStore,
    RestAPI,
    SnowflakeUtils,
    UserStore,
} from "@webpack/common";

import { decodeAudio } from "../voiceMessageTranscriber.desktop/utils";
import {
    DISCORD_MCP_TOOL_NAMES,
    DiscordMcpToolName,
    normalizeMessageContent,
    normalizeMessageLimit,
    normalizeSearchHas,
    normalizeSearchOffset,
    normalizeSearchQuery,
    normalizeSearchSortOrder,
    requireSnowflake,
} from "./policy";

interface BridgeRequest {
    id: string;
    tool: DiscordMcpToolName;
    arguments?: unknown;
}

interface ToolArguments {
    channel_id?: unknown;
    channel_ids?: unknown;
    guild_id?: unknown;
    message_id?: unknown;
    attachment_id?: unknown;
    content?: unknown;
    limit?: unknown;
    limit_per_channel?: unknown;
    query?: unknown;
    author_id?: unknown;
    mentions_user_id?: unknown;
    has?: unknown;
    pinned?: unknown;
    before_message_id?: unknown;
    after_message_id?: unknown;
    sort_order?: unknown;
    offset?: unknown;
    before?: unknown;
    after?: unknown;
    around?: unknown;
    reply_to_message_id?: unknown;
    subscription_id?: unknown;
    timeout_seconds?: unknown;
}

interface RawAttachment {
    id?: unknown;
    filename?: unknown;
    content_type?: unknown;
    size?: unknown;
    width?: unknown;
    height?: unknown;
    duration_secs?: unknown;
    waveform?: unknown;
    url?: unknown;
    proxy_url?: unknown;
    title?: unknown;
    description?: unknown;
}

interface SubscriptionWaiter {
    resolve(result: SubscriptionWaitResult): void;
    timer: ReturnType<typeof setTimeout>;
}

interface MessageSubscription {
    id: string;
    channelId: string;
    createdAt: string;
    lastMessageId: string | null;
    messages: any[];
    waiter?: SubscriptionWaiter;
}

interface SubscriptionWaitResult {
    subscriptionId: string;
    timedOut: boolean;
    cancelled: boolean;
    message: any | null;
}

const Native = VencordNative.pluginHelpers.DiscordMCP as PluginNative<typeof import("./native")>;
const logger = new Logger("DiscordMCP");
const LONG_POLL_MS = 10_000;
const MAX_WAVEFORM_CACHE_ENTRIES = 25;
const MAX_SUBSCRIPTIONS = 100;
const MAX_SUBSCRIPTION_MESSAGES = 100;
const waveformCache = new Map<string, Promise<string>>();
const subscriptions = new Map<string, MessageSubscription>();
const inFlightRequests = new Set<Promise<void>>();

let bridgeGeneration = 0;

function requireAccessibleChannel(channelId: unknown): string {
    const normalized = requireSnowflake(channelId, "channel_id");
    if (!ChannelStore.getChannel(normalized))
        throw new Error("Channel is not available to the authenticated Discord account");
    return normalized;
}

function requireSubscriptionId(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value))
        throw new Error("subscription_id must be a valid subscription ID");
    return value;
}

function normalizeWaitSeconds(value: unknown): number {
    if (value === undefined) return 60;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 300)
        throw new Error("timeout_seconds must be an integer from 1 to 300");
    return value as number;
}

function argsOf(value: unknown): ToolArguments {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("arguments must be an object");
    return value as ToolArguments;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number")
        return `Discord request failed with HTTP ${error.status}`;
    if (typeof error === "string") return error;
    return "Discord MCP request failed";
}

function optionalSnowflake(value: unknown, fieldName: string): string | undefined {
    return value === undefined ? undefined : requireSnowflake(value, fieldName);
}

function serializeUser(user: any) {
    if (!user) return null;
    return {
        id: String(user.id),
        username: user.username ?? null,
        globalName: user.global_name ?? user.globalName ?? null,
        displayName: user.display_name ?? user.displayName ?? null,
        discriminator: user.discriminator ?? null,
        bot: Boolean(user.bot),
    };
}

function serializeAttachment(attachment: RawAttachment) {
    const waveform = typeof attachment.waveform === "string" ? attachment.waveform : null;
    return {
        id: String(attachment.id),
        filename: typeof attachment.filename === "string" ? attachment.filename : "attachment",
        contentType: typeof attachment.content_type === "string" ? attachment.content_type : null,
        size: typeof attachment.size === "number" ? attachment.size : null,
        width: typeof attachment.width === "number" ? attachment.width : null,
        height: typeof attachment.height === "number" ? attachment.height : null,
        durationSeconds: typeof attachment.duration_secs === "number" ? attachment.duration_secs : null,
        waveform,
        waveformSource: waveform ? "discord" : null,
        title: typeof attachment.title === "string" ? attachment.title : null,
        description: typeof attachment.description === "string" ? attachment.description : null,
    };
}

async function generateAttachmentWaveformFromBytes(bytes: Uint8Array, contentType: string): Promise<string> {
    const blob = new Blob([bytes as any], { type: contentType });
    return generateWaveform(await decodeAudio(blob), 16_000);
}

function generateAttachmentWaveform(attachment: RawAttachment): Promise<string> {
    if (typeof attachment.url !== "string") throw new Error("Voice attachment is missing its Discord CDN URL");
    const cached = waveformCache.get(attachment.url);
    if (cached) return cached;

    const pending = Native.fetchDiscordAttachment(attachment.url)
        .then(({ contentType, data }) => generateAttachmentWaveformFromBytes(data, contentType))
        .catch(error => {
            waveformCache.delete(attachment.url as string);
            throw error;
        });
    waveformCache.set(attachment.url, pending);
    if (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) waveformCache.delete(waveformCache.keys().next().value!);
    return pending;
}

async function serializeMessageWithVoiceWaveform(message: any) {
    const serialized = serializeMessage(message);
    if (!serialized.isVoiceMessage) return serialized;

    const rawAttachments = Array.isArray(message.attachments) ? message.attachments as RawAttachment[] : [];
    await Promise.all(serialized.attachments.map(async (attachment, index) => {
        if (attachment.waveform) return;
        const rawAttachment = rawAttachments[index];
        if (!rawAttachment) return;
        attachment.waveform = await generateAttachmentWaveform(rawAttachment);
        attachment.waveformSource = "generated";
    }));
    return serialized;
}

function serializeEmbed(embed: any) {
    return {
        type: embed?.type ?? null,
        title: embed?.title ?? null,
        description: embed?.description ?? null,
        url: embed?.url ?? null,
        timestamp: embed?.timestamp ?? null,
        provider: embed?.provider?.name ?? null,
        author: embed?.author?.name ?? null,
        imageUrl: embed?.image?.url ?? null,
        thumbnailUrl: embed?.thumbnail?.url ?? null,
    };
}

function serializeMessage(message: any) {
    const flags = Number(message?.flags ?? 0);
    return {
        id: String(message.id),
        channelId: String(message.channel_id),
        guildId: message.guild_id ? String(message.guild_id) : null,
        author: serializeUser(message.author),
        content: typeof message.content === "string" ? message.content : "",
        timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp ?? null,
        editedTimestamp: message.edited_timestamp ?? message.editedTimestamp?.toISOString?.() ?? null,
        type: Number(message.type ?? 0),
        flags,
        isVoiceMessage: Boolean(flags & MessageFlags.IS_VOICE_MESSAGE),
        pinned: Boolean(message.pinned),
        tts: Boolean(message.tts),
        attachments: Array.isArray(message.attachments) ? message.attachments.map(serializeAttachment) : [],
        embeds: Array.isArray(message.embeds) ? message.embeds.map(serializeEmbed) : [],
        components: Array.isArray(message.components) ? message.components : [],
        replyToMessageId: message.message_reference?.message_id ?? message.messageReference?.message_id ?? null,
    };
}

function serializeChannel(channel: Channel | any) {
    return {
        id: String(channel.id),
        guildId: channel.guild_id ? String(channel.guild_id) : null,
        type: Number(channel.type),
        name: channel.name ?? null,
        parentId: channel.parent_id ?? channel.parentId ?? null,
        position: typeof channel.position === "number" ? channel.position : null,
        topic: channel.topic ?? null,
        nsfw: Boolean(channel.nsfw),
        lastMessageId: channel.lastMessageId ?? channel.last_message_id ?? null,
    };
}

async function fetchMessage(channelId: string, messageId: string): Promise<any> {
    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: { around: messageId, limit: 1 },
        retries: 2,
    });
    const message = Array.isArray(response.body)
        ? response.body.find(candidate => String(candidate.id) === messageId)
        : null;
    if (!message || String(message.id) !== messageId || String(message.channel_id) !== channelId)
        throw new Error("Discord returned an unexpected message");
    return message;
}

function listServers() {
    return Object.values(GuildStore.getGuilds())
        .map(guild => ({
            id: guild.id,
            name: guild.name,
            description: guild.description ?? null,
            ownerId: guild.ownerId,
            preferredLocale: guild.preferredLocale,
            features: [...guild.features].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function listServerChannels(guildId: string) {
    if (!GuildStore.getGuild(guildId)) throw new Error("Server is not available in the authenticated Discord client");
    const groups = GuildChannelStore.getChannels(guildId);
    const uniqueChannels = new Map<string, Channel>();
    for (const entry of [
        ...(groups?.SELECTABLE ?? []),
        ...(groups?.VOCAL ?? []),
        ...(groups?.[ChannelType.GUILD_CATEGORY] ?? []),
    ]) {
        const channel = "channel" in entry ? entry.channel : entry;
        if (channel?.id) uniqueChannels.set(channel.id, channel as Channel);
    }
    return [...uniqueChannels.values()]
        .map(serializeChannel)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)));
}

function listDms() {
    return ChannelStore.getSortedPrivateChannels().map(channel => {
        const rawRecipients = new Map((channel.rawRecipients ?? []).map(recipient => [recipient.id, recipient]));
        return {
            ...serializeChannel(channel),
            recipients: (channel.recipients ?? [])
                .map(userId => serializeUser(UserStore.getUser(userId) ?? rawRecipients.get(userId)))
                .filter(Boolean),
        };
    });
}

function subscriptionMetadata(subscription: MessageSubscription) {
    const channel = ChannelStore.getChannel(subscription.channelId);
    return {
        id: subscription.id,
        channel: channel ? serializeChannel(channel) : { id: subscription.channelId },
        createdAt: subscription.createdAt,
        lastMessageId: subscription.lastMessageId,
        queuedMessageCount: subscription.messages.length,
        waiting: Boolean(subscription.waiter),
    };
}

function subscribeChannel(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    if (subscriptions.size >= MAX_SUBSCRIPTIONS)
        throw new Error(`Discord MCP supports at most ${MAX_SUBSCRIPTIONS} active subscriptions`);

    const channel = ChannelStore.getChannel(channelId)!;
    const subscription: MessageSubscription = {
        id: globalThis.crypto.randomUUID(),
        channelId,
        createdAt: new Date().toISOString(),
        lastMessageId: channel.lastMessageId ?? null,
        messages: [],
    };
    subscriptions.set(subscription.id, subscription);
    return subscriptionMetadata(subscription);
}

function waitForSubscription(args: ToolArguments): Promise<SubscriptionWaitResult> {
    const subscriptionId = requireSubscriptionId(args.subscription_id);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) throw new Error("Discord MCP subscription was not found");
    if (subscription.waiter) throw new Error("A wait is already active for this subscription");

    const queued = subscription.messages.shift();
    if (queued) {
        return Promise.resolve({
            subscriptionId,
            timedOut: false,
            cancelled: false,
            message: queued,
        });
    }

    const timeoutMs = normalizeWaitSeconds(args.timeout_seconds) * 1_000;
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            if (subscription.waiter?.timer === timer) subscription.waiter = undefined;
            resolve({ subscriptionId, timedOut: true, cancelled: false, message: null });
        }, timeoutMs);
        subscription.waiter = { resolve, timer };
    });
}

function unsubscribeChannel(args: ToolArguments) {
    const subscriptionId = requireSubscriptionId(args.subscription_id);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return { subscriptionId, unsubscribed: false };

    subscriptions.delete(subscriptionId);
    if (subscription.waiter) {
        clearTimeout(subscription.waiter.timer);
        subscription.waiter.resolve({ subscriptionId, timedOut: false, cancelled: true, message: null });
        subscription.waiter = undefined;
    }
    return { subscriptionId, unsubscribed: true };
}

function listSubscriptions() {
    return [...subscriptions.values()]
        .map(subscriptionMetadata)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function handleMessageCreate({ optimistic, type, message, channelId }: {
    optimistic?: boolean;
    type?: string;
    message: any;
    channelId?: string;
}) {
    if (optimistic || type !== "MESSAGE_CREATE" || !message || message.state === "SENDING") return;
    const messageChannelId = String(channelId ?? message.channel_id ?? "");
    if (!messageChannelId) return;

    for (const subscription of subscriptions.values()) {
        if (subscription.channelId !== messageChannelId || subscription.lastMessageId === String(message.id)) continue;
        subscription.lastMessageId = String(message.id);
        const serialized = serializeMessage(message);

        if (subscription.waiter) {
            const { waiter } = subscription;
            subscription.waiter = undefined;
            clearTimeout(waiter.timer);
            waiter.resolve({
                subscriptionId: subscription.id,
                timedOut: false,
                cancelled: false,
                message: serialized,
            });
        } else {
            subscription.messages.push(serialized);
            if (subscription.messages.length > MAX_SUBSCRIPTION_MESSAGES) subscription.messages.shift();
        }
    }
}

function clearSubscriptions() {
    for (const subscription of subscriptions.values()) {
        if (!subscription.waiter) continue;
        clearTimeout(subscription.waiter.timer);
        subscription.waiter.resolve({
            subscriptionId: subscription.id,
            timedOut: false,
            cancelled: true,
            message: null,
        });
    }
    subscriptions.clear();
}

async function readMessages(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    const anchors = {
        before: optionalSnowflake(args.before, "before"),
        after: optionalSnowflake(args.after, "after"),
        around: optionalSnowflake(args.around, "around"),
    };
    if (Object.values(anchors).filter(Boolean).length > 1)
        throw new Error("Only one of before, after, or around may be provided");

    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: {
            limit: normalizeMessageLimit(args.limit),
            ...anchors,
        },
        retries: 2,
    });
    if (!Array.isArray(response.body)) throw new Error("Discord returned an invalid message list");
    return response.body.map(serializeMessage);
}

async function bulkReadMessages(args: ToolArguments) {
    if (!Array.isArray(args.channel_ids) || args.channel_ids.length < 1 || args.channel_ids.length > 10)
        throw new Error("channel_ids must contain 1 to 10 channel IDs available to the authenticated account");
    const channelIds = [...new Set(args.channel_ids.map(requireAccessibleChannel))];
    const limitPerChannel = normalizeMessageLimit(args.limit_per_channel);
    if (channelIds.length * limitPerChannel > 500)
        throw new Error("bulk reads are capped at 500 total requested messages");

    const channels: Array<{ channelId: string; messages: any[]; }> = [];
    for (const channelId of channelIds) {
        channels.push({
            channelId,
            messages: await readMessages({ channel_id: channelId, limit: limitPerChannel }),
        });
    }
    return {
        channels,
        totalMessages: channels.reduce((total, channel) => total + channel.messages.length, 0),
    };
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${fieldName} must be a boolean`);
    return value;
}

function extractSearchHit(group: unknown): any | null {
    if (!Array.isArray(group)) return null;
    return group.find(message => message?.hit === true && message?.id) ?? group.find(message => message?.id) ?? null;
}

async function searchMessages(args: ToolArguments) {
    const requestedChannelId = optionalSnowflake(args.channel_id, "channel_id");
    const requestedGuildId = optionalSnowflake(args.guild_id, "guild_id");
    if (!requestedChannelId && !requestedGuildId)
        throw new Error("One of channel_id or guild_id is required for message search");

    const channelId = requestedChannelId ? requireAccessibleChannel(requestedChannelId) : undefined;
    const channel = channelId ? ChannelStore.getChannel(channelId)! : undefined;
    const channelGuildId = channel?.guild_id ? String(channel.guild_id) : undefined;
    if (requestedGuildId && !GuildStore.getGuild(requestedGuildId))
        throw new Error("Server is not available in the authenticated Discord client");
    if (requestedGuildId && channelId && requestedGuildId !== channelGuildId)
        throw new Error("channel_id does not belong to guild_id");

    const guildId = requestedGuildId ?? channelGuildId;
    const query = normalizeSearchQuery(args.query);
    const authorId = optionalSnowflake(args.author_id, "author_id");
    const mentionsUserId = optionalSnowflake(args.mentions_user_id, "mentions_user_id");
    const has = normalizeSearchHas(args.has);
    const pinned = optionalBoolean(args.pinned, "pinned");
    const beforeMessageId = optionalSnowflake(args.before_message_id, "before_message_id");
    const afterMessageId = optionalSnowflake(args.after_message_id, "after_message_id");
    const sortOrder = normalizeSearchSortOrder(args.sort_order);
    const limit = normalizeMessageLimit(args.limit);
    const initialOffset = normalizeSearchOffset(args.offset);

    if (!query && !authorId && !mentionsUserId && has.length === 0 && pinned === undefined && !beforeMessageId && !afterMessageId)
        throw new Error("Search requires query or at least one message filter");

    const baseUrl = guildId ? `/guilds/${guildId}/messages/search` : `/channels/${channelId}/messages/search`;
    const staticParameters = new URLSearchParams({ sort_by: "timestamp", sort_order: sortOrder });
    if (channelId && guildId) staticParameters.set("channel_id", channelId);
    if (query) staticParameters.set("content", query);
    if (authorId) staticParameters.set("author_id", authorId);
    if (mentionsUserId) staticParameters.set("mentions", mentionsUserId);
    for (const filter of has) staticParameters.append("has", filter);
    if (pinned !== undefined) staticParameters.set("pinned", String(pinned));
    if (beforeMessageId) staticParameters.set("max_id", beforeMessageId);
    if (afterMessageId) staticParameters.set("min_id", afterMessageId);

    const messages: any[] = [];
    const seenMessageIds = new Set<string>();
    let totalResults: number | null = null;
    let consumedResults = 0;
    let exhausted = false;

    while (messages.length < limit && initialOffset + consumedResults <= 5_000) {
        const parameters = new URLSearchParams(staticParameters);
        parameters.set("offset", String(initialOffset + consumedResults));
        const response = await RestAPI.get({ url: `${baseUrl}?${parameters}`, retries: 2 });
        const groups = Array.isArray(response.body?.messages) ? response.body.messages : null;
        if (!groups) throw new Error("Discord returned an invalid search result");
        if (typeof response.body?.total_results === "number") totalResults = response.body.total_results;

        let pageConsumed = 0;
        for (const group of groups) {
            pageConsumed++;
            const hit = extractSearchHit(group);
            if (hit?.id && !seenMessageIds.has(String(hit.id))) {
                seenMessageIds.add(String(hit.id));
                const hitChannel = ChannelStore.getChannel(String(hit.channel_id));
                const serializedHit = serializeMessage(hit);
                if (!serializedHit.guildId && hitChannel?.guild_id) serializedHit.guildId = String(hitChannel.guild_id);
                messages.push({
                    ...serializedHit,
                    channel: hitChannel ? serializeChannel(hitChannel) : { id: String(hit.channel_id) },
                });
            }
            if (messages.length >= limit) break;
        }

        consumedResults += pageConsumed;
        if (groups.length === 0 || (pageConsumed === groups.length && groups.length < 25)) {
            exhausted = true;
            break;
        }
        if (messages.length >= limit) break;
    }

    const candidateNextOffset = initialOffset + consumedResults;
    const hasMore = !exhausted && candidateNextOffset <= 5_000 &&
        (totalResults === null || candidateNextOffset < totalResults);
    return {
        scope: channelId
            ? { type: "channel", channel: serializeChannel(channel!) }
            : { type: "guild", guild: { id: guildId, name: GuildStore.getGuild(guildId!)?.name ?? null } },
        filters: {
            query: query ?? null,
            authorId: authorId ?? null,
            mentionsUserId: mentionsUserId ?? null,
            has,
            pinned: pinned ?? null,
            beforeMessageId: beforeMessageId ?? null,
            afterMessageId: afterMessageId ?? null,
            sortOrder,
        },
        offset: initialOffset,
        nextOffset: hasMore ? candidateNextOffset : null,
        totalResults,
        resultCount: messages.length,
        messages,
    };
}

async function getMessage(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    return serializeMessageWithVoiceWaveform(await fetchMessage(channelId, messageId));
}

async function downloadAttachment(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const attachmentId = requireSnowflake(args.attachment_id, "attachment_id");
    const message = await fetchMessage(channelId, messageId);
    const attachment = (message.attachments as RawAttachment[] | undefined)?.find(item => String(item.id) === attachmentId);
    if (!attachment || typeof attachment.url !== "string" || typeof attachment.filename !== "string")
        throw new Error("Attachment was not found on that message");

    const downloaded = await Native.downloadDiscordAttachment(attachment.url, attachment.filename);
    const { data, ...download } = downloaded;
    const serializedAttachment = serializeAttachment(attachment);
    if (!serializedAttachment.waveform && Boolean(Number(message.flags ?? 0) & MessageFlags.IS_VOICE_MESSAGE)) {
        serializedAttachment.waveform = await generateAttachmentWaveformFromBytes(data, download.contentType);
        serializedAttachment.waveformSource = "generated";
    }

    return {
        messageId,
        attachment: serializedAttachment,
        download,
    };
}

async function sendMessage(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    const content = normalizeMessageContent(args.content);
    const replyToMessageId = optionalSnowflake(args.reply_to_message_id, "reply_to_message_id");
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error("Channel is not available in the authenticated Discord client");
    if (replyToMessageId) await fetchMessage(channelId, replyToMessageId);

    const response = await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            channel_id: channelId,
            content,
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: [],
            type: 0,
            attachments: [],
            allowed_mentions: { parse: [], replied_user: false },
            ...(replyToMessageId ? {
                message_reference: {
                    channel_id: channelId,
                    guild_id: channel.guild_id,
                    message_id: replyToMessageId,
                },
            } : {}),
        },
    });
    const message = response.body;
    if (!message?.id || String(message.channel_id) !== channelId) throw new Error("Discord did not return the sent message");
    await Native.recordSentMessage(channelId, String(message.id));
    return serializeMessage(message);
}

async function deleteOwnMessage(args: ToolArguments) {
    const channelId = requireAccessibleChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    if (!await Native.isSentMessage(channelId, messageId))
        throw new Error("Refusing to delete a message that was not sent by Discord MCP");

    const message = await fetchMessage(channelId, messageId);
    if (String(message.author?.id) !== UserStore.getCurrentUser()?.id)
        throw new Error("Refusing to delete a message not authored by the authenticated account");

    await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) });
    await Native.forgetSentMessage(channelId, messageId);
    return { deleted: true, channelId, messageId };
}

async function executeTool(tool: DiscordMcpToolName, rawArguments: unknown): Promise<unknown> {
    const args = argsOf(rawArguments);
    switch (tool) {
        case "connection_status": return {
            connected: Boolean(UserStore.getCurrentUser()),
            currentUser: serializeUser(UserStore.getCurrentUser()),
            channelAccess: "all_accessible_channels",
            capabilities: {
                allAccessibleChannels: true,
                changesActiveView: false,
                silentBackground: true,
                subscriptions: true,
                messageSearch: true,
                membershipChanges: false,
                relationshipChanges: false,
                blocking: false,
                moderation: false,
                arbitraryRequests: false,
                mentions: false,
            },
        };
        case "list_servers": return listServers();
        case "list_server_channels": return listServerChannels(requireSnowflake(args.guild_id, "guild_id"));
        case "list_dms": return listDms();
        case "read_messages": return readMessages(args);
        case "bulk_read_messages": return bulkReadMessages(args);
        case "search_messages": return searchMessages(args);
        case "get_message": return getMessage(args);
        case "download_attachment": return downloadAttachment(args);
        case "send_message": return sendMessage(args);
        case "delete_own_message": return deleteOwnMessage(args);
        case "subscribe_channel": return subscribeChannel(args);
        case "wait_for_message": return waitForSubscription(args);
        case "list_subscriptions": return listSubscriptions();
        case "unsubscribe_channel": return unsubscribeChannel(args);
        default: throw new Error("Unsupported Discord MCP tool");
    }
}

async function handleBridgeRequest(request: Awaited<ReturnType<typeof Native.takeRequests>>[number]): Promise<void> {
    try {
        if (!DISCORD_MCP_TOOL_NAMES.includes(request.tool as DiscordMcpToolName))
            throw new Error("Unsupported Discord MCP tool");
        const result = await executeTool(request.tool as DiscordMcpToolName, request.arguments);
        await Native.writeResponse({ id: request.id, ok: true, result });
    } catch (error) {
        await Native.writeResponse({ id: request.id, ok: false, error: errorMessage(error) });
    }
}

async function bridgeLoop(generation: number): Promise<void> {
    while (generation === bridgeGeneration) {
        let requests: Awaited<ReturnType<typeof Native.takeRequests>>;
        try {
            requests = await Native.takeRequests(LONG_POLL_MS);
        } catch (error) {
            if (generation !== bridgeGeneration) return;
            logger.error("Bridge wait failed", error);
            await new Promise(resolve => setTimeout(resolve, 1_000));
            continue;
        }
        if (generation !== bridgeGeneration) return;

        for (const request of requests) {
            const task = handleBridgeRequest(request);
            inFlightRequests.add(task);
            void task.finally(() => inFlightRequests.delete(task));
        }
    }
}

export default definePlugin({
    name: "DiscordMCP",
    description: "A local, fixed-surface MCP bridge for agent access to every channel visible to this authenticated Discord client.",
    authors: [EquicordDevs.nobody],

    flux: {
        MESSAGE_CREATE: handleMessageCreate,
    },

    async start() {
        await Native.initializeBridge();
        const generation = ++bridgeGeneration;
        void bridgeLoop(generation);
    },

    stop() {
        bridgeGeneration++;
        clearSubscriptions();
    },
});
