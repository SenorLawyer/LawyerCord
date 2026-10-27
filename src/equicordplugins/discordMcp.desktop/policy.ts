/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const GATES = {
    relationships: {
        setting: "allowRelationshipActions",
        label: "Allow relationship actions",
        what: "friend requests and blocking",
    },
    membership: {
        setting: "allowMembershipActions",
        label: "Allow membership actions",
        what: "joining servers, leaving servers and changing nicknames",
    },
    account: {
        setting: "allowAccountActions",
        label: "Allow account actions",
        what: "changing your status and custom status",
    },
    moderation: {
        setting: "allowModerationActions",
        label: "Allow moderation actions",
        what: "kicking, banning and timing out members and deleting other people's messages",
    },
    roles: {
        setting: "allowRoleActions",
        label: "Allow role actions",
        what: "adding and removing member roles",
    },
    channels: {
        setting: "allowChannelManagement",
        label: "Allow channel management",
        what: "creating, editing and deleting channels",
    },
} as const;

export type GateName = keyof typeof GATES;

interface ToolPolicy {
    write?: true;
    gate?: GateName;
}

export const TOOL_POLICY = {
    connection_status: {},
    whoami: {},
    list_servers: {},
    get_server: {},
    list_roles: {},
    get_role: {},
    list_server_channels: {},
    get_channel: {},
    list_threads: {},
    get_forum_tags: {},
    list_dms: {},
    get_voice_occupants: {},
    get_user: {},
    get_user_profile: {},
    find_users: {},
    search_members: {},
    get_member: {},
    get_message_users: {},
    list_relationships: {},
    get_presence: {},
    read_messages: {},
    bulk_read_messages: {},
    search_messages: {},
    get_message: {},
    get_pinned_messages: {},
    get_reactions: {},
    get_message_context: {},
    resolve_link: {},
    list_mentions: {},
    list_unread: {},
    download_attachment: {},
    open_dm: { write: true },
    send_message: { write: true },
    edit_message: { write: true },
    delete_own_message: { write: true },
    delete_message: { write: true },
    add_reaction: { write: true },
    remove_reaction: { write: true },
    pin_message: { write: true },
    unpin_message: { write: true },
    create_thread: { write: true },
    create_forum_post: { write: true },
    send_typing: { write: true },
    mark_read: { write: true },
    forward_message: { write: true },
    send_friend_request: { write: true, gate: "relationships" },
    accept_friend_request: { write: true, gate: "relationships" },
    remove_friend: { write: true, gate: "relationships" },
    block_user: { write: true, gate: "relationships" },
    unblock_user: { write: true, gate: "relationships" },
    join_server: { write: true, gate: "membership" },
    leave_server: { write: true, gate: "membership" },
    set_nickname: { write: true, gate: "membership" },
    set_status: { write: true, gate: "account" },
    set_custom_status: { write: true, gate: "account" },
    kick_member: { write: true, gate: "moderation" },
    ban_member: { write: true, gate: "moderation" },
    unban_member: { write: true, gate: "moderation" },
    timeout_member: { write: true, gate: "moderation" },
    add_role: { write: true, gate: "roles" },
    remove_role: { write: true, gate: "roles" },
    create_channel: { write: true, gate: "channels" },
    edit_channel: { write: true, gate: "channels" },
    delete_channel: { write: true, gate: "channels" },
    subscribe_channel: {},
    subscribe_guild: {},
    subscribe_dms: {},
    wait_for_message: {},
    list_subscriptions: {},
    unsubscribe_channel: {},
} as const satisfies Record<string, ToolPolicy>;

export type DiscordMcpToolName = keyof typeof TOOL_POLICY;

export const DISCORD_MCP_TOOL_NAMES = Object.keys(TOOL_POLICY) as DiscordMcpToolName[];

export function toolPolicy(tool: DiscordMcpToolName): ToolPolicy {
    return TOOL_POLICY[tool];
}

