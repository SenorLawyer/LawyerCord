/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { proxyLazy } from "@utils/lazy";
import { UserStore, zustandCreate, zustandPersist } from "@webpack/common";

import { PersistedZustandStore, ZustandDefinition } from "./zustand";

export interface Token {
    access: string;
    refresh: string;
}

interface AuthorizationState {
    tokens: Record<string, Token>;
    getToken(userId?: string): Token | undefined;
    setToken(access: string, refresh: string, userId: string): void;
    deleteTokens(userId?: string): void;
    isAuthorized(): boolean;
}

export const useAuthorizationStore: PersistedZustandStore<AuthorizationState> = proxyLazy(() =>
    zustandCreate(
        zustandPersist(
            ((set, get) => ({
                tokens: {},
                getToken(userId = UserStore.getCurrentUser()?.id) {
                    return get().tokens[userId];
                },
                setToken(access, refresh, userId) {
                    if (userId) {
                        set({
                            tokens: {
                                ...get().tokens,
                                [userId]: { access, refresh },
                            },
                        });
                    }
                },
                deleteTokens(userId = UserStore.getCurrentUser()?.id) {
                    const { [userId]: _, ...tokens } = get().tokens;
                    set({ tokens });
                },
                isAuthorized() {
                    return !!get().getToken();
                },
            })) as ZustandDefinition<AuthorizationState>,
            {
                name: "songspotlight-auth",
                version: 1,
                migrate(persisted: any, version: number) {
                    if (version === 0) {
                        persisted.tokens = Object.fromEntries(
                            Object.entries(persisted.tokens).map(([userId, access]) => [userId, {
                                access,
                                refresh: "",
                            }]),
                        );
                    }

                    return persisted;
                },
                storage: {
                    async getItem(name: string) {
                        return (await DataStore.get(name)) ?? null;
                    },
                    async setItem(name: string, value: unknown) {
                        return await DataStore.set(name, value);
                    },
                    async removeItem(name: string) {
                        return await DataStore.del(name);
                    },
                },
                partialize: ({ tokens }) => ({ tokens }),
            },
        ),
    )
);
