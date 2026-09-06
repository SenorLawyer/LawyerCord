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
    authorize: () => Promise<boolean>;
    setToken: (token: string) => void;
    remove: (id: string) => void;
    isAuthorized: () => boolean;
}
export const useAuthorizationStore = proxyLazy(() => zustandCreate(
    zustandPersist(
        (set: (state: Partial<AuthorizationState>) => void, get: () => AuthorizationState): AuthorizationState => ({
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
                if (!userId) return false;
                return new Promise<boolean>(resolve => {
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
                                if (hasCallbackStarted) return;
                                hasCallbackStarted = true;
                                try {
                                    if (UserStore.getCurrentUser()?.id !== userId) throw new Error("Discord account changed during authorization.");
                                    const url = new URL(response.location);
                                    const code = url.searchParams.get("code");
                                    if (!code) throw new Error("No code in redirect");
                                    const req = await fetch(`${AUTHORIZE_URL}?code=${encodeURIComponent(code)}`);
                                    if (req.ok) {
                                        const data: unknown = await req.json();
                                        if (UserStore.getCurrentUser()?.id !== userId) throw new Error("Discord account changed during authorization.");
                                        if (typeof data !== "object" || data === null || !("access_token" in data) || typeof data.access_token !== "string" || !data.access_token.trim())
                                            throw new Error("Streaks returned an invalid token.");
                                        get().setToken(data.access_token);
                                    } else {
                                        throw new Error(`Request not OK: ${req.status}`);
                                    }
                                    resolve(true);
                                } catch (e) {
                                    showToast(e instanceof Error ? `Failed to authorize: ${e.message}` : "Failed to authorize with Streaks.", Toasts.Type.FAILURE);
                                    new Logger("Streaks").error("Failed to authorize", e);
                                    resolve(false);
                                }
                            }}
                        />, {
                        onCloseCallback() {
                            if (!hasCallbackStarted) {
                                hasCallbackStarted = true;
                                resolve(false);
                            }
                        },
                    });
                });
            },
            isAuthorized: () => !!get().getToken(),
        }),
        {
            name: "vc-streaks-auth",
            storage: {
                getItem: (name: string) => DataStore.get<unknown>(name).then(value => value ?? null),
                setItem: (name: string, value: unknown) => DataStore.set(name, value),
                removeItem: (name: string) => DataStore.del(name),
            },
            partialize: (state: AuthorizationState) => ({ tokens: state.tokens }),
            onRehydrateStorage: () => async (state?: AuthorizationState) => {
                if (!state) return;
                useStreaksStore.getState().clear();
                if (state.isAuthorized()) {
                    await useStreaksStore.getState().fetch();
                }
            }
        }
    )
));
