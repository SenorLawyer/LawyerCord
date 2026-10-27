#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER_NAME = "discord-mcp";
const SERVER_VERSION = "0.2.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const INSTRUCTIONS_TIMEOUT_MS = 1_500;
const MAX_ARGUMENT_BYTES = 60 * 1024;

const SNOWFLAKE_PATTERN = "^\\d{17,20}$";
const REF_PATTERN = "^(?:\\d{17,20}|https?://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/(?:@me|\\d{17,20})/\\d{17,20}(?:/\\d{17,20})?/?(?:[?#].*)?)$";

const id = description => ({ type: "string", pattern: SNOWFLAKE_PATTERN, description });
const ref = description => ({ type: "string", pattern: REF_PATTERN, maxLength: 300, description: `${description} Accepts an ID or a discord.com/channels link.` });
const text = (description, max = 2000, min = 1) => ({ type: "string", minLength: min, maxLength: max, description });
const int = (description, minimum, maximum) => ({ type: "integer", minimum, maximum, description });
const bool = description => ({ type: "boolean", description });
const oneOf = (description, values) => ({ type: "string", enum: values, description });
const ids = (description, maxItems) => ({ type: "array", items: { type: "string", pattern: SNOWFLAKE_PATTERN }, maxItems, uniqueItems: true, description });

const channelId = ref("Channel, thread, forum post or DM ID.");
const messageId = ref("Message ID.");
const guildId = id("Server ID.");
const userId = id("User ID.");
const limit = (max, fallback) => int(`Most items to return. Default ${fallback}, at most ${max}.`, 1, max);
const messageAnchors = {
    before: ref("Return messages older than this message."),
    after: ref("Return messages newer than this message."),
    around: ref("Return messages centred on this message."),
};
const attachmentRequests = {
    type: "array",
    maxItems: 10,
    description: "Local files to upload. Files must be inside a folder allowed in the DiscordMCP settings, or be a previously downloaded attachment.",
    items: {
        type: "object",
        properties: {
            path: text("Full path of the file.", 1024),
            filename: text("Name to show in Discord.", 255),
            description: text("Alt text.", 1024, 0),
        },
        required: ["path"],
        additionalProperties: false,
    },
};
const allowedMentions = {
    type: "object",
    description: "Who this message may notify. Nothing is notified when omitted.",
    properties: {
        parse: { type: "array", items: { type: "string", enum: ["users", "roles", "everyone"] }, maxItems: 3 },
        users: ids("User IDs to notify.", 100),
        roles: ids("Role IDs to notify.", 100),
        replied_user: bool("Notify the author of the message being replied to."),
    },
    additionalProperties: false,
};
const subscriptionId = {
    type: "string",
    pattern: "^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$",
    description: "Subscription ID returned by a subscribe tool.",
};
const subscriptionEvents = {
    type: "array",
    items: { type: "string", enum: ["message_create", "message_update", "message_delete", "reaction_add", "reaction_remove"] },
    minItems: 1,
    maxItems: 5,
    uniqueItems: true,
    description: "Events to collect. Default is message_create only.",
};

const READ = { readOnlyHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REMOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const GATED = setting => ` Needs "${setting}" turned on in the DiscordMCP plugin settings (off by default).`;

function tool(name, description, properties = {}, { required = [], annotations = READ, anyOf } = {}) {
    return {
        name: `discord_${name}`,
        description,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), ...(anyOf ? { anyOf } : {}), additionalProperties: false },
        annotations,
    };
}

const searchFilters = {
    query: text("Text to find in message content.", 1024),
    author_id: userId,
    mentions_user_id: userId,
    has: { type: "array", items: { type: "string", enum: ["link", "embed", "file", "video", "image", "sound", "sticker", "snapshot", "poll"] }, minItems: 1, maxItems: 9, uniqueItems: true, description: "Content filters; Discord combines them." },
    pinned: bool("Only pinned or only unpinned messages."),
    author_type: oneOf("Only messages from users, bots or webhooks.", ["user", "bot", "webhook"]),
    link_hostname: text("Only messages linking to this host, such as youtube.com.", 255),
    attachment_extension: text("Only messages with an attachment of this type, such as png.", 20),
    attachment_filename: text("Only messages with an attachment whose name contains this.", 255),
    mention_everyone: bool("Only messages that mention everyone or here."),
    include_nsfw: bool("Include age-restricted channels in server searches."),
    before_message_id: ref("Only hits older than this message."),
    after_message_id: ref("Only hits newer than this message."),
    before_date: text("Only hits before this ISO 8601 date, such as 2026-01-31.", 40),
    after_date: text("Only hits after this ISO 8601 date, such as 2026-01-01.", 40),
    sort_by: oneOf("Order by time or relevance. Default timestamp.", ["timestamp", "relevance"]),
    sort_order: oneOf("Default desc.", ["desc", "asc"]),
    limit: limit(100, 50),
    offset: int("Search offset. Pass nextOffset from the previous result.", 0, 5000),
};

