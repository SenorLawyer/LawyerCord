/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import { AuthenticationStore, ChannelStore, Constants, SnowflakeUtils } from "@webpack/common";

import * as actions from "./actions";
import { type Args, requireChannel, requireGuild, type ToolEnv } from "./context";
import * as messages from "./messages";
import {
    createWriteLimiter,
    type DiscordMcpToolName,
    type McpSettings,
    normalizeBoundedInteger,
    requireGate,
    requireSnowflake,
    resolveLocationArgs,
} from "./policy";
import * as readers from "./readers";
import { api } from "./rest";
import { isRaw } from "./serialize";
import * as subscriptions from "./subscriptions";

interface ToolContext {
    check(): void;
    settings: McpSettings;
    native: PluginNative<typeof import("./native")>;
}

type Handler = (args: Args, env: ToolEnv) => unknown;

const limiter = createWriteLimiter();

function requireSubscriptionId(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value))
        throw new Error("subscription_id must be a valid subscription ID");
    return value;
}

async function subscribeChannel(args: Args) {
    const channel = await requireChannel(args.channel_id);
    return subscriptions.addSubscription("channel", channel.id, subscriptions.normalizeEvents(args.events), ChannelStore.getChannel(channel.id)?.lastMessageId ?? null);
}

const HANDLERS: Record<DiscordMcpToolName, Handler> = {
    search_commands: async (args, env) => {
        const channel = await requireChannel(args.channel_id);
        if (typeof args.query !== "string" || args.query.length > 100) throw new Error("query must be a string of at most 100 characters");
        const offset = normalizeBoundedInteger(args.offset, "offset", 0, 0, 100_000);
        if (!channel.guildId) {
            if (offset) throw new Error("offset is only available for server commands");
            return (await api("get", { url: Constants.Endpoints.APPLICATION_COMMANDS_SEARCH(channel.id), query: { type: 1, include_applications: true, query: args.query, limit: 25 } }, env.check)).body;
        }
        const { body } = await api("get", { url: Constants.Endpoints.APPLICATION_COMMAND_INDEX_GUILD(channel.guildId) }, env.check);
        if (!isRaw(body) || !Array.isArray(body.application_commands)) throw new Error("Discord returned an invalid command index");
        const query = args.query.toLowerCase();
        const matches = body.application_commands.filter(command => isRaw(command) && command.type === 1 && (
            typeof command.name === "string" && command.name.toLowerCase().includes(query) || command.id === query || command.application_id === query
        ));
        const page = matches.slice(offset, offset + 25);
        return { application_commands: page, count: page.length, hasMore: offset + page.length < matches.length, nextOffset: offset + page.length < matches.length ? offset + page.length : null };
    },
    run_command: async (args, env) => {
        const channel = await requireChannel(args.channel_id);
        const commandId = requireSnowflake(args.command_id, "command_id");
        const applicationId = requireSnowflake(args.application_id, "application_id");
        const version = requireSnowflake(args.version, "version");
        if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 32 || /\s/.test(args.name)) throw new Error("name must be a command name");
        if (args.options !== undefined && !Array.isArray(args.options)) throw new Error("options must be an array");
        env.spend(channel.id);
        const result = await api("post", {
            url: Constants.Endpoints.INTERACTIONS,
            body: {
                type: 2, application_id: applicationId, ...(channel.guildId ? { guild_id: channel.guildId } : {}),
                channel_id: channel.id, session_id: AuthenticationStore.getSessionId(), nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                data: { id: commandId, application_id: applicationId, version, name: args.name, type: 1, options: args.options ?? [], application_command: { id: commandId, application_id: applicationId, version }, attachments: [] },
            },
        }, env.check);
        return { status: result.status, commandId, channelId: channel.id };
    },
    api_request: async (args, env) => {
        requireGate(env.settings, "api", "Direct API requests");
        const { method, path, query, body } = args;
        if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE")
            throw new Error("method must be GET, POST, PUT, PATCH or DELETE");
        if (typeof path !== "string" || path.length > 1024 || !/^\/(?!\/)[A-Za-z0-9_@./~%-]+$/.test(path) || /(?:%2f|%5c|%2e|\.\.)/i.test(path))
            throw new Error("path must be a relative Discord API path without a query string");
        if (query !== undefined && !isRaw(query)) throw new Error("query must be an object");
        if (body !== undefined && !isRaw(body) && !Array.isArray(body)) throw new Error("body must be an object or array");
        if (method !== "GET") {
            const channel = /^\/channels\/(\d{17,20})(?:\/|$)/.exec(path)?.[1];
            env.spend(channel ?? (path === Constants.Endpoints.INTERACTIONS && isRaw(body) && typeof body.channel_id === "string" ? body.channel_id : undefined));
        }
        const verbs = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "del" } as const;
        return api(verbs[method], { url: path, query, body }, env.check);
    },
    connection_status: readers.connectionStatus,
    whoami: readers.whoami,
    list_servers: readers.listServers,
    get_server: readers.getServer,
    list_roles: readers.listRoles,
    get_role: readers.getRole,
    list_server_channels: readers.listServerChannels,
    get_channel: readers.getChannel,
    list_threads: readers.listThreads,
    get_forum_tags: readers.getForumTags,
    list_dms: readers.listDms,
    get_voice_occupants: readers.getVoiceOccupants,
    get_user: readers.getUser,
    get_user_profile: readers.getUserProfile,
    find_users: readers.findUsers,
    search_members: readers.searchMembers,
    get_member: readers.getMember,
    get_message_users: readers.getMessageUsers,
    list_relationships: readers.listRelationships,
    get_presence: readers.getPresence,
    read_messages: messages.readMessages,
    bulk_read_messages: messages.bulkReadMessages,
    search_messages: messages.searchMessages,
    get_message: messages.getMessage,
    get_pinned_messages: messages.getPinnedMessages,
    get_reactions: messages.getReactions,
    get_message_context: messages.getMessageContext,
    resolve_link: messages.resolveLink,
    list_mentions: messages.listMentions,
    list_unread: readers.listUnread,
    download_attachment: messages.downloadAttachment,
    open_dm: actions.openDm,
    send_message: actions.sendMessage,
    edit_message: actions.editMessage,
    delete_own_message: actions.deleteOwnMessage,
    delete_message: actions.deleteMessage,
    add_reaction: actions.addReaction,
    remove_reaction: actions.removeReaction,
    pin_message: (args, env) => actions.setPinned(true, args, env),
    unpin_message: (args, env) => actions.setPinned(false, args, env),
    create_thread: actions.createThread,
    create_forum_post: actions.createForumPost,
    send_typing: actions.sendTyping,
    mark_read: actions.markRead,
    forward_message: actions.forwardMessage,
    send_friend_request: actions.sendFriendRequest,
    accept_friend_request: actions.acceptFriendRequest,
    remove_friend: actions.removeFriend,
    block_user: actions.blockUser,
    unblock_user: actions.unblockUser,
    join_server: actions.joinServer,
    leave_server: actions.leaveServer,
    set_nickname: actions.setNickname,
    set_status: actions.setStatus,
    set_custom_status: actions.setCustomStatus,
    kick_member: actions.kickMember,
    ban_member: actions.banMember,
    unban_member: actions.unbanMember,
    timeout_member: actions.timeoutMember,
    add_role: (args, env) => actions.changeRole(true, args, env),
    remove_role: (args, env) => actions.changeRole(false, args, env),
    create_channel: actions.createChannel,
    edit_channel: actions.editChannel,
    delete_channel: actions.deleteChannel,
    subscribe_channel: subscribeChannel,
    subscribe_guild: args => subscriptions.addSubscription("guild", requireGuild(args.guild_id).id, subscriptions.normalizeEvents(args.events), null),
    subscribe_dms: args => subscriptions.addSubscription("dms", null, subscriptions.normalizeEvents(args.events), null),
    wait_for_message: args => subscriptions.waitForSubscription(
        requireSubscriptionId(args.subscription_id),
        normalizeBoundedInteger(args.timeout_seconds, "timeout_seconds", 60, 1, 300)
    ),
    list_subscriptions: subscriptions.listSubscriptions,
    unsubscribe_channel: args => subscriptions.removeSubscription(requireSubscriptionId(args.subscription_id)),
};

export async function executeTool(tool: DiscordMcpToolName, rawArguments: unknown, context: ToolContext): Promise<unknown> {
    if (rawArguments !== undefined && !isRaw(rawArguments)) throw new Error("arguments must be an object");
    const args = resolveLocationArgs(rawArguments ?? {});
    const { settings } = context;
    const env: ToolEnv = {
        ...context,
        spend: channelId => limiter.spend(channelId === undefined ? undefined : requireSnowflake(channelId, "channel_id"), {
            channelBurst: settings.channelBurstLimit,
            channelHourly: settings.channelHourlyLimit,
            globalBurst: settings.globalBurstLimit,
            globalHourly: settings.globalHourlyLimit,
        }),
    };
    return HANDLERS[tool](args, env);
}

export function resetBridgeState() {
    subscriptions.clearSubscriptions();
    messages.clearWaveformCache();
}

export const {
    handleMessageCreate,
    handleMessageUpdate,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleReactionAdd,
    handleReactionRemove,
} = subscriptions;
