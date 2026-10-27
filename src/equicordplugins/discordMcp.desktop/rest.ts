/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { Constants, RestAPI } from "@webpack/common";

import { isRaw, type Raw } from "./serialize";

type Method = "get" | "post" | "put" | "patch" | "del";

export interface ApiRequest {
    url: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
}

export interface ApiResponse {
    status: number;
    body: unknown;
}

const MAX_RATE_LIMIT_WAITS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;

export const routes = {
    messages: (channelId: string) => Constants.Endpoints.MESSAGES(channelId),
    message: (channelId: string, messageId: string) => Constants.Endpoints.MESSAGE(channelId, messageId),
    user: (userId: string) => Constants.Endpoints.USER(userId),
    channel: (channelId: string) => `/channels/${channelId}`,
    threadsSearch: (channelId: string) => `/channels/${channelId}/threads/search`,
    startThread: (channelId: string, messageId: string) => `/channels/${channelId}/messages/${messageId}/threads`,
    channelThreads: (channelId: string) => `/channels/${channelId}/threads`,
    pins: (channelId: string) => `/channels/${channelId}/messages/pins`,
    pin: (channelId: string, messageId: string) => `/channels/${channelId}/messages/pins/${messageId}`,
    legacyPins: (channelId: string) => `/channels/${channelId}/pins`,
    legacyPin: (channelId: string, messageId: string) => `/channels/${channelId}/pins/${messageId}`,
    reactions: (channelId: string, messageId: string, emoji: string) => `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`,
    typing: (channelId: string) => `/channels/${channelId}/typing`,
    ack: (channelId: string, messageId: string) => `/channels/${channelId}/messages/${messageId}/ack`,
    mentions: () => "/users/@me/mentions",
    relationship: (userId: string) => `/users/@me/relationships/${userId}`,
    relationships: () => "/users/@me/relationships",
    settings: () => "/users/@me/settings",
    invite: (code: string) => `/invites/${code}`,
    leaveGuild: (guildId: string) => `/users/@me/guilds/${guildId}`,
    member: (guildId: string, userId: string) => `/guilds/${guildId}/members/${userId}`,
    memberRole: (guildId: string, userId: string, roleId: string) => `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    ban: (guildId: string, userId: string) => `/guilds/${guildId}/bans/${userId}`,
    guildChannels: (guildId: string) => `/guilds/${guildId}/channels`,
    guildSearch: (guildId: string) => `/guilds/${guildId}/messages/search`,
    channelSearch: (channelId: string) => `/channels/${channelId}/messages/search`,
};

function describeFailure(error: unknown): string {
    if (!isRaw(error)) return "Discord request failed";
    const body = isRaw(error.body) ? error.body : {};
    const message = typeof body.message === "string" ? body.message : typeof error.message === "string" ? error.message : "";
    const status = typeof error.status === "number" ? `HTTP ${error.status}` : "an error";
    const code = typeof body.code === "number" && body.code !== 0 ? ` (code ${body.code})` : "";
    return `Discord returned ${status}${code}${message ? `: ${message}` : ""}`;
}

function retryDelay(error: unknown): number | null {
    if (!isRaw(error) || error.status !== 429) return null;
    const body: Raw = isRaw(error.body) ? error.body : {};
    const seconds = typeof body.retry_after === "number" ? body.retry_after : 1;
    return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.ceil(seconds * 1_000) + 100);
}

export function failureStatus(error: unknown): number | null {
    return isRaw(error) && typeof error.status === "number" ? error.status : null;
}

export async function api(method: Method, request: ApiRequest, check?: () => void): Promise<ApiResponse> {
    for (let attempt = 0; ; attempt++) {
        try {
            check?.();
            const response: ApiResponse = await RestAPI[method]({ ...request, ...(method === "get" ? { retries: 2 } : {}) });
            return { status: response.status, body: response.body };
        } catch (error) {
            const delay = retryDelay(error);
            if (delay === null || attempt >= MAX_RATE_LIMIT_WAITS) {
                const failure = new Error(describeFailure(error));
                Object.assign(failure, { status: failureStatus(error) });
                throw failure;
            }
            await sleep(delay);
        }
    }
}

export function bodyRecord(response: ApiResponse, what: string): Raw {
    if (!isRaw(response.body)) throw new Error(`Discord returned an invalid ${what}`);
    return response.body;
}

export function bodyList(response: ApiResponse, what: string): Raw[] {
    if (!Array.isArray(response.body)) throw new Error(`Discord returned an invalid ${what}`);
    return response.body.filter(isRaw);
}
