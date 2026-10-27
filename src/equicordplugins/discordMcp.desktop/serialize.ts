/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Guild, GuildMember, Role } from "@vencord/discord-types";
import {
    ChannelStore,
    GuildMemberCountStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    IconUtils,
    PermissionsBits,
    PresenceStore,
    RelationshipStore,
    UserStore,
} from "@webpack/common";

export type Raw = Record<string, unknown>;

export const MESSAGE_FLAGS = { SUPPRESS_NOTIFICATIONS: 1 << 12, IS_VOICE_MESSAGE: 1 << 13 } as const;
export const FORUM_REQUIRE_TAG_FLAG = 1 << 4;

const CHANNEL_TYPE_NAMES: Record<number, string> = {
    0: "text",
    1: "dm",
    2: "voice",
    3: "group_dm",
    4: "category",
    5: "announcement",
    10: "announcement_thread",
    11: "public_thread",
    12: "private_thread",
    13: "stage",
    14: "directory",
    15: "forum",
    16: "media",
};

const RELATIONSHIP_NAMES: Record<number, string> = {
    0: "none",
    1: "friend",
    2: "blocked",
    3: "pending_incoming",
    4: "pending_outgoing",
    5: "implicit",
};

const MAX_EMBED_TEXT = 1_000;
const MAX_FIELD_TEXT = 300;
const MAX_MESSAGE_TEXT = 4_000;

export const THREAD_TYPES = [10, 11, 12] as const;
export const TEXT_LIKE_TYPES = [0, 1, 3, 5, 10, 11, 12] as const;

export function isRaw(value: unknown): value is Raw {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pick(source: Raw, ...keys: string[]): unknown {
    for (const key of keys) if (source[key] !== undefined) return source[key];
    return undefined;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean; } {
    return text.length > max ? { text: `${text.slice(0, max)}...`, truncated: true } : { text, truncated: false };
}

function isoTime(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    if (isRaw(value) && typeof value.toISOString === "function") return String(value.toISOString());
    return null;
}

export function colorHex(color: unknown): string | null {
    return typeof color === "number" && color > 0 ? `#${color.toString(16).padStart(6, "0")}` : null;
}

export function relationshipName(userId: string): string {
    return RELATIONSHIP_NAMES[RelationshipStore.getRelationshipType(userId)] ?? "none";
}

export function serializeUser(value: object | null | undefined) {
    if (!value) return null;
    const user = value as Raw;
    const id = String(user.id);
    const globalName = str(pick(user, "globalName", "global_name"));
    const username = str(user.username);
    const discriminator = str(user.discriminator);
    const record = UserStore.getUser(id);
    return {
        id,
        username,
        globalName,
        displayName: str(pick(user, "display_name", "displayName")) ?? globalName ?? username,
        discriminator: discriminator && discriminator !== "0" ? discriminator : null,
        bot: Boolean(user.bot),
        avatarHash: str(user.avatar),
        avatarUrl: record ? IconUtils.getUserAvatarURL(record, false, 128) : null,
    };
}

export function serializeRole(role: Role) {
    return {
        id: role.id,
        name: role.name,
        color: colorHex(role.color),
        position: role.position,
        hoist: role.hoist,
        managed: role.managed,
        mentionable: role.mentionable,
        permissions: String(role.permissions),
        unicodeEmoji: role.unicodeEmoji ?? null,
        tags: role.tags ?? null,
    };
}

export function permissionNames(bits: bigint): string[] {
    return Object.entries(PermissionsBits)
        .filter(([, bit]) => bit !== 0n && (bits & bit) === bit)
        .map(([name]) => name);
}

function allPermissions(): bigint {
    return Object.values(PermissionsBits).reduce((all, bit) => all | bit, 0n);
}

export function computeMemberPermissions(guildId: string, userId: string, roleIds: string[], channel?: Channel): bigint {
    const guild = GuildStore.getGuild(guildId);
    if (guild?.ownerId === userId) return allPermissions();

    let permissions = GuildRoleStore.getRole(guildId, guildId)?.permissions ?? 0n;
    for (const roleId of roleIds) permissions |= GuildRoleStore.getRole(guildId, roleId)?.permissions ?? 0n;
    if (permissions & PermissionsBits.ADMINISTRATOR) return allPermissions();
    if (!channel) return permissions;

    const source = channel.isThread() ? ChannelStore.getChannel(channel.parent_id) ?? channel : channel;
    const overwrites = source.permissionOverwrites ?? {};
    const everyone = overwrites[guildId];
    if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;

    let allow = 0n;
    let deny = 0n;
    for (const roleId of roleIds) {
        allow |= overwrites[roleId]?.allow ?? 0n;
        deny |= overwrites[roleId]?.deny ?? 0n;
    }
    permissions = (permissions & ~deny) | allow;

    const own = overwrites[userId];
    if (own) permissions = (permissions & ~own.deny) | own.allow;
    return permissions;
}

export function serializeMember(guildId: string, member: GuildMember) {
    const roles = member.roles.slice(0, 50).flatMap(roleId => {
        const role = GuildRoleStore.getRole(guildId, roleId);
        return role ? [{ id: role.id, name: role.name, color: colorHex(role.color) }] : [];
    });
    return {
        guildId,
        userId: member.userId,
        nick: member.nick ?? null,
        roles,
        joinedAt: member.joinedAt ?? null,
        premiumSince: member.premiumSince ?? null,
        timedOutUntil: member.communicationDisabledUntil ?? null,
        pending: Boolean(member.isPending),
        guildAvatarHash: member.avatar ?? null,
    };
}

function guildIcon(guild: Guild): string | null {
    return guild.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 128, canAnimate: false }) ?? null : null;
}