export const TOOLS = [
    tool("connection_status", "Check the bridge, the signed-in account, which gated action categories are on, and the write rate limits."),
    tool("whoami", "Get the signed-in account: profile, status, custom status and counts of servers, friends and DMs."),
    tool("list_servers", "List servers with member counts, icons and features.", { query: text("Only servers whose name contains this.", 100) }),
    tool("get_server", "Get one server: owner, member and boost counts, features, channel summary, roles and your own roles and permissions.", { guild_id: guildId }, { required: ["guild_id"] }),
    tool("list_roles", "List a server's roles from highest to lowest, with permission bits.", { guild_id: guildId }, { required: ["guild_id"] }),
    tool("get_role", "Get one role with permission names and some cached members who hold it.", { guild_id: guildId, role_id: id("Role ID.") }, { required: ["guild_id", "role_id"] }),
    tool("list_server_channels", "List the channels you can view in a server, grouped by category, with whether you can send in each.", { guild_id: guildId, include_threads: bool("Also list active threads.") }, { required: ["guild_id"] }),
    tool("get_channel", "Get any channel: text, voice, stage, forum, thread, DM or group DM. Includes tags, thread state, your permissions and unread counts.", { channel_id: channelId }, { required: ["channel_id"] }),
    tool("list_threads", "List active or archived threads and forum posts, newest activity first.", {
        channel_id: channelId,
        guild_id: guildId,
        archived: bool("List archived threads instead of active ones. Needs channel_id."),
        limit: limit(50, 25),
        offset: int("Skip this many threads.", 0, 5000),
    }, { anyOf: [{ required: ["channel_id"] }, { required: ["guild_id"] }] }),
    tool("get_forum_tags", "List a forum or media channel's tags and posting defaults.", { channel_id: channelId }, { required: ["channel_id"] }),
    tool("list_dms", "List DMs and group DMs with unread state. This does not read their messages.", { query: text("Only DMs whose name or recipients contain this.", 100), limit: limit(500, 100) }),
    tool("get_voice_occupants", "Show who is in a voice or stage channel, or in every voice channel of a server.", { channel_id: channelId, guild_id: guildId }, { anyOf: [{ required: ["channel_id"] }, { required: ["guild_id"] }] }),
    tool("get_user", "Get a user by ID with relationship, presence, shared servers and DM channel.", { user_id: userId }, { required: ["user_id"] }),
    tool("get_user_profile", "Get a user's profile: bio, pronouns, badges, connections, mutual servers and friends, and their server profile.", { user_id: userId, guild_id: id("Also load their profile in this server.") }, { required: ["user_id"] }),
    tool("find_users", "Find users by username, display name, nickname or friend nickname among friends, DMs and cached members.", { query: text("Name to look for.", 100), guild_id: id("Search this server's cached members, including nicknames."), limit: limit(50, 20) }, { required: ["query"] }),
    tool("search_members", "Search a server's members by name through Discord's member list.", { guild_id: guildId, query: text("Name to look for.", 100), limit: limit(100, 25) }, { required: ["guild_id", "query"] }),
    tool("get_member", "Get a server member: nickname, roles, join date, timeout and permissions, optionally in one channel.", { guild_id: guildId, user_id: userId, channel_id: ref("Compute permissions for this channel.") }, { required: ["guild_id", "user_id"] }),
    tool("get_message_users", "Get the author, mentioned users and roles, and reply target of a message, with server member details.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"] }),
    tool("list_relationships", "List friends, blocked users, pending requests or ignored users.", {
        type: oneOf("Default friends.", ["friends", "blocked", "pending_incoming", "pending_outgoing", "ignored"]),
        limit: limit(500, 100),
        offset: int("Skip this many entries.", 0, 100000),
    }),
    tool("get_presence", "Get a user's status, devices and activities.", { user_id: userId, guild_id: id("Read presence as seen in this server.") }, { required: ["user_id"] }),
    tool("read_messages", "Read messages from any visible channel, newest first. Page with before or after, or use around to see context.", { channel_id: channelId, limit: limit(100, 50), ...messageAnchors }, { required: ["channel_id"] }),
    tool("bulk_read_messages", "Read the latest messages from up to 10 channels at once. Total requested messages are capped at 500.", {
        channel_ids: { type: "array", items: channelId, minItems: 1, maxItems: 10, uniqueItems: true },
        limit_per_channel: limit(100, 50),
    }, { required: ["channel_ids"] }),
    tool("search_messages", "Search messages in a channel, DM or whole server with Discord's filters. Does not open the search UI or mark anything read.", {
        channel_id: channelId,
        guild_id: id("Search the whole server. May accompany channel_id when the channel belongs to it."),
        channel_ids: ids("Search only these channels of the server.", 10),
        ...searchFilters,
    }, { anyOf: [{ required: ["channel_id"] }, { required: ["guild_id"] }] }),
    tool("get_message", "Get one message. A voice message without a waveform gets one generated.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"] }),
    tool("get_pinned_messages", "List a channel's pinned messages, most recently pinned first.", { channel_id: channelId, limit: limit(50, 50), before_pinned_at: text("Continue from nextBeforePinnedAt.", 40) }, { required: ["channel_id"] }),
    tool("get_reactions", "Summarise a message's reactions, or list the users who reacted with one emoji.", {
        channel_id: channelId,
        message_id: messageId,
        emoji: text("Unicode emoji or custom emoji as name:id. Omit to summarise all reactions.", 64),
        limit: limit(100, 25),
        after: id("Continue after this user ID (nextAfter)."),
    }, { required: ["channel_id", "message_id"] }),
    tool("get_message_context", "Get a message with its reply target, thread starter, surrounding messages and direct replies.", {
        channel_id: channelId,
        message_id: messageId,
        radius: int("Messages to load on each side. Default 5.", 0, 25),
    }, { required: ["channel_id", "message_id"] }),
    tool("resolve_link", "Turn a discord.com/channels link into server, channel and message IDs.", { url: text("Message or channel link.", 300) }, { required: ["url"] }),
    tool("list_mentions", "List recent messages that mention you, like Discord's inbox Mentions tab.", {
        guild_id: id("Only this server."),
        limit: limit(100, 25),
        before: id("Continue before this message (nextBefore)."),
        include_roles: bool("Include role mentions. Default true."),
        include_everyone: bool("Include @everyone and @here. Default true."),
    }),
    tool("list_unread", "List channels with unread messages or mentions, most mentions first.", { guild_id: id("Only this server."), mentions_only: bool("Only channels where you were mentioned."), limit: limit(200, 50) }),
    tool("download_attachment", "Download one attachment to a private local folder. Capped at 25 MB; returns path, type, size and SHA-256. Images and audio are also returned inline.", {
        channel_id: channelId,
        message_id: messageId,
        attachment_id: id("Attachment ID from a message."),
    }, { required: ["channel_id", "message_id", "attachment_id"] }),
    tool("open_dm", "Open or find the DM channel with a user and return its ID.", { user_id: userId }, { required: ["user_id"], annotations: SET }),
    tool("send_message", "Send a message with optional reply, stickers and file attachments. Nobody is notified unless allowed_mentions says so.", {
        channel_id: channelId,
        content: text("Message text, up to 2000 characters. Optional when sending attachments or stickers.", 2000),
        reply_to_message_id: ref("Message in the same channel to reply to."),
        allowed_mentions: allowedMentions,
        silent: bool("Send without a notification sound."),
        sticker_ids: ids("Up to 3 sticker IDs.", 3),
        attachments: attachmentRequests,
    }, { required: ["channel_id"], annotations: ADD }),
    tool("edit_message", "Edit one of your own messages.", { channel_id: channelId, message_id: messageId, content: text("New text.", 2000), allowed_mentions: allowedMentions }, { required: ["channel_id", "message_id", "content"], annotations: REMOVE }),
    tool("delete_own_message", "Delete a message after checking that the signed-in account wrote it.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"], annotations: REMOVE }),
    tool("delete_message", `Delete any message you are allowed to delete. Your own messages need no setting; other people's messages need moderation actions.${GATED("Allow moderation actions")}`, { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"], annotations: REMOVE }),
    tool("add_reaction", "React to a message.", { channel_id: channelId, message_id: messageId, emoji: text("Unicode emoji or custom emoji as name:id.", 64) }, { required: ["channel_id", "message_id", "emoji"], annotations: SET }),
    tool("remove_reaction", "Remove your reaction. Removing someone else's needs moderation actions.", { channel_id: channelId, message_id: messageId, emoji: text("Unicode emoji or custom emoji as name:id.", 64), user_id: id("Remove this user's reaction instead of yours.") }, { required: ["channel_id", "message_id", "emoji"], annotations: REMOVE }),
    tool("pin_message", "Pin a message, when you have permission.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"], annotations: SET }),
    tool("unpin_message", "Unpin a message, when you have permission.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id", "message_id"], annotations: REMOVE }),
    tool("create_thread", "Start a thread from a message, or a standalone thread in a text channel.", {
        channel_id: channelId,
        name: text("Thread name.", 100),
        message_id: ref("Start the thread from this message."),
        auto_archive_duration: int("Minutes of inactivity before archiving: 60, 1440, 4320 or 10080.", 60, 10080),
        thread_type: oneOf("Standalone threads only. Default public.", ["public", "private"]),
        invitable: bool("Private threads only: let members invite others."),
    }, { required: ["channel_id", "name"], annotations: ADD }),
    tool("create_forum_post", "Create a post in a forum or media channel.", {
        channel_id: channelId,
        name: text("Post title.", 100),
        content: text("First message.", 2000),
        tag_ids: ids("Up to 5 tag IDs. Some forums require one.", 5),
        auto_archive_duration: int("Minutes of inactivity before archiving: 60, 1440, 4320 or 10080.", 60, 10080),
        allowed_mentions: allowedMentions,
    }, { required: ["channel_id", "name", "content"], annotations: ADD }),
    tool("send_typing", "Show the typing indicator in a channel for a few seconds.", { channel_id: channelId }, { required: ["channel_id"], annotations: SET }),
    tool("mark_read", "Mark a channel as read up to a message, or up to its latest message.", { channel_id: channelId, message_id: messageId }, { required: ["channel_id"], annotations: SET }),
    tool("forward_message", "Forward a message to another channel.", { channel_id: channelId, message_id: messageId, destination_channel_id: ref("Channel to forward into.") }, { required: ["channel_id", "message_id", "destination_channel_id"], annotations: ADD }),
    tool("send_friend_request", `Send a friend request by user ID or username.${GATED("Allow relationship actions")}`, { user_id: userId, username: text("Username to add.", 40, 2) }, { annotations: ADD, anyOf: [{ required: ["user_id"] }, { required: ["username"] }] }),
    tool("accept_friend_request", `Accept an incoming friend request.${GATED("Allow relationship actions")}`, { user_id: userId }, { required: ["user_id"], annotations: SET }),
    tool("remove_friend", `Remove a friend, decline an incoming request or cancel an outgoing one.${GATED("Allow relationship actions")}`, { user_id: userId }, { required: ["user_id"], annotations: REMOVE }),
    tool("block_user", `Block a user.${GATED("Allow relationship actions")}`, { user_id: userId }, { required: ["user_id"], annotations: SET }),
    tool("unblock_user", `Unblock a user.${GATED("Allow relationship actions")}`, { user_id: userId }, { required: ["user_id"], annotations: REMOVE }),
    tool("join_server", `Join a server with an invite code or link.${GATED("Allow membership actions")}`, { invite: text("Invite code or discord.gg link.", 200) }, { required: ["invite"], annotations: ADD }),
    tool("leave_server", `Leave a server.${GATED("Allow membership actions")}`, { guild_id: guildId }, { required: ["guild_id"], annotations: REMOVE }),
    tool("set_nickname", `Change your nickname in a server, or someone else's with permission. Use null to clear it.${GATED("Allow membership actions")}`, {
        guild_id: guildId,
        nickname: { type: ["string", "null"], maxLength: 32, description: "New nickname, or null to clear." },
        user_id: id("Change this member's nickname instead of yours."),
    }, { required: ["guild_id", "nickname"], annotations: REMOVE }),
    tool("set_status", `Set your online status.${GATED("Allow account actions")}`, { status: oneOf("New status.", ["online", "idle", "dnd", "invisible"]) }, { required: ["status"], annotations: SET }),
    tool("set_custom_status", `Set or clear your custom status.${GATED("Allow account actions")}`, {
        text: text("Status text.", 128),
        emoji: text("Unicode emoji.", 32),
        expires_in_minutes: int("Clear the status after this many minutes.", 1, 10080),
        clear: bool("Remove the custom status."),
    }, { annotations: SET }),
    tool("kick_member", `Kick a member from a server.${GATED("Allow moderation actions")}`, { guild_id: guildId, user_id: userId }, { required: ["guild_id", "user_id"], annotations: REMOVE }),
    tool("ban_member", `Ban a member from a server, optionally deleting recent messages.${GATED("Allow moderation actions")}`, { guild_id: guildId, user_id: userId, delete_message_seconds: int("Delete their messages from this many seconds back, up to 7 days.", 0, 604800) }, { required: ["guild_id", "user_id"], annotations: REMOVE }),
    tool("unban_member", `Lift a ban.${GATED("Allow moderation actions")}`, { guild_id: guildId, user_id: userId }, { required: ["guild_id", "user_id"], annotations: SET }),
    tool("timeout_member", `Time a member out, or end a timeout with 0 seconds.${GATED("Allow moderation actions")}`, { guild_id: guildId, user_id: userId, duration_seconds: int("Timeout length, at most 28 days. 0 ends it.", 0, 2419200) }, { required: ["guild_id", "user_id", "duration_seconds"], annotations: SET }),
    tool("add_role", `Give a member a role.${GATED("Allow role actions")}`, { guild_id: guildId, user_id: userId, role_id: id("Role ID.") }, { required: ["guild_id", "user_id", "role_id"], annotations: SET }),
    tool("remove_role", `Take a role from a member.${GATED("Allow role actions")}`, { guild_id: guildId, user_id: userId, role_id: id("Role ID.") }, { required: ["guild_id", "user_id", "role_id"], annotations: REMOVE }),
    tool("create_channel", `Create a channel or category in a server.${GATED("Allow channel management")}`, {
        guild_id: guildId,
        name: text("Channel name.", 100),
        channel_type: oneOf("Default text.", ["text", "voice", "category", "announcement", "stage", "forum"]),
        parent_id: id("Category to place it in."),
        topic: text("Channel topic.", 1024),
    }, { required: ["guild_id", "name"], annotations: ADD }),
    tool("edit_channel", `Change a server channel's name, topic, age restriction, slowmode or category.${GATED("Allow channel management")}`, {
        channel_id: channelId,
        name: text("New name.", 100),
        topic: text("New topic.", 1024, 0),
        nsfw: bool("Age-restrict the channel."),
        rate_limit_per_user: int("Slowmode in seconds.", 0, 21600),
        parent_id: { type: ["string", "null"], pattern: SNOWFLAKE_PATTERN, description: "Category ID, or null to remove it from its category." },
    }, { required: ["channel_id"], annotations: REMOVE }),
    tool("delete_channel", `Delete a server channel, thread or category.${GATED("Allow channel management")}`, { channel_id: channelId }, { required: ["channel_id"], annotations: REMOVE }),
    tool("subscribe_channel", "Quietly collect events from one channel. Existing messages are not returned.", { channel_id: channelId, events: subscriptionEvents }, { required: ["channel_id"], annotations: ADD }),
    tool("subscribe_guild", "Quietly collect events from every channel and thread in a server.", { guild_id: guildId, events: subscriptionEvents }, { required: ["guild_id"], annotations: ADD }),
    tool("subscribe_dms", "Quietly collect events from all DMs and group DMs.", { events: subscriptionEvents }, { annotations: ADD }),
    tool("wait_for_message", "Wait for the next event on a subscription. Returns the event, or a timeout. Does not poll Discord or change the view.", {
        subscription_id: subscriptionId,
        timeout_seconds: int("Default 60.", 1, 300),
    }, { required: ["subscription_id"] }),
    tool("list_subscriptions", "List active subscriptions with queued event counts and wait state."),
    tool("unsubscribe_channel", "Remove any subscription and cancel its wait.", { subscription_id: subscriptionId }, { required: ["subscription_id"], annotations: REMOVE }),
];

