/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openPrivateChannel, sendMessage as sendDiscordMessage } from "@utils/discord";
import { sleep } from "@utils/misc";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    CloudUploader,
    GuildRoleStore,
    PermissionsBits,
    PermissionStore,
    RelationshipStore,
    SnowflakeUtils,
} from "@webpack/common";

import {
    type Args,
    currentUserId,
    fetchMessage,
    requireChannel,
    requireGuild,
    type ToolEnv,
} from "./context";
import {
    normalizeAllowedMentions,
    normalizeAttachments,
    normalizeBoundedInteger,
    normalizeEmoji,
    normalizeMessageContent,
    normalizeSnowflakeList,
    optionalBoolean,
    optionalText,
    parseInviteCode,
    parseUploadDirectories,
    requireGate,
    requireOneOf,
    requireSnowflake,
    requireText,
} from "./policy";
import { api, bodyRecord, failureStatus, routes } from "./rest";
import { FORUM_REQUIRE_TAG_FLAG, isRaw, MESSAGE_FLAGS, relationshipName, serializeChannelDetails, serializeMessage } from "./serialize";

const THREAD_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;
const CHANNEL_KINDS = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 } as const;
const DM_POLL_ATTEMPTS = 20;

function requireSend(channel: Awaited<ReturnType<typeof requireChannel>>) {
    if (channel.record && channel.guildId && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel.record))
        throw new Error("The authenticated account cannot send messages in this channel");
}

async function requireOwnMessage(channelId: string, messageId: string, action: string) {
    const message = await fetchMessage(channelId, messageId);
    if (!isRaw(message.author) || String(message.author.id) !== currentUserId())
        throw new Error(`Refusing to ${action} a message not authored by the authenticated account`);
    return message;
}

function requireOtherUser(value: unknown, action: string): string {
    const userId = requireSnowflake(value, "user_id");
    if (userId === currentUserId()) throw new Error(`You cannot ${action} yourself`);
    return userId;
}

async function withLegacy(modern: () => Promise<unknown>, legacy: () => Promise<unknown>) {
    await modern().catch(error => {
        if (failureStatus(error) !== 404 && failureStatus(error) !== 405) throw error;
        return legacy();
    });
}

async function loadUploads(args: ReturnType<typeof normalizeAttachments>, channelId: string, env: ToolEnv) {
    const directories = parseUploadDirectories(env.settings.uploadDirectories);
    const uploads: InstanceType<typeof CloudUploader>[] = [];
    for (const request of args) {
        env.check();
        const { name, data } = await env.native.readUploadFile(request.path, directories);
        const upload = new CloudUploader({ file: new File([new Uint8Array(data)], request.filename ?? name), platform: CloudUploadPlatform.WEB }, channelId);
        if (request.description) upload.description = request.description;
        uploads.push(upload);
    }
    return uploads;
}

export async function sendMessage(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const content = args.content === undefined ? undefined : normalizeMessageContent(args.content);
    const attachments = normalizeAttachments(args.attachments);
    const stickerIds = normalizeSnowflakeList(args.sticker_ids, "sticker_ids", 3);
    if (!content && attachments.length === 0 && stickerIds.length === 0)
        throw new Error("content, attachments or sticker_ids is required");
    const silent = optionalBoolean(args.silent, "silent") ?? false;
    if (silent && attachments.length) throw new Error("silent is not supported when sending attachments");
    const allowedMentions = normalizeAllowedMentions(args.allowed_mentions);
    const replyTo = args.reply_to_message_id === undefined ? undefined : requireSnowflake(args.reply_to_message_id, "reply_to_message_id");
    requireSend(channel);
    if (replyTo) await fetchMessage(channel.id, replyTo);
    env.check();

    const messageReference = replyTo ? { channel_id: channel.id, guild_id: channel.guildId ?? undefined, message_id: replyTo } : undefined;
    env.spend(channel.id);

    if (attachments.length) {
        const uploads = await loadUploads(attachments, channel.id, env);
        const result: unknown = await sendDiscordMessage(channel.id, { content: content ?? "" }, true, {
            attachmentsToUpload: uploads,
            allowedMentions,
            stickerIds,
            ...(messageReference ? { messageReference: { ...messageReference, guild_id: channel.guildId ?? "" } } : {}),
        });
        const sent = isRaw(result) && isRaw(result.body) ? result.body : null;
        if (!sent?.id) return { queued: true, channelId: channel.id, attachmentCount: uploads.length };
        await env.native.recordSentMessage(channel.id, String(sent.id));
        return serializeMessage(sent);
    }

    const response = await api("post", {
        url: routes.messages(channel.id),
        body: {
            channel_id: channel.id,
            content: content ?? "",
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: stickerIds,
            type: 0,
            attachments: [],
            allowed_mentions: allowedMentions,
            ...(silent ? { flags: MESSAGE_FLAGS.SUPPRESS_NOTIFICATIONS } : {}),
            ...(messageReference ? { message_reference: messageReference } : {}),
        },
    }, env.check);
    const message = bodyRecord(response, "sent message");
    if (!message.id || String(message.channel_id) !== channel.id) throw new Error("Discord did not return the sent message");
    await env.native.recordSentMessage(channel.id, String(message.id));
    return serializeMessage(message);
}