export function serializeGuild(guild: Guild) {
    return {
        id: guild.id,
        name: guild.name,
        description: guild.description ?? null,
        iconUrl: guildIcon(guild),
        ownerId: guild.ownerId,
        preferredLocale: guild.preferredLocale,
        features: [...guild.features].sort(),
        memberCount: GuildMemberCountStore.getMemberCount(guild.id) ?? null,
        premiumTier: guild.premiumTier,
        premiumSubscriberCount: guild.premiumSubscriberCount ?? 0,
    };
}

export function channelTypeName(type: number): string {
    return CHANNEL_TYPE_NAMES[type] ?? `type_${type}`;
}

export function serializeChannel(value: object) {
    const channel = value as Raw;
    const type = Number(channel.type);
    const guildId = pick(channel, "guild_id", "guildId");
    return {
        id: String(channel.id),
        guildId: guildId ? String(guildId) : null,
        type,
        typeName: channelTypeName(type),
        name: str(channel.name),
        parentId: str(pick(channel, "parent_id", "parentId")),
        position: num(channel.position),
        topic: str(channel.topic),
        nsfw: Boolean(channel.nsfw),
        lastMessageId: str(pick(channel, "lastMessageId", "last_message_id")),
    };
}

function serializeTag(tag: Raw) {
    return {
        id: String(tag.id),
        name: str(tag.name),
        emoji: str(pick(tag, "emojiName", "emoji_name")) ?? (pick(tag, "emojiId", "emoji_id") ? String(pick(tag, "emojiId", "emoji_id")) : null),
        moderated: Boolean(tag.moderated),
    };
}

export function serializeChannelDetails(value: object) {
    const channel = value as Raw;
    const metadata = pick(channel, "threadMetadata", "thread_metadata");
    const meta = isRaw(metadata) ? metadata : null;
    const tags = pick(channel, "availableTags", "available_tags");
    const recipients = pick(channel, "recipients");
    const flags = Number(channel.flags ?? 0);
    return {
        ...serializeChannel(value),
        rateLimitPerUser: num(pick(channel, "rateLimitPerUser", "rate_limit_per_user")),
        bitrate: num(channel.bitrate),
        userLimit: num(pick(channel, "userLimit", "user_limit")),
        ownerId: str(pick(channel, "ownerId", "owner_id")),
        memberCount: num(pick(channel, "memberCount", "member_count")),
        messageCount: num(pick(channel, "messageCount", "message_count")),
        flags,
        requiresTag: Boolean(flags & FORUM_REQUIRE_TAG_FLAG),
        thread: meta ? {
            archived: Boolean(meta.archived),
            locked: Boolean(meta.locked),
            autoArchiveDuration: num(pick(meta, "autoArchiveDuration", "auto_archive_duration")),
            archivedAt: str(pick(meta, "archiveTimestamp", "archive_timestamp")),
            createdAt: str(pick(meta, "createTimestamp", "create_timestamp")),
        } : null,
        availableTags: Array.isArray(tags) ? tags.filter(isRaw).map(serializeTag) : null,
        appliedTags: Array.isArray(pick(channel, "appliedTags", "applied_tags")) ? pick(channel, "appliedTags", "applied_tags") : null,
        recipients: Array.isArray(recipients)
            ? recipients.map(entry => serializeUser(isRaw(entry) ? entry : UserStore.getUser(String(entry)) ?? { id: String(entry) })).filter(Boolean)
            : null,
    };
}

