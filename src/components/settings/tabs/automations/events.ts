/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CLIENT_EVENTS, isClientEventType } from "./clientEvents";
import { type Automation, type AutomationTriggerType, isRecord } from "./model";

export const TRIGGER_EVENTS: Partial<Record<AutomationTriggerType, string>> = {
    message: "MESSAGE_CREATE", mention: "MESSAGE_CREATE", dm: "MESSAGE_CREATE",
    "message-edit": "MESSAGE_UPDATE", "message-delete": "MESSAGE_DELETE",
    "reaction-add": "MESSAGE_REACTION_ADD", "reaction-remove": "MESSAGE_REACTION_REMOVE",
    "voice-join": "VOICE_STATE_UPDATES", "voice-leave": "VOICE_STATE_UPDATES", "voice-move": "VOICE_STATE_UPDATES",
};

export interface TriggerEvent {
    type: string;
    channelId: string;
    guildId: string;
    authorId: string;
    content: string;
    self: boolean;
    bot: boolean;
    mention: boolean;
    fromEngine: boolean;
    emoji?: string;
    status?: string;
    voice?: "voice-join" | "voice-leave" | "voice-move";
}

interface CompiledTrigger {
    automation: Automation;
    query: string;
    lowerQuery: string;
    regex?: RegExp;
}

export function compileTriggers(automations: Automation[]) {
    const events = new Map<string, Map<string, Map<string, CompiledTrigger[]>>>();
    for (const automation of automations) {
        const event = isClientEventType(automation.trigger.type) ? CLIENT_EVENTS[automation.trigger.type].event : TRIGGER_EVENTS[automation.trigger.type];
        if (!automation.enabled || !event) continue;
        const channel = automation.trigger.channelId?.trim() || "";
        const channels = events.get(event) ?? new Map<string, Map<string, CompiledTrigger[]>>();
        const authors = channels.get(channel) ?? new Map<string, CompiledTrigger[]>();
        const author = automation.trigger.authorId?.trim() || "";
        const list = authors.get(author) ?? [];
        const query = automation.trigger.matchText ?? "";
        let regex: RegExp | undefined;
        if (query && automation.trigger.matchMode === "regex") {
            try { regex = new RegExp(query, "i"); } catch { continue; }
        }
        list.push({ automation, query, lowerQuery: query.toLowerCase(), regex });
        authors.set(author, list);
        channels.set(channel, authors);
        events.set(event, channels);
    }
    return events;
}

export function matchTriggers(index: ReturnType<typeof compileTriggers>, event: TriggerEvent): Automation[] {
    if (event.fromEngine) return [];
    const channels = index.get(event.type);
    if (!channels) return [];
    const matches: Automation[] = [];
    let lowerContent: string | undefined;
    for (const channelId of event.channelId ? ["", event.channelId] : [""]) {
        const authors = channels.get(channelId);
        if (!authors) continue;
        for (const authorId of event.authorId ? ["", event.authorId] : [""]) {
            for (const { automation, query, lowerQuery, regex } of authors.get(authorId) ?? []) {
                const t = automation.trigger;
                if (event.self && !t.includeSelf || event.bot && t.includeBots === false) continue;
                if (t.guildId === "@me" ? Boolean(event.guildId) : Boolean(t.guildId && t.guildId !== event.guildId)) continue;
                if (t.status && t.status !== event.status || t.emoji && t.emoji !== event.emoji) continue;
                if (t.type === "dm" && event.guildId || t.type === "mention" && !event.mention || t.type.startsWith("voice-") && t.type !== event.voice) continue;
                if (query && !(regex ? regex.test(event.content) : t.matchMode === "exact" ? event.content === query : (lowerContent ??= event.content.toLowerCase()).includes(lowerQuery))) continue;
                matches.push(automation);
            }
        }
    }
    return matches;
}

export interface ClientEvent {
    type: string;
    userId: string;
    channelId: string;
    guildId: string;
    status: string;
    activities: unknown[];
    clientStatus: Record<string, unknown>;
    user: Record<string, unknown> | null;
    roles: unknown[];
    nick: string | null;
    relationshipType: number | null;
}

export function normalizeClientEvents(type: string, payload: unknown): ClientEvent[] {
    if (!isRecord(payload)) return [];
    const entries = type === "PRESENCE_UPDATES" && Array.isArray(payload.updates) ? payload.updates : [payload];
    return entries.filter(isRecord).map(event => {
        const relationship = isRecord(event.relationship) ? event.relationship : event;
        const rawUser = isRecord(event.user) ? event.user : isRecord(relationship.user) ? relationship.user : null;
        const user = rawUser ? { ...rawUser, global_name: rawUser.global_name ?? rawUser.globalName ?? null } : null;
        return {
            type,
            userId: String(event.userId ?? event.user_id ?? rawUser?.id ?? (type.startsWith("RELATIONSHIP_") ? relationship.id ?? "" : "")),
            channelId: String(event.channelId ?? event.channel_id ?? ""),
            guildId: String(event.guildId ?? event.guild_id ?? ""),
            status: typeof event.status === "string" ? event.status : "",
            activities: Array.isArray(event.activities) ? event.activities : [],
            clientStatus: isRecord(event.clientStatus) ? event.clientStatus : isRecord(event.client_status) ? event.client_status : {},
            user,
            roles: Array.isArray(event.roles) ? event.roles : [],
            nick: typeof event.nick === "string" ? event.nick : null,
            relationshipType: typeof event.relationshipType === "number" ? event.relationshipType : typeof relationship.type === "number" ? relationship.type : null,
        };
    });
}

export function matchesClientEvent(event: ClientEvent, filter: { authorId?: string; channelId?: string; guildId?: string; status?: string; }): boolean {
    return (!filter.authorId || filter.authorId === event.userId)
        && (!filter.channelId || filter.channelId === event.channelId)
        && (filter.guildId === "@me" ? !event.guildId : !filter.guildId || filter.guildId === event.guildId)
        && (!filter.status || filter.status === event.status);
}
