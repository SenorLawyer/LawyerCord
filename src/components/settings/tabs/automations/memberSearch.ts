/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, GuildMemberStore, UserStore } from "@webpack/common";

const DEBOUNCE_MS = 350;
const MIN_REQUEST_GAP_MS = 1_000;
const SETTLE_MS = 700;
const MAX_RESULTS = 25;

/** Queries already sent this session. Repeating one costs nothing. */
const requested = new Set<string>();
let lastRequestAt = 0;

function isGuildId(value: string): boolean {
    return /^\d{15,25}$/.test(value);
}

/** Members Discord has already cached for this guild that match the query. */
function matchesFromStore(guildId: string, query: string): string[] {
    const needle = query.toLowerCase();
    const results: string[] = [];
    for (const id of GuildMemberStore.getMemberIds(guildId)) {
        const user = UserStore.getUser(id);
        if (!user) continue;
        const nick = GuildMemberStore.getNick(guildId, id);
        if (user.username.toLowerCase().includes(needle) || (nick !== null && nick.toLowerCase().includes(needle))) {
            results.push(id);
            if (results.length >= MAX_RESULTS) break;
        }
    }
    return results;
}

/**
 * Warms Discord's member cache for a name query, then reports the ids it now knows.
 *
 * This goes through the gateway request Discord's own member list uses, not the REST
 * search endpoint, so it cannot burn a REST rate limit. Requests are debounced per
 * keystroke, spaced by at least a second globally, and never repeated for a query
 * already asked this session.
 */
export function searchGuildMembers(guildId: string, query: string, onResults: (ids: string[]) => void): () => void {
    const trimmed = query.trim();
    if (!isGuildId(guildId) || trimmed.length < 2) {
        onResults([]);
        return () => { };
    }

    let cancelled = false;
    let settleId: number | undefined;

    const debounceId = window.setTimeout(() => {
        if (cancelled) return;
        onResults(matchesFromStore(guildId, trimmed));

        const key = `${guildId}:${trimmed.toLowerCase()}`;
        const now = Date.now();
        if (requested.has(key) || now - lastRequestAt < MIN_REQUEST_GAP_MS) return;
        requested.add(key);
        lastRequestAt = now;
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guildId], query: trimmed, limit: MAX_RESULTS });

        settleId = window.setTimeout(() => {
            if (!cancelled) onResults(matchesFromStore(guildId, trimmed));
        }, SETTLE_MS);
    }, DEBOUNCE_MS);

    return () => {
        cancelled = true;
        window.clearTimeout(debounceId);
        if (settleId !== undefined) window.clearTimeout(settleId);
    };
}