export async function editMessage(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const content = normalizeMessageContent(args.content);
    const allowedMentions = normalizeAllowedMentions(args.allowed_mentions);
    await requireOwnMessage(channel.id, messageId, "edit");
    env.check();
    env.spend(channel.id);
    const response = await api("patch", { url: routes.message(channel.id, messageId), body: { content, allowed_mentions: allowedMentions } }, env.check);
    return serializeMessage(bodyRecord(response, "edited message"));
}

async function removeMessage(channelId: string, messageId: string, env: ToolEnv) {
    env.check();
    env.spend(channelId);
    await api("del", { url: routes.message(channelId, messageId) }, env.check);
    await env.native.forgetSentMessage(channelId, messageId);
    return { deleted: true, channelId, messageId };
}

export async function deleteOwnMessage(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const sentByBridge = await env.native.isSentMessage(channel.id, messageId);
    await requireOwnMessage(channel.id, messageId, "delete");
    return { ...await removeMessage(channel.id, messageId, env), sentByBridge };
}

export async function deleteMessage(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const message = await fetchMessage(channel.id, messageId);
    const own = isRaw(message.author) && String(message.author.id) === currentUserId();
    if (!own) requireGate(env.settings, "moderation", "Deleting other people's messages");
    return { ...await removeMessage(channel.id, messageId, env), own };
}

export async function addReaction(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const emoji = normalizeEmoji(args.emoji);
    env.check();
    env.spend(channel.id);
    await api("put", { url: `${routes.reactions(channel.id, messageId, emoji)}/@me?location=Message%20Reaction%20Picker&type=0` }, env.check);
    return { added: true, channelId: channel.id, messageId, emoji: args.emoji };
}

export async function removeReaction(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const emoji = normalizeEmoji(args.emoji);
    const userId = args.user_id === undefined ? undefined : requireSnowflake(args.user_id, "user_id");
    const target = userId && userId !== currentUserId() ? userId : "@me";
    if (target !== "@me") requireGate(env.settings, "moderation", "Removing other people's reactions");
    env.check();
    env.spend(channel.id);
    await api("del", { url: `${routes.reactions(channel.id, messageId, emoji)}/${target}` }, env.check);
    return { removed: true, channelId: channel.id, messageId, emoji: args.emoji, userId: target === "@me" ? currentUserId() : target };
}

export async function setPinned(pinned: boolean, args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    env.check();
    env.spend(channel.id);
    const method = pinned ? "put" : "del";
    await withLegacy(
        () => api(method, { url: routes.pin(channel.id, messageId) }, env.check),
        () => api(method, { url: routes.legacyPin(channel.id, messageId) }, env.check)
    );
    return { pinned, channelId: channel.id, messageId };
}

function archiveDuration(value: unknown): number {
    const minutes = normalizeBoundedInteger(value, "auto_archive_duration", 1440, 60, 10080);
    if (!(THREAD_ARCHIVE_MINUTES as readonly number[]).includes(minutes)) throw new Error("auto_archive_duration must be 60, 1440, 4320 or 10080");
    return minutes;
}

export async function createThread(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const name = requireText(args.name, "name", 100);
    const duration = archiveDuration(args.auto_archive_duration);
    const messageId = args.message_id === undefined ? undefined : requireSnowflake(args.message_id, "message_id");
    const kind = requireOneOf(args.thread_type, "thread_type", ["public", "private"] as const, "public");
    env.check();
    env.spend(channel.id);
    const response = messageId
        ? await api("post", { url: routes.startThread(channel.id, messageId), body: { name, auto_archive_duration: duration } }, env.check)
        : await api("post", { url: routes.channelThreads(channel.id), body: { name, auto_archive_duration: duration, type: kind === "public" ? 11 : 12, invitable: optionalBoolean(args.invitable, "invitable") ?? true } }, env.check);
    return serializeChannelDetails(bodyRecord(response, "thread"));
}