const toolMap = new Map(TOOLS.map(tool => [tool.name, tool]));

function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return Number.isInteger(value) ? "integer" : typeof value;
}

export function validateValue(value, schema, path) {
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    const actual = typeOf(value);
    if (types.length && !types.some(type => type === actual || (type === "number" && actual === "integer")))
        return `${path} must be ${types.join(" or ")}`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(", ")}`;
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must be at least ${schema.minLength} characters`;
        if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must be at most ${schema.maxLength} characters`;
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format; use a Discord ID${schema.pattern === REF_PATTERN ? " or a discord.com/channels link" : ""}`;
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
        if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
        if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
        if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return `${path} must not repeat items`;
        if (schema.items) for (const [index, item] of value.entries()) {
            const error = validateValue(item, schema.items, `${path}[${index}]`);
            if (error) return error;
        }
    }
    if (actual === "object" && schema.properties) {
        for (const key of schema.required ?? []) if (value[key] === undefined) return `${path === "arguments" ? key : `${path}.${key}`} is required`;
        for (const [key, entry] of Object.entries(value)) {
            const child = schema.properties[key];
            if (!child) {
                if (schema.additionalProperties === false) return `${path === "arguments" ? key : `${path}.${key}`} is not a supported argument`;
                continue;
            }
            const error = validateValue(entry, child, path === "arguments" ? key : `${path}.${key}`);
            if (error) return error;
        }
        if (schema.anyOf && !schema.anyOf.some(option => (option.required ?? []).every(key => value[key] !== undefined)))
            return `provide at least one of: ${schema.anyOf.map(option => (option.required ?? []).join(" + ")).join(", ")}`;
    }
    return null;
}