export function serializeAttachment(value: object) {
    const attachment = value as Raw;
    const waveform = str(attachment.waveform);
    return {
        id: String(attachment.id),
        filename: str(attachment.filename) ?? "attachment",
        contentType: str(pick(attachment, "content_type", "contentType")),
        size: num(attachment.size),
        width: num(attachment.width),
        height: num(attachment.height),
        durationSeconds: num(pick(attachment, "duration_secs", "durationSeconds")),
        waveform,
        waveformSource: waveform ? "discord" : null,
        title: str(attachment.title),
        description: str(attachment.description),
        url: str(attachment.url),
    };
}

function textOf(value: unknown, max: number): string | null {
    return typeof value === "string" ? truncate(value, max).text : null;
}

export function serializeEmbed(value: object) {
    const embed = value as Raw;
    const nested = (key: string) => (isRaw(embed[key]) ? embed[key] as Raw : {});
    const fields = Array.isArray(embed.fields) ? embed.fields.filter(isRaw).slice(0, 10) : [];
    return {
        type: str(embed.type),
        title: textOf(embed.title, 300),
        description: textOf(embed.description, MAX_EMBED_TEXT),
        url: str(embed.url),
        timestamp: str(embed.timestamp),
        color: colorHex(embed.color),
        provider: str(nested("provider").name),
        author: str(nested("author").name),
        footer: str(nested("footer").text),
        imageUrl: str(nested("image").url),
        thumbnailUrl: str(nested("thumbnail").url),
        videoUrl: str(nested("video").url),
        fields: fields.map(field => ({ name: textOf(field.name, 100), value: textOf(field.value, MAX_FIELD_TEXT), inline: Boolean(field.inline) })),
    };
}

function serializeComponents(value: unknown, depth = 0): unknown[] {
    if (!Array.isArray(value) || depth > 3) return [];
    return value.filter(isRaw).slice(0, 25).map(component => ({
        type: num(component.type),
        customId: str(pick(component, "custom_id", "customId")),
        label: str(component.label),
        style: num(component.style),
        url: str(component.url),
        disabled: Boolean(component.disabled),
        placeholder: str(component.placeholder),
        options: Array.isArray(component.options) ? component.options.filter(isRaw).slice(0, 25).map(option => ({ label: str(option.label), value: str(option.value) })) : undefined,
        components: serializeComponents(component.components, depth + 1),
    }));
}

function serializeReaction(value: Raw) {
    const emoji = isRaw(value.emoji) ? value.emoji : {};
    return {
        emoji: { id: emoji.id ? String(emoji.id) : null, name: str(emoji.name), animated: Boolean(emoji.animated) },
        count: num(value.count) ?? 0,
        me: Boolean(value.me),
    };
}

function serializePoll(value: Raw) {
    const media = (entry: unknown) => (isRaw(entry) ? str(entry.text) : null);
    const counts = isRaw(value.results) && Array.isArray(value.results.answer_counts) ? value.results.answer_counts.filter(isRaw) : [];
    return {
        question: media(value.question),
        answers: (Array.isArray(value.answers) ? value.answers.filter(isRaw) : []).slice(0, 10).map(answer => ({
            id: num(answer.answer_id),
            text: media(answer.poll_media),
            votes: num(counts.find(count => count.id === answer.answer_id)?.count),
        })),
        expiry: str(value.expiry),
        allowMultiselect: Boolean(value.allow_multiselect),
        finalized: isRaw(value.results) ? Boolean(value.results.is_finalized) : false,
    };
}

function briefMessage(value: Raw) {
    const content = truncate(typeof value.content === "string" ? value.content : "", 300);
    return {
        id: String(value.id),
        channelId: value.channel_id ? String(value.channel_id) : null,
        author: serializeUser(isRaw(value.author) ? value.author : null),
        content: content.text,
        hasAttachments: Array.isArray(value.attachments) && value.attachments.length > 0,
    };
}