export async function createForumPost(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    if (channel.type !== 15 && channel.type !== 16) throw new Error("channel_id must be a forum or media channel");
    const name = requireText(args.name, "name", 100);
    const content = normalizeMessageContent(args.content);
    const tags = normalizeSnowflakeList(args.tag_ids, "tag_ids", 5);
    const requiresTag = Boolean(Number((channel.object as Record<string, unknown>).flags ?? 0) & FORUM_REQUIRE_TAG_FLAG);
    if (requiresTag && tags.length === 0) throw new Error("This forum requires at least one tag. Use discord_get_forum_tags to list them.");
    env.check();
    env.spend(channel.id);
    const response = await api("post", {
        url: routes.channelThreads(channel.id),
        body: {
            name,
            auto_archive_duration: archiveDuration(args.auto_archive_duration),
            applied_tags: tags,
            message: { content, allowed_mentions: normalizeAllowedMentions(args.allowed_mentions) },
        },
    }, env.check);
    const thread = bodyRecord(response, "forum post");
    return { thread: serializeChannelDetails(thread), firstMessage: isRaw(thread.message) ? serializeMessage(thread.message) : null };
}

export async function sendTyping(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    requireSend(channel);
    env.check();
    env.spend(channel.id);
    await api("post", { url: routes.typing(channel.id) }, env.check);
    return { typing: true, channelId: channel.id };
}

export async function markRead(args: Args, env: ToolEnv) {
    const channel = await requireChannel(args.channel_id);
    const explicit = args.message_id === undefined ? undefined : requireSnowflake(args.message_id, "message_id");
    const latest = explicit ?? ChannelStore.getChannel(channel.id)?.lastMessageId;
    if (!latest) throw new Error("This channel has no messages to mark as read");
    env.check();
    env.spend(channel.id);
    await api("post", { url: routes.ack(channel.id, latest), body: { token: null, manual: true, mention_count: 0 } }, env.check);
    return { channelId: channel.id, ackMessageId: latest };
}

export async function forwardMessage(args: Args, env: ToolEnv) {
    const source = await requireChannel(args.channel_id);
    const messageId = requireSnowflake(args.message_id, "message_id");
    const destination = await requireChannel(args.destination_channel_id, "destination_channel_id");
    await fetchMessage(source.id, messageId);
    requireSend(destination);
    env.check();
    env.spend(destination.id);
    const response = await api("post", {
        url: routes.messages(destination.id),
        body: {
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            allowed_mentions: { parse: [], replied_user: false },
            message_reference: { type: 1, message_id: messageId, channel_id: source.id, ...(source.guildId ? { guild_id: source.guildId } : {}) },
        },
    }, env.check);
    const sent = bodyRecord(response, "forwarded message");
    if (sent.id) await env.native.recordSentMessage(destination.id, String(sent.id));
    return serializeMessage(sent);
}

export async function openDm(args: Args, env: ToolEnv) {
    const userId = requireOtherUser(args.user_id, "open a DM with");
    const existing = ChannelStore.getDMFromUserId(userId);
    if (existing) return { channelId: existing, created: false, userId };
    env.check();
    env.spend();
    await openPrivateChannel(userId, false);
    for (let attempt = 0; attempt < DM_POLL_ATTEMPTS; attempt++) {
        const channelId = ChannelStore.getDMFromUserId(userId);
        if (channelId) return { channelId, created: true, userId };
        await sleep(150);
        env.check();
    }
    throw new Error("Discord did not open the DM in time");
}

const RELATIONSHIP_STATES = {
    friend: ["friend"],
    removable: ["friend", "pending_incoming", "pending_outgoing"],
} as const;

function requireRelationship(userId: string, allowed: readonly string[], message: string) {
    const current = relationshipName(userId);
    if (!allowed.includes(current)) throw new Error(`${message} (current relationship: ${current})`);
}

export async function sendFriendRequest(args: Args, env: ToolEnv) {
    requireGate(env.settings, "relationships", "Friend requests");
    env.check();
    if (args.user_id !== undefined) {
        const userId = requireOtherUser(args.user_id, "befriend");
        requireRelationship(userId, ["none", "implicit"], "A friend request cannot be sent");
        env.spend();
        await api("put", { url: routes.relationship(userId), body: {} }, env.check);
        return { requested: true, userId };
    }
    const username = requireText(args.username, "username", 40, 2);
    env.spend();
    await api("post", { url: routes.relationships(), body: { username, discriminator: null } }, env.check);
    return { requested: true, username };
}