function candidateBridgeDirectories() {
    if (process.env.LAWYERCORD_DISCORD_MCP_DIR) return [process.env.LAWYERCORD_DISCORD_MCP_DIR];
    const candidates = [];
    const appData = process.env.APPDATA;
    if (appData) {
        candidates.push(join(appData, "LawyerCord", "discord-mcp"));
        candidates.push(join(appData, "LawyerCord", "dev", "discord-mcp"));
        candidates.push(join(appData, "LawyerCordData", "discord-mcp"));
    }
    candidates.push(join(homedir(), ".lawyercord", "discord-mcp"));
    return [...new Set(candidates.map(candidate => dirname(join(candidate, "config.json"))))];
}

async function loadBridgeConfig() {
    const attempted = [];
    for (const directory of candidateBridgeDirectories()) {
        const configPath = join(directory, "config.json");
        attempted.push(configPath);
        try {
            const config = JSON.parse(await readFile(configPath, "utf8"));
            if (config?.schemaVersion === 1 && typeof config.secret === "string" && config.secret.length >= 32)
                return { directory, secret: config.secret };
        } catch { }
    }
    throw new Error(`Discord MCP bridge is not ready. Enable DiscordMCP in LawyerCord and keep Discord running. Checked: ${attempted.join(", ")}`);
}

