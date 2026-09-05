/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AvatarDecoration } from "@plugins/decor";
import { getUsersDecorations } from "@plugins/decor/lib/api";
import { DECORATION_FETCH_COOLDOWN, SKU_ID } from "@plugins/decor/lib/constants";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { React, useCallback, useEffect, zustandCreate } from "@webpack/common";

interface UserDecorationData {
    asset: string | null;
    fetchedAt: number;
}

interface UsersDecorationsState {
    session: symbol | null;
    usersDecorations: Map<string, UserDecorationData>;
    fetch: (userId: string, force?: boolean) => void;
    set: (userId: string, decoration: string | null) => void;
    start: () => void;
    stop: () => void;
}

interface UsersDecorationsStore {
    getState(): UsersDecorationsState;
    subscribe(listener: () => void): () => void;
}

const logger = new Logger("Decor");

export const useUsersDecorationsStore: UsersDecorationsStore = proxyLazy(() => zustandCreate((set: (state: Partial<UsersDecorationsState>) => void, get: () => UsersDecorationsState) => {
    const queue = new Set<string>();
    const inFlight = new Map<string, symbol>();
    const requests = new Set<AbortController>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bulkFetch = async () => {
        timer = undefined;
        if (!get().session || queue.size === 0) return;
        const ids = [...queue];
        queue.clear();
        const token = Symbol();
        for (const id of ids) inFlight.set(id, token);
        const controller = new AbortController();
        requests.add(controller);
        try {
            const decorations = await getUsersDecorations(ids, controller.signal);
            if (controller.signal.aborted || !get().session) return;
            const now = Date.now();
            const next = new Map([...get().usersDecorations].filter(([, data]) => now - data.fetchedAt < DECORATION_FETCH_COOLDOWN));
            for (const id of ids) {
                if (inFlight.get(id) === token && !queue.has(id))
                    next.set(id, { asset: decorations[id] ?? null, fetchedAt: now });
            }
            set({ usersDecorations: next });
        } catch (error) {
            if (!controller.signal.aborted) logger.error("Failed to fetch decorations", error);
        } finally {
            requests.delete(controller);
            for (const id of ids) {
                if (inFlight.get(id) === token) inFlight.delete(id);
            }
        }
    };

    return {
        session: null,
        usersDecorations: new Map(),
        fetch(userId, force = false) {
            if (!get().session) return;
            const cached = get().usersDecorations.get(userId);
            if (!force && ((cached && Date.now() - cached.fetchedAt < DECORATION_FETCH_COOLDOWN) || inFlight.has(userId))) return;
            if (queue.has(userId)) return;
            queue.add(userId);
            timer ??= setTimeout(bulkFetch, 300);
        },
        set(userId, asset) {
            if (!get().session) return;
            queue.delete(userId);
            inFlight.delete(userId);
            const next = new Map(get().usersDecorations);
            next.set(userId, { asset, fetchedAt: Date.now() });
            set({ usersDecorations: next });
        },
        start() {
            if (!get().session) set({ session: Symbol() });
        },
        stop() {
            clearTimeout(timer);
            timer = undefined;
            queue.clear();
            inFlight.clear();
            for (const request of requests) request.abort();
            requests.clear();
            set({ session: null, usersDecorations: new Map() });
        }
    } satisfies UsersDecorationsState;
}));

export function useUserDecorAvatarDecoration(user?: User): AvatarDecoration | null {
    const userId = user?.id;
    let store: UsersDecorationsStore | undefined;
    try {
        useUsersDecorationsStore.getState();
        store = useUsersDecorationsStore;
    } catch (error) {
        logger.error("Decoration store unavailable", error);
    }
    const subscribe = useCallback((listener: () => void) => {
        try {
            return store?.subscribe(listener) ?? (() => undefined);
        } catch (error) {
            logger.error("Could not subscribe to decorations", error);
            return () => undefined;
        }
    }, [store]);
    const session = React.useSyncExternalStore(subscribe, () => store?.getState().session ?? null);
    const decoration = React.useSyncExternalStore(subscribe, () => userId ? store?.getState().usersDecorations.get(userId) : undefined);

    useEffect(() => {
        if (session && userId) store?.getState().fetch(userId);
    }, [userId, session, decoration, store]);

    return session && decoration?.asset ? { asset: decoration.asset, skuId: SKU_ID } : null;
}
