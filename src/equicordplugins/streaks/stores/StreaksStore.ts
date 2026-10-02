/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { UserStore, zustandCreate } from "@webpack/common";

import { API_URL } from "../constants";
import { useAuthorizationStore } from "./AuthorizationStore";

export interface RemoteStreak {
    id: string;
    user_a_id: string;
    user_b_id: string;
    count: number;
    last_streak_date: string | null;
    user_a_today: boolean;
    user_b_today: boolean;
    today_date: string | null;
}

export interface StreaksState {
    streaks: Record<string, RemoteStreak>;
    fetch: () => Promise<void>;
    update: (recipientId: string) => Promise<void>;
    refresh: (recipientId: string) => Promise<void>;
    clear: () => void;
}

const logger = new Logger("Streaks");
let generation = 0;
const requests = new Map<string, AbortController>();

function beginRequest(key: string) {
    if (requests.has(key)) return;
    const controller = new AbortController();
    requests.set(key, controller);
    return controller;
}

export const useStreaksStore = proxyLazy(() => zustandCreate((set: (state: Partial<StreaksState>) => void, get: () => StreaksState): StreaksState => ({
    streaks: {},
    clear: () => {
        generation++;
        for (const controller of requests.values()) controller.abort();
        requests.clear();
        set({ streaks: {} });
    },
    async fetch() {
        const requestGeneration = generation;
        const myId = UserStore.getCurrentUser()?.id;
        const token = useAuthorizationStore.getState().getToken();
        if (!token) return;
        const key = "fetch";
        const controller = beginRequest(key);
        if (!controller) return;
        const { signal } = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
            const res = await fetch(`${API_URL}/streaks`, {
                headers: { Authorization: `Bearer ${token}` },
                signal
            });
            if (res.ok) {
                const data: RemoteStreak[] = await res.json();
                if (requestGeneration !== generation || UserStore.getCurrentUser()?.id !== myId || useAuthorizationStore.getState().getToken() !== token) return;
                const streaksMap: Record<string, RemoteStreak> = {};
                for (const s of data) {
                    const otherId = s.user_a_id === myId ? s.user_b_id : s.user_a_id;
                    streaksMap[otherId] = s;
                }
                set({ streaks: streaksMap });
            }
        } catch (e) {
            if (!signal.aborted) logger.error("Failed to fetch streaks", e);
        } finally {
            clearTimeout(timeout);
            if (requests.get(key) === controller) requests.delete(key);
        }
    },
    async update(recipientId: string) {
        const requestGeneration = generation;
        const myId = UserStore.getCurrentUser()?.id;
        const token = useAuthorizationStore.getState().getToken();
        if (!token) return;
        const key = `update:${recipientId}`;
        const controller = beginRequest(key);
        if (!controller) return;
        const { signal } = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
            const res = await fetch(`${API_URL}/streaks/${recipientId}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
                signal
            });
            if (res.ok) {
                const streak: RemoteStreak = await res.json();
                if (requestGeneration !== generation || UserStore.getCurrentUser()?.id !== myId || useAuthorizationStore.getState().getToken() !== token) return;
                set({ streaks: { ...get().streaks, [recipientId]: streak } });
            }
        } catch (e) {
            if (!signal.aborted) logger.error("Failed to update streak", e);
        } finally {
            clearTimeout(timeout);
            if (requests.get(key) === controller) requests.delete(key);
        }
    },
    async refresh(recipientId: string) {
        const requestGeneration = generation;
        const myId = UserStore.getCurrentUser()?.id;
        const token = useAuthorizationStore.getState().getToken();
        if (!token) return;
        const key = `refresh:${recipientId}`;
        const controller = beginRequest(key);
        if (!controller) return;
        const { signal } = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
            const res = await fetch(`${API_URL}/streaks/${recipientId}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal
            });
            if (res.ok) {
                const streak: RemoteStreak = await res.json();
                if (requestGeneration !== generation || UserStore.getCurrentUser()?.id !== myId || useAuthorizationStore.getState().getToken() !== token) return;
                set({ streaks: { ...get().streaks, [recipientId]: streak } });
            }
        } catch (e) {
            if (!signal.aborted) logger.error("Failed to refresh streak", e);
        } finally {
            clearTimeout(timeout);
            if (requests.get(key) === controller) requests.delete(key);
        }
    }
})));
