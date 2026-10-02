/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import settings from "./settings";
import { VoiceChannelLogEntry } from "./types";

const vcLogs = new Map<string, VoiceChannelLogEntry[]>();
let retainedEntries = 0;
let vcLogSubscriptions: (() => void)[] = [];

let callStartTime: Date | null = null;

export function getCallStartTime(): Date | null {
    return callStartTime;
}

export function setCallStartTime(time: Date | null) {
    callStartTime = time;
}

const EMPTY_LOGS: VoiceChannelLogEntry[] = [];

export function getVcLogs(channelId?: string): VoiceChannelLogEntry[] {
    if (!channelId) return EMPTY_LOGS;
    return vcLogs.get(channelId) ?? EMPTY_LOGS;
}

export function addLogEntry(entry: VoiceChannelLogEntry) {
    const existing = vcLogs.get(entry.channelId) ?? [];
    const entries = [...existing.slice(-(settings.store.maxEntries - 1)), entry];
    retainedEntries += entries.length - existing.length;
    vcLogs.delete(entry.channelId);
    vcLogs.set(entry.channelId, entries);
    while (vcLogs.size > 50 || retainedEntries > 10_000) {
        const oldest = vcLogs.keys().next().value;
        if (oldest === undefined) break;
        retainedEntries -= vcLogs.get(oldest)?.length ?? 0;
        vcLogs.delete(oldest);
    }
    vcLogSubscriptions.forEach(fn => fn());
}

export function clearLogs(channelId?: string) {
    if (channelId) {
        retainedEntries -= vcLogs.get(channelId)?.length ?? 0;
        vcLogs.delete(channelId);
    } else {
        vcLogs.clear();
        retainedEntries = 0;
    }
    vcLogSubscriptions.forEach(fn => fn());
}

export function vcLogSubscribe(listener: () => void) {
    vcLogSubscriptions = [...vcLogSubscriptions, listener];
    return () => {
        vcLogSubscriptions = vcLogSubscriptions.filter(l => l !== listener);
    };
}