export function serializeMessage(value: object) {
    const message = value as Raw;
    const flags = Number(message.flags ?? 0);
    const author = isRaw(message.author) ? message.author : null;
    const channelId = String(pick(message, "channel_id", "channelId"));
    const guildValue = pick(message, "guild_id", "guildId") ?? ChannelStore.getChannel(channelId)?.guild_id;
    const guildId = guildValue ? String(guildValue) : null;
    const member = isRaw(message.member) ? message.member : null;
    const authorNick = str(member?.nick) ?? (guildId && author ? GuildMemberStore.getNick(guildId, String(author.id)) : null);
    const content = truncate(typeof message.content === "string" ? message.content : "", MAX_MESSAGE_TEXT);
    const mentions = Array.isArray(message.mentions) ? message.mentions.filter(isRaw) : [];
    const reactions = Array.isArray(message.reactions) ? message.reactions.filter(isRaw) : [];
    const reference = pick(message, "message_reference", "messageReference");
    const ref = isRaw(reference) ? reference : null;
    const referenced = isRaw(message.referenced_message) ? message.referenced_message : null;
    const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots.filter(isRaw) : [];
    const thread = isRaw(message.thread) ? message.thread : null;
    const stickers = pick(message, "sticker_items", "stickerItems");
    const mentionRoles = pick(message, "mention_roles", "mentionRoles");

    return {
        id: String(message.id),
        channelId,
        guildId,
        author: serializeUser(author),
        authorNick,
        content: content.text,
        contentTruncated: content.truncated,
        timestamp: isoTime(message.timestamp),
        editedTimestamp: isoTime(pick(message, "edited_timestamp", "editedTimestamp")),
        type: Number(message.type ?? 0),
        flags,
        isVoiceMessage: Boolean(flags & MESSAGE_FLAGS.IS_VOICE_MESSAGE),
        silent: Boolean(flags & MESSAGE_FLAGS.SUPPRESS_NOTIFICATIONS),
        pinned: Boolean(message.pinned),
        tts: Boolean(message.tts),
        webhookId: message.webhook_id ? String(message.webhook_id) : null,
        applicationId: message.application_id ? String(message.application_id) : null,
        mentionEveryone: Boolean(pick(message, "mention_everyone", "mentionEveryone")),
        mentions: mentions.slice(0, 25).map(serializeUser),
        mentionRoleIds: Array.isArray(mentionRoles) ? mentionRoles.slice(0, 25).map(String) : [],
        attachments: Array.isArray(message.attachments) ? message.attachments.filter(isRaw).slice(0, 20).map(serializeAttachment) : [],
        embeds: Array.isArray(message.embeds) ? message.embeds.filter(isRaw).slice(0, 10).map(serializeEmbed) : [],
        reactions: reactions.slice(0, 20).map(serializeReaction),
        stickers: Array.isArray(stickers) ? stickers.filter(isRaw).slice(0, 3).map(sticker => ({ id: String(sticker.id), name: str(sticker.name), formatType: num(sticker.format_type) })) : [],
        components: serializeComponents(message.components),
        poll: isRaw(message.poll) ? serializePoll(message.poll) : null,
        replyToMessageId: ref?.message_id ? String(ref.message_id) : null,
        reference: ref ? {
            type: num(ref.type) ?? 0,
            messageId: ref.message_id ? String(ref.message_id) : null,
            channelId: ref.channel_id ? String(ref.channel_id) : null,
            guildId: ref.guild_id ? String(ref.guild_id) : null,
        } : null,
        referencedMessage: referenced ? briefMessage(referenced) : null,
        forwarded: snapshots.slice(0, 5).flatMap(snapshot => {
            const inner = isRaw(snapshot.message) ? snapshot.message : null;
            return inner ? [{
                content: truncate(typeof inner.content === "string" ? inner.content : "", 1_000).text,
                timestamp: isoTime(inner.timestamp),
                attachments: Array.isArray(inner.attachments) ? inner.attachments.filter(isRaw).slice(0, 10).map(serializeAttachment) : [],
                embedCount: Array.isArray(inner.embeds) ? inner.embeds.length : 0,
            }] : [];
        }),
        thread: thread ? { id: String(thread.id), name: str(thread.name), messageCount: num(thread.message_count) } : null,
    };
}

export function serializeActivity(value: object) {
    const activity = value as Raw;
    const timestamps = isRaw(activity.timestamps) ? activity.timestamps : {};
    const emoji = isRaw(activity.emoji) ? activity.emoji : null;
    return {
        type: num(activity.type),
        name: str(activity.name),
        state: textOf(activity.state, 200),
        details: textOf(activity.details, 200),
        emoji: emoji ? str(emoji.name) : null,
        applicationId: activity.application_id ? String(activity.application_id) : null,
        startedAt: num(timestamps.start),
        endsAt: num(timestamps.end),
    };
}

export function presenceOf(userId: string, guildId?: string) {
    return {
        status: PresenceStore.getStatus(userId, guildId ?? null) ?? "offline",
        clientStatus: PresenceStore.getClientStatus(userId) ?? {},
        activities: PresenceStore.getActivities(userId, guildId).slice(0, 10).map(serializeActivity),
    };
}