export interface McpSettings {
    allowRelationshipActions: boolean;
    allowMembershipActions: boolean;
    allowAccountActions: boolean;
    allowModerationActions: boolean;
    allowRoleActions: boolean;
    allowChannelManagement: boolean;
    channelBurstLimit: number;
    channelHourlyLimit: number;
    globalBurstLimit: number;
    globalHourlyLimit: number;
    uploadDirectories: string;
}

export function requireGate(settings: McpSettings, gate: GateName, action: string): void {
    const { setting, label, what } = GATES[gate];
    if (!settings[setting])
        throw new Error(`${action} is turned off. Turn on "${label}" in the DiscordMCP plugin settings to allow ${what}.`);
}

export interface WriteLimits {
    channelBurst: number;
    channelHourly: number;
    globalBurst: number;
    globalHourly: number;
}

export const BURST_WINDOW_MS = 10_000;
export const HOUR_WINDOW_MS = 3_600_000;
const GLOBAL_KEY = "global";

export function createWriteLimiter(now: () => number = Date.now) {
    const history = new Map<string, number[]>();

    function inspect(key: string, burst: number, hourly: number, label: string, time: number): void {
        const stamps = (history.get(key) ?? []).filter(stamp => stamp > time - HOUR_WINDOW_MS);
        if (stamps.length === 0) history.delete(key); else history.set(key, stamps);
        const burstLimit = Math.max(1, Math.floor(burst));
        const hourlyLimit = Math.max(1, Math.floor(hourly));
        const inBurst = stamps.filter(stamp => stamp > time - BURST_WINDOW_MS);
        if (inBurst.length >= burstLimit) {
            const wait = Math.ceil((inBurst[inBurst.length - burstLimit] + BURST_WINDOW_MS - time) / 1_000);
            throw new Error(`Write rate limit reached for ${label} (${burstLimit} per 10 seconds). Try again in ${Math.max(1, wait)} seconds, or raise the limit in the DiscordMCP plugin settings.`);
        }
        if (stamps.length >= hourlyLimit) {
            const wait = Math.ceil((stamps[stamps.length - hourlyLimit] + HOUR_WINDOW_MS - time) / 1_000);
            throw new Error(`Write rate limit reached for ${label} (${hourlyLimit} per hour). Try again in ${Math.max(1, wait)} seconds, or raise the limit in the DiscordMCP plugin settings.`);
        }
    }

    return {
        spend(channelId: string | undefined, limits: WriteLimits): void {
            const time = now();
            inspect(GLOBAL_KEY, limits.globalBurst, limits.globalHourly, "all channels", time);
            if (channelId) inspect(channelId, limits.channelBurst, limits.channelHourly, "this channel", time);
            for (const key of channelId ? [GLOBAL_KEY, channelId] : [GLOBAL_KEY]) {
                const stamps = history.get(key) ?? [];
                stamps.push(time);
                history.set(key, stamps);
            }
        },
        reset(): void {
            history.clear();
        },
    };
}

export const DISCORD_SEARCH_HAS_VALUES = [
    "link",
    "embed",
    "file",
    "video",
    "image",
    "sound",
    "sticker",
    "snapshot",
    "poll",
] as const;

