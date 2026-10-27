/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

import { type McpSettings, requireSnowflake } from "./policy";
import { api, bodyList, bodyRecord, failureStatus, routes } from "./rest";
import { isRaw, type Raw, str } from "./serialize";

export type Args = Record<string, unknown>;

export interface ToolEnv {
    check(): void;
    settings: McpSettings;
    native: PluginNative<typeof import("./native")>;
    spend(channelId?: string): void;
}

export interface ChannelInfo {
    id: string;
    guildId: string | null;
    type: number;
    name: string | null;
    object: object;
    record: Channel | null;
}

export function snowflakeCompare(a: string, b: string): number {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left > right ? 1 : -1;
}

export function requireGuild(value: unknown, field = "guild_id") {
    const guild = GuildStore.getGuild(requireSnowflake(value, field));
    if (!guild) throw new Error("Server is not available in the authenticated Discord client");
    return guild;
}

export function currentUserId(): string {
    return UserStore.getCurrentUser().id;
}

export async function requireChannel(value: unknown, field = "channel_id"): Promise<ChannelInfo> {
    const id = requireSnowflake(value, field);
    const record = ChannelStore.getChannel(id);
    if (record) return { id, guildId: record.guild_id || null, type: record.type, name: record.name ?? null, object: record, record };

    const body = bodyRecord(
        await api("get", { url: routes.channel(id) }).catch(() => { throw new Error("Channel is not available to the authenticated Discord account"); }),
        "channel"
    );
    return { id, guildId: body.guild_id ? String(body.guild_id) : null, type: Number(body.type), name: str(body.name), object: body, record: null };
}

export async function fetchMessage(channelId: string, messageId: string): Promise<Raw> {
    const response = await api("get", { url: routes.messages(channelId), query: { around: messageId, limit: 1 } });
    const message = bodyList(response, "message list").find(candidate => String(candidate.id) === messageId);
    if (!message || String(message.channel_id) !== channelId) throw new Error("Message was not found in that channel");
    return message;
}

export async function fetchUserRecord(userId: string): Promise<object> {
    const cached = UserStore.getUser(userId);
    if (cached) return cached;
    const response = await api("get", { url: routes.user(userId) }).catch(error => {
        throw new Error(failureStatus(error) === 404 ? "User was not found" : error instanceof Error ? error.message : "User lookup failed");
    });
    if (!isRaw(response.body)) throw new Error("Discord returned an invalid user");
    return response.body;
}