async function writeAtomic(path, body) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
}

export async function callBridge(tool, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const { directory, secret } = await loadBridgeConfig();
    const requestsDirectory = join(directory, "requests");
    const responsesDirectory = join(directory, "responses");
    await Promise.all([mkdir(requestsDirectory, { recursive: true }), mkdir(responsesDirectory, { recursive: true })]);

    const id = randomUUID();
    const requestPath = join(requestsDirectory, `${Date.now()}-${id}.json`);
    const responsePath = join(responsesDirectory, `${id}.json`);
    await writeAtomic(requestPath, JSON.stringify({ id, secret, tool, arguments: args, createdAt: Date.now() }));

    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline) {
            try {
                const response = JSON.parse(await readFile(responsePath, "utf8"));
                if (response?.id !== id) throw new Error("Discord MCP returned a mismatched response ID");
                if (!response.ok) throw new Error(response.error || "Discord MCP request failed");
                return response.result;
            } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
            await sleep(40);
        }
        throw new Error("Discord MCP request timed out; make sure Discord is running and the DiscordMCP plugin is enabled");
    } finally {
        await Promise.all([
            rm(requestPath, { force: true }),
            rm(responsePath, { force: true }),
        ]);
    }
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function toolContent(name, result) {
    const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
    if (name !== "discord_download_attachment") return content;

    const path = result?.download?.path;
    const reportedType = result?.download?.contentType;
    if (typeof path !== "string" || typeof reportedType !== "string") return content;

    const isVoiceMessage = typeof result?.attachment?.durationSeconds === "number" &&
        typeof result?.attachment?.waveform === "string";
    if (!reportedType.startsWith("image/") && !reportedType.startsWith("audio/") && !isVoiceMessage) {
        content.push({
            type: "resource_link",
            name: result?.attachment?.filename ?? "Discord attachment",
            uri: pathToFileURL(path).href,
            mimeType: reportedType,
            size: result?.download?.size,
        });
        return content;
    }

    const data = (await readFile(path)).toString("base64");
    if (reportedType.startsWith("image/")) {
        content.push({ type: "image", data, mimeType: reportedType });
    } else {
        const mimeType = isVoiceMessage && reportedType === "video/mp4" ? "audio/mp4" : reportedType;
        content.push({ type: "audio", data, mimeType });
    }
    return content;
}