export type DiscordSearchHas = typeof DISCORD_SEARCH_HAS_VALUES[number];

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const JUMP_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{17,20})\/(\d{17,20})(?:\/(\d{17,20}))?\/?(?:[?#].*)?$/i;
const MESSAGE_KEYS = ["message_id", "before", "after", "around", "reply_to_message_id", "before_message_id", "after_message_id"] as const;
const CHANNEL_KEYS = ["channel_id", "destination_channel_id"] as const;

export interface DiscordLink {
    guildId: string | null;
    channelId: string;
    messageId: string | null;
}

export function isDiscordSnowflake(value: unknown): value is string {
    return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}

export function requireSnowflake(value: unknown, fieldName: string): string {
    if (!isDiscordSnowflake(value)) throw new Error(`${fieldName} must be a Discord snowflake ID`);
    return value;
}

export function parseDiscordLink(value: unknown): DiscordLink | null {
    if (typeof value !== "string" || value.length > 300) return null;
    const match = JUMP_LINK.exec(value.trim());
    if (!match) return null;
    return { guildId: match[1] === "@me" ? null : match[1], channelId: match[2], messageId: match[3] ?? null };
}

export function resolveLocationArgs(args: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...args };
    const learn = (link: DiscordLink, key: string) => {
        if (resolved.guild_id === undefined && link.guildId) resolved.guild_id = link.guildId;
        if (key === "channel_id" || resolved.channel_id !== undefined) return;
        resolved.channel_id = link.channelId;
    };

    for (const key of CHANNEL_KEYS) {
        const link = parseDiscordLink(resolved[key]);
        if (!link) continue;
        resolved[key] = link.channelId;
        if (key === "channel_id") learn(link, key);
        if (key === "channel_id" && link.messageId && resolved.message_id === undefined) resolved.message_id = link.messageId;
    }
    if (Array.isArray(resolved.channel_ids))
        resolved.channel_ids = resolved.channel_ids.map(item => parseDiscordLink(item)?.channelId ?? item);

    for (const key of MESSAGE_KEYS) {
        const link = parseDiscordLink(resolved[key]);
        if (!link) continue;
        if (!link.messageId) throw new Error(`${key} must link to a message, not just a channel`);
        if (isDiscordSnowflake(resolved.channel_id) && resolved.channel_id !== link.channelId)
            throw new Error(`${key} links to a different channel than channel_id`);
        resolved[key] = link.messageId;
        learn(link, key);
    }
    return resolved;
}

export function normalizeBoundedInteger(value: unknown, fieldName: string, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
        throw new Error(`${fieldName} must be an integer from ${min} to ${max}`);
    return value as number;
}

export function normalizeMessageLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100)
        throw new Error("limit must be an integer from 1 to 100");
    return value as number;
}

export function requireText(value: unknown, fieldName: string, max: number, min = 1): string {
    if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length < min) throw new Error(`${fieldName} must be at least ${min} character${min === 1 ? "" : "s"}`);
    if (value.length > max) throw new Error(`${fieldName} exceeds ${max.toLocaleString("en-US")} characters`);
    return trimmed;
}

export function optionalText(value: unknown, fieldName: string, max: number): string | undefined {
    return value === undefined ? undefined : requireText(value, fieldName, max, 0);
}

