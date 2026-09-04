/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Automation, AutomationTriggerType } from "./model";

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
    voice?: "voice-join" | "voice-leave" | "voice-move";
}

interface CompiledTrigger {
    automation: Automation;
    query: string;
    regex?: RegExp;
}

export function compileTriggers(automations: Automation[]) {
    const events = new Map<string, Map<string, CompiledTrigger[]>>();
    for (const automation of automations) {
        const event = TRIGGER_EVENTS[automation.trigger.type];
        if (!automation.enabled || !event) continue;
        const channel = automation.trigger.channelId?.trim() || "";
        const channels = events.get(event) ?? new Map<string, CompiledTrigger[]>();
        const list = channels.get(channel) ?? [];
        const query = automation.trigger.matchText ?? "";
        let regex: RegExp | undefined;
        if (query && automation.trigger.matchMode === "regex") {
            try { regex = new RegExp(query, "i"); } catch { continue; }
        }
        list.push({ automation, query, regex });
        channels.set(channel, list);
        events.set(event, channels);
    }
    return events;
}

export function matchTriggers(index: ReturnType<typeof compileTriggers>, event: TriggerEvent): Automation[] {
    if (event.fromEngine) return [];
    const channels = index.get(event.type);
    if (!channels) return [];
    return [...channels.get("") ?? [], ...(event.channelId ? channels.get(event.channelId) ?? [] : [])].filter(({ automation, query, regex }) => {
        const t = automation.trigger;
        if (event.self && !t.includeSelf || event.bot && t.includeBots === false) return false;
        if (t.guildId === "@me" ? Boolean(event.guildId) : Boolean(t.guildId && t.guildId !== event.guildId)) return false;
        if (t.authorId && t.authorId !== event.authorId || t.emoji && t.emoji !== event.emoji) return false;
        if (t.type === "dm" && event.guildId || t.type === "mention" && !event.mention || t.type.startsWith("voice-") && t.type !== event.voice) return false;
        return !query || (regex ? regex.test(event.content) : t.matchMode === "exact" ? event.content === query : event.content.toLowerCase().includes(query.toLowerCase()));
    }).map(item => item.automation);
}