export async function acceptFriendRequest(args: Args, env: ToolEnv) {
    requireGate(env.settings, "relationships", "Accepting friend requests");
    const userId = requireSnowflake(args.user_id, "user_id");
    requireRelationship(userId, ["pending_incoming"], "There is no incoming friend request from this user");
    env.check();
    env.spend();
    await api("put", { url: routes.relationship(userId), body: { type: 1 } }, env.check);
    return { accepted: true, userId };
}

export async function removeFriend(args: Args, env: ToolEnv) {
    requireGate(env.settings, "relationships", "Removing friends or declining requests");
    const userId = requireSnowflake(args.user_id, "user_id");
    requireRelationship(userId, RELATIONSHIP_STATES.removable, "There is no friend or friend request to remove");
    env.check();
    env.spend();
    await api("del", { url: routes.relationship(userId) }, env.check);
    return { removed: true, userId, previousRelationship: relationshipName(userId) };
}

export async function blockUser(args: Args, env: ToolEnv) {
    requireGate(env.settings, "relationships", "Blocking users");
    const userId = requireOtherUser(args.user_id, "block");
    if (RelationshipStore.isBlocked(userId)) throw new Error("This user is already blocked");
    env.check();
    env.spend();
    await api("put", { url: routes.relationship(userId), body: { type: 2 } }, env.check);
    return { blocked: true, userId };
}

export async function unblockUser(args: Args, env: ToolEnv) {
    requireGate(env.settings, "relationships", "Unblocking users");
    const userId = requireSnowflake(args.user_id, "user_id");
    requireRelationship(userId, ["blocked"], "This user is not blocked");
    env.check();
    env.spend();
    await api("del", { url: routes.relationship(userId) }, env.check);
    return { unblocked: true, userId };
}

export async function joinServer(args: Args, env: ToolEnv) {
    requireGate(env.settings, "membership", "Joining servers");
    const code = parseInviteCode(args.invite);
    env.check();
    env.spend();
    const body = bodyRecord(await api("post", { url: routes.invite(code), body: {} }, env.check), "invite response");
    const guild = isRaw(body.guild) ? body.guild : null;
    return { joined: true, guild: guild ? { id: String(guild.id), name: typeof guild.name === "string" ? guild.name : null } : null };
}

export async function leaveServer(args: Args, env: ToolEnv) {
    requireGate(env.settings, "membership", "Leaving servers");
    const guild = requireGuild(args.guild_id);
    if (guild.ownerId === currentUserId()) throw new Error("You own this server, so you cannot leave it. Transfer ownership first.");
    env.check();
    env.spend();
    await api("del", { url: routes.leaveGuild(guild.id), body: { lurking: false } }, env.check);
    return { left: true, guildId: guild.id, guildName: guild.name };
}

export async function setNickname(args: Args, env: ToolEnv) {
    requireGate(env.settings, "membership", "Changing nicknames");
    const guild = requireGuild(args.guild_id);
    const nickname = args.nickname === null || args.nickname === undefined ? null : requireText(args.nickname, "nickname", 32, 0) || null;
    const userId = args.user_id === undefined ? currentUserId() : requireSnowflake(args.user_id, "user_id");
    env.check();
    env.spend();
    await api("patch", { url: routes.member(guild.id, userId === currentUserId() ? "@me" : userId), body: { nick: nickname } }, env.check);
    return { guildId: guild.id, userId, nickname };
}

export async function setStatus(args: Args, env: ToolEnv) {
    requireGate(env.settings, "account", "Changing your status");
    const status = requireOneOf(args.status, "status", ["online", "idle", "dnd", "invisible"] as const);
    env.check();
    env.spend();
    await api("patch", { url: routes.settings(), body: { status } }, env.check);
    return { status };
}

export async function setCustomStatus(args: Args, env: ToolEnv) {
    requireGate(env.settings, "account", "Changing your custom status");
    const clear = optionalBoolean(args.clear, "clear") ?? false;
    const text = optionalText(args.text, "text", 128);
    const emoji = optionalText(args.emoji, "emoji", 32);
    const minutes = args.expires_in_minutes === undefined ? undefined : normalizeBoundedInteger(args.expires_in_minutes, "expires_in_minutes", 60, 1, 10_080);
    if (!clear && !text && !emoji) throw new Error("Provide text or emoji, or set clear to true");
    env.check();
    env.spend();
    const customStatus = clear ? null : {
        text: text || null,
        emoji_name: emoji || null,
        expires_at: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
    };
    await api("patch", { url: routes.settings(), body: { custom_status: customStatus } }, env.check);
    return { customStatus };
}

async function moderate(env: ToolEnv, action: string, run: () => Promise<unknown>) {
    requireGate(env.settings, "moderation", action);
    env.check();
    env.spend();
    await run();
}