function bridgeTimeoutForTool(name, args) {
    if (name !== "discord_wait_for_message") return DEFAULT_TIMEOUT_MS;
    const requestedSeconds = Number.isInteger(args?.timeout_seconds) ? args.timeout_seconds : 60;
    return Math.min(315_000, Math.max(11_000, requestedSeconds * 1_000 + 10_000));
}

export function describeInstructions(status) {
    const base = "This silent background server uses the signed-in Discord account's own access without navigating the active Discord view. Every ID argument also accepts a discord.com/channels link. " +
        "It can read servers, channels, threads, forum posts, DMs, members, profiles, presence, friends, pins, reactions, mentions and search, and it can send, edit and delete your own messages, react, pin, start threads, forward and mark channels read. " +
        "Messages never notify anyone unless allowed_mentions says so, and write actions are rate limited per channel and globally. Local files can only be uploaded from folders allowed in the plugin settings. " +
        "It cannot make arbitrary Discord requests.";
    const gates = status && typeof status === "object" && status.gates && typeof status.gates === "object" ? Object.values(status.gates) : null;
    if (!gates?.length) return `${base} Moderation, role, channel, membership, relationship and account actions are off by default; call discord_connection_status to see which are on.`;
    const on = gates.filter(gate => gate?.enabled).map(gate => gate.allows);
    const off = gates.filter(gate => !gate?.enabled).map(gate => gate.allows);
    return `${base} Enabled in the plugin settings: ${on.length ? on.join("; ") : "none of the gated actions"}.${off.length ? ` Turned off, and refused with an error naming the setting: ${off.join("; ")}.` : ""}`;
}

