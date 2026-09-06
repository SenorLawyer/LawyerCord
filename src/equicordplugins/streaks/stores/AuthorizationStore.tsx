/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore, zustandCreate, zustandPersist } from "@webpack/common";

import { AUTHORIZE_URL, CLIENT_ID } from "../constants";
import { useStreaksStore } from "./StreaksStore";

interface AuthorizationState {
    getToken: () => string | null;
    tokens: Record<string, string>;
    authorize: () => Promise<void>;
    setToken: (token: string) => void;
    remove: (id: string) => void;
    isAuthorized: () => boolean;
}
const indexedDBStorage = {
    async getItem(name: string): Promise<string | null> {
        return DataStore.get(name).then(v => v ?? null);
    },
    async setItem(name: string, value: string): Promise<void> {
        await DataStore.set(name, value);
    },
    async removeItem(name: string): Promise<void> {
        await DataStore.del(name);
    },
};
export const useAuthorizationStore = proxyLazy(() => zustandCreate(
    zustandPersist(
        (set: any, get: any) => ({
            tokens: {},
            getToken: () => get().tokens[UserStore.getCurrentUser()?.id] ?? null,
            setToken: (token: string) => {
                const id = UserStore.getCurrentUser()?.id;
                if (!id) return;
                set({ tokens: { ...get().tokens, [id]: token } });
            },
            remove: (id: string) => {
                const { tokens } = get();
                const newTokens = { ...tokens };
                delete newTokens[id];
                set({ tokens: newTokens });
                if (id === UserStore.getCurrentUser()?.id) useStreaksStore.getState().clear();
            },
            async authorize() {
                const userId = UserStore.getCurrentUser()?.id;
                if (!userId) throw new Error("No Discord account is logged in.");
                return new Promise((resolve, reject) => {
                    let hasCallbackStarted = false;
                    openModal(props =>
                        <OAuth2AuthorizeModal
                            {...props}
                            scopes={["identify"]}
                            responseType="code"
                            redirectUri={AUTHORIZE_URL}
                            permissions={0n}
                            clientId={CLIENT_ID}
                            cancelCompletesFlow={false}
                            callback={async (response: { location: string; }) => {
                                hasCallbackStarted = true;
                                try {
                                    if (UserStore.getCurrentUser()?.id !== userId) throw new Error("Discord account changed during authorization.");
                                    const url = new URL(response.location);
                                    const code = url.searchParams.get("code");
                                    if (!code) throw new Error("No code in redirect");
                                    const req = await fetch(`${AUTHORIZE_URL}?code=${encodeURIComponent(code)}`);
                                    if (req?.ok) {
                                        const { access_token: token } = await req.json();
                                        if (UserStore.getCurrentUser()?.id !== userId) throw new Error("Discord account changed during authorization.");
                                        if (token) get().setToken(token);
                                    } else {
                                        throw new Error(`Request not OK: ${req.status}`);
                                    }
                                    resolve(void 0);
                                } catch (e) {
                                    showToast(e instanceof Error ? `Failed to authorize: ${e.message}` : "Failed to authorize with Streaks.", Toasts.Type.FAILURE);
                                    new Logger("Streaks").error("Failed to authorize", e);
                                    reject(e);
                                }
                            }}
                        />, {
                        onCloseCallback() {
                            if (!hasCallbackStarted) {
                                reject(new Error("Authorization cancelled"));
                            }
                        },
                    });
                });
            },
            isAuthorized: () => !!get().getToken(),
        } as AuthorizationState),
        {
            name: "vc-streaks-auth",
            storage: indexedDBStorage,
            partialize: state => ({ tokens: state.tokens }),
            onRehydrateStorage: () => async state => {
                if (!state) return;
                useStreaksStore.getState().clear();
                if (state.isAuthorized()) {
                    await useStreaksStore.getState().migrate();
                    await useStreaksStore.getState().fetch();
                }
            }
        }
    )
));