export function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${fieldName} must be a boolean`);
    return value;
}

export function requireOneOf<T extends string>(value: unknown, fieldName: string, allowed: readonly T[], fallback?: T): T {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string" || !allowed.includes(value as T))
        throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
    return value as T;
}

export function normalizeSnowflakeList(value: unknown, fieldName: string, max: number): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) throw new Error(`${fieldName} must be a list of at most ${max} IDs`);
    return [...new Set(value.map(item => requireSnowflake(item, fieldName)))];
}

export function normalizeSearchQuery(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("query must be a non-empty string when provided");
    if (value.length > 1_024) throw new Error("query exceeds the 1,024 character search limit");
    return value.trim();
}

export function normalizeSearchOffset(value: unknown): number {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 5_000)
        throw new Error("offset must be an integer from 0 to 5,000");
    return value as number;
}

export function normalizeSearchHas(value: unknown): DiscordSearchHas[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length < 1 || value.length > DISCORD_SEARCH_HAS_VALUES.length)
        throw new Error(`has must contain 1 to ${DISCORD_SEARCH_HAS_VALUES.length} supported media filters`);

    const allowed = new Set<string>(DISCORD_SEARCH_HAS_VALUES);
    const normalized = [...new Set(value)];
    if (normalized.some(item => typeof item !== "string" || !allowed.has(item)))
        throw new Error(`has contains an unsupported filter; use: ${DISCORD_SEARCH_HAS_VALUES.join(", ")}`);
    return normalized as DiscordSearchHas[];
}

export function normalizeSearchSortOrder(value: unknown): "asc" | "desc" {
    if (value === undefined) return "desc";
    if (value !== "asc" && value !== "desc") throw new Error("sort_order must be asc or desc");
    return value;
}

export function normalizeMessageContent(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("content must be a non-empty string");
    if (value.length > 2_000) throw new Error("content exceeds Discord's 2,000 character limit");
    return value;
}

export function normalizeEmoji(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 64)
        throw new Error("emoji must be a unicode emoji or a custom emoji written as name:id");
    if (value.includes(":") ? !/^[A-Za-z0-9_]{2,32}:\d{17,20}$/.test(value) : /[/?#%\s]/.test(value))
        throw new Error("emoji must be a unicode emoji or a custom emoji written as name:id");
    return encodeURIComponent(value);
}

export interface UploadRequest {
    path: string;
    filename?: string;
    description?: string;
}

export function normalizeAttachments(value: unknown): UploadRequest[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10) throw new Error("attachments must contain at most 10 files");
    return value.map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`attachments[${index}] must be an object`);
        const { path, filename, description } = item as Record<string, unknown>;
        const name = filename === undefined ? undefined : requireText(filename, "filename", 255);
        if (name && /[\\/]/.test(name)) throw new Error("filename must not contain path separators");
        return {
            path: requireText(path, "path", 1_024),
            ...(name ? { filename: name } : {}),
            ...(description === undefined ? {} : { description: requireText(description, "description", 1_024, 0) }),
        };
    });
}

export interface AllowedMentions {
    parse: Array<"users" | "roles" | "everyone">;
    users?: string[];
    roles?: string[];
    replied_user: boolean;
}

export function normalizeAllowedMentions(value: unknown): AllowedMentions {
    if (value === undefined) return { parse: [], replied_user: false };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("allowed_mentions must be an object");
    const input = value as Record<string, unknown>;
    const rawParse = input.parse ?? [];
    if (!Array.isArray(rawParse) || rawParse.some(item => item !== "users" && item !== "roles" && item !== "everyone"))
        throw new Error("allowed_mentions.parse may contain users, roles and everyone");
    const parse = [...new Set(rawParse)];
    const users = normalizeSnowflakeList(input.users, "allowed_mentions.users", 100);
    const roles = normalizeSnowflakeList(input.roles, "allowed_mentions.roles", 100);
    if (parse.includes("users") && users.length) throw new Error("allowed_mentions cannot parse all users and list user IDs together");
    if (parse.includes("roles") && roles.length) throw new Error("allowed_mentions cannot parse all roles and list role IDs together");
    return {
        parse: parse as AllowedMentions["parse"],
        ...(users.length ? { users } : {}),
        ...(roles.length ? { roles } : {}),
        replied_user: optionalBoolean(input.replied_user, "allowed_mentions.replied_user") ?? false,
    };
}

export function parseUploadDirectories(value: string): string[] {
    return [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].slice(0, 20);
}

export function parseInviteCode(value: unknown): string {
    if (typeof value !== "string") throw new Error("invite must be an invite code or link");
    const match = /^(?:https?:\/\/)?(?:(?:www\.)?discord(?:app)?\.com\/invite\/|discord\.gg\/)?([A-Za-z0-9-]{2,64})\/?$/i.exec(value.trim());
    if (!match) throw new Error("invite must be an invite code or a discord.gg link");
    return match[1];
}

export function sentMessageKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

export function canDeleteRecordedMessage(
    sentMessages: ReadonlySet<string>,
    channelId: string,
    messageId: string
): boolean {
    return sentMessages.has(sentMessageKey(channelId, messageId));
}