async function buildInstructions() {
    const status = await callBridge("connection_status", {}, INSTRUCTIONS_TIMEOUT_MS).catch(() => null);
    return describeInstructions(status);
}

async function handleRequest(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        rpcError(message?.id, -32600, "Invalid Request");
        return;
    }

    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;

    if (message.method === "initialize") {
        send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                instructions: await buildInstructions(),
            },
        });
        return;
    }

    if (message.method === "ping") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
    }

    if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        return;
    }

    if (message.method === "tools/call") {
        const name = message.params?.name;
        const tool = toolMap.get(name);
        if (!tool) {
            rpcError(message.id, -32602, `Unknown tool: ${String(name)}`);
            return;
        }
        try {
            const args = message.params?.arguments ?? {};
            if (JSON.stringify(args).length > MAX_ARGUMENT_BYTES) throw new Error("Arguments are too large");
            const problem = validateValue(args, tool.inputSchema, "arguments");
            if (problem) throw new Error(`Invalid arguments for ${name}: ${problem}`);
            const result = await callBridge(name.slice("discord_".length), args, bridgeTimeoutForTool(name, args));
            send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    content: await toolContent(name, result),
                    structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { value: result },
                },
            });
        } catch (error) {
            send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    isError: true,
                    content: [{ type: "text", text: error instanceof Error ? error.message : "Discord MCP tool failed" }],
                },
            });
        }
        return;
    }

    rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

export function startServer() {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", line => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); }
        catch {
            rpcError(null, -32700, "Parse error");
            return;
        }
        void handleRequest(message).catch(error => {
            rpcError(message?.id, -32603, error instanceof Error ? error.message : "Internal error");
        });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