export async function kickMember(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const userId = requireOtherUser(args.user_id, "kick");
    await moderate(env, "Kicking members", () => api("del", { url: routes.member(guild.id, userId) }, env.check));
    return { kicked: true, guildId: guild.id, userId };
}

export async function banMember(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const userId = requireOtherUser(args.user_id, "ban");
    const seconds = normalizeBoundedInteger(args.delete_message_seconds, "delete_message_seconds", 0, 0, 604_800);
    await moderate(env, "Banning members", () => api("put", { url: routes.ban(guild.id, userId), body: { delete_message_seconds: seconds } }, env.check));
    return { banned: true, guildId: guild.id, userId, deletedMessageSeconds: seconds };
}

export async function unbanMember(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const userId = requireSnowflake(args.user_id, "user_id");
    await moderate(env, "Unbanning members", () => api("del", { url: routes.ban(guild.id, userId) }, env.check));
    return { unbanned: true, guildId: guild.id, userId };
}

export async function timeoutMember(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const userId = requireOtherUser(args.user_id, "time out");
    const seconds = normalizeBoundedInteger(args.duration_seconds, "duration_seconds", 0, 0, 2_419_200);
    const until = seconds > 0 ? new Date(Date.now() + seconds * 1_000).toISOString() : null;
    await moderate(env, "Timing out members", () => api("patch", { url: routes.member(guild.id, userId), body: { communication_disabled_until: until } }, env.check));
    return { guildId: guild.id, userId, timedOutUntil: until };
}

export async function changeRole(add: boolean, args: Args, env: ToolEnv) {
    requireGate(env.settings, "roles", "Changing member roles");
    const guild = requireGuild(args.guild_id);
    const userId = requireSnowflake(args.user_id, "user_id");
    const roleId = requireSnowflake(args.role_id, "role_id");
    if (roleId === guild.id) throw new Error("The @everyone role cannot be added or removed");
    if (!GuildRoleStore.getRole(guild.id, roleId)) throw new Error("Role was not found in that server");
    env.check();
    env.spend();
    await api(add ? "put" : "del", { url: routes.memberRole(guild.id, userId, roleId) }, env.check);
    return { guildId: guild.id, userId, roleId, action: add ? "added" : "removed" };
}

export async function createChannel(args: Args, env: ToolEnv) {
    requireGate(env.settings, "channels", "Creating channels");
    const guild = requireGuild(args.guild_id);
    const kind = requireOneOf(args.channel_type, "channel_type", Object.keys(CHANNEL_KINDS) as Array<keyof typeof CHANNEL_KINDS>, "text");
    const name = requireText(args.name, "name", 100);
    const topic = optionalText(args.topic, "topic", 1_024);
    const parentId = args.parent_id === undefined ? undefined : requireSnowflake(args.parent_id, "parent_id");
    env.check();
    env.spend();
    const response = await api("post", {
        url: routes.guildChannels(guild.id),
        body: { name, type: CHANNEL_KINDS[kind], ...(topic ? { topic } : {}), ...(parentId ? { parent_id: parentId } : {}) },
    }, env.check);
    return serializeChannelDetails(bodyRecord(response, "channel"));
}

export async function editChannel(args: Args, env: ToolEnv) {
    requireGate(env.settings, "channels", "Editing channels");
    const channel = await requireChannel(args.channel_id);
    if (!channel.guildId) throw new Error("Only server channels can be edited");
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = requireText(args.name, "name", 100);
    if (args.topic !== undefined) body.topic = optionalText(args.topic, "topic", 1_024);
    if (args.nsfw !== undefined) body.nsfw = optionalBoolean(args.nsfw, "nsfw");
    if (args.rate_limit_per_user !== undefined) body.rate_limit_per_user = normalizeBoundedInteger(args.rate_limit_per_user, "rate_limit_per_user", 0, 0, 21_600);
    if (args.parent_id !== undefined) body.parent_id = args.parent_id === null ? null : requireSnowflake(args.parent_id, "parent_id");
    if (Object.keys(body).length === 0) throw new Error("Provide at least one field to change");
    env.check();
    env.spend(channel.id);
    return serializeChannelDetails(bodyRecord(await api("patch", { url: routes.channel(channel.id), body }, env.check), "channel"));
}

export async function deleteChannel(args: Args, env: ToolEnv) {
    requireGate(env.settings, "channels", "Deleting channels");
    const channel = await requireChannel(args.channel_id);
    if (!channel.guildId) throw new Error("Only server channels can be deleted");
    env.check();
    env.spend(channel.id);
    await api("del", { url: routes.channel(channel.id) }, env.check);
    return { deleted: true, channelId: channel.id, name: channel.name };
}
