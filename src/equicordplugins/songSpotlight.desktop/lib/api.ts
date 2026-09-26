/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserData, UserDataSchema } from "@song-spotlight/api/structs";
import { showToast, Toasts, UserStore } from "@webpack/common";

import { Token, useAuthorizationStore } from "./stores/AuthorizationStore";
import { useSongStore } from "./stores/SongStore";

const api = "https://dc.songspotlight.nexpid.xyz/";
export const apiConstants = {
    api,
    oauth2: {
        clientId: "1157745434140344321",
        redirectURL: `${api}api/auth/authorize`,
    },
    songLimit: 6,
};

const refreshes = new WeakMap<Token, Promise<Token | undefined>>();
function refreshAccessToken(userId: string, token: Token) {
    const pending = refreshes.get(token);
    if (pending) return pending;

    const promise = fetch(new URL("api/auth/refresh", apiConstants.api), {
        method: "POST",
        headers: {
            "X-Refresh-Token": token.refresh,
        },
        body: token.access,
        redirect: "error",
    }).then(async res => {
        if (!res.ok) return;

        const access = await res.text();
        const auth = useAuthorizationStore.getState();
        if (auth.getToken(userId) !== token) return;
        auth.setToken(access, token.refresh, userId);
        return auth.getToken(userId);
    }).finally(() => refreshes.delete(token));
    refreshes.set(token, promise);
    return promise;
}

export async function authFetch(url: string | URL, options?: RequestInit, userId = UserStore.getCurrentUser()?.id) {
    url = new URL(url);
    try {
        if (url.origin !== new URL(api).origin) throw new Error("Invalid Song Spotlight URL.");
        let token = useAuthorizationStore.getState().getToken(userId);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!userId || UserStore.getCurrentUser()?.id !== userId || useAuthorizationStore.getState().getToken(userId) !== token)
                throw new Error("The Song Spotlight account changed. Please try again.");
            const headers = new Headers(options?.headers);
            if (token) headers.set("Authorization", token.access);
            const res = await fetch(url, {
                ...options,
                headers,
                redirect: "error",
            });

            if (res.ok) return res;

            // not modified
            if (res.status === 304) return null;

            const text = await res.text();

            // unauthorized
            if (res.status === 401) {
                const refreshed = attempt === 0 && token ? await refreshAccessToken(userId, token) : undefined;
                if (refreshed) {
                    token = refreshed;
                    continue;
                }
                if (useAuthorizationStore.getState().getToken(userId) === token)
                    useAuthorizationStore.getState().deleteTokens(userId);
                throw new Error("You have been signed out from Song Spotlight. Please sign in again.");
            } else {
                throw new Error(
                    !text.includes("<body>") && res.status >= 400 && res.status <= 599
                        ? `Song Spotlight: ${text}`
                        : `Song Spotlight fetch error at ${url.pathname}`,
                );
            }
        }
    } catch (error) {
        showToast(`Song Spotlight: ${error}`, Toasts.Type.FAILURE);

        throw error;
    }
}

export async function getData(): Promise<UserData | undefined> {
    const userId = UserStore.getCurrentUser()?.id;
    const at = useSongStore.getState().users[userId]?.at;
    return await authFetch(new URL("api/data", apiConstants.api), {
        headers: at ? { "If-Modified-Since": at } : {},
    }).then(async res => {
        if (!res) return useSongStore.getState().users[userId]?.data;

        const data = UserDataSchema.max(apiConstants.songLimit).nullable().parse(await res.json()) ?? [];
        useSongStore.getState().update({
            userId,
            data,
            at: res.headers.get("Last-Modified") || undefined,
        });
        return data;
    });
}
export async function listData(userId: string): Promise<UserData | undefined> {
    if (userId === UserStore.getCurrentUser()?.id) return await getData();

    const at = useSongStore.getState().users[userId]?.at;
    return await authFetch(new URL(`api/data/${userId}`, apiConstants.api), {
        headers: at ? { "If-Modified-Since": at } : {},
    }).then(async res => {
        if (!res) return useSongStore.getState().users[userId]?.data;

        const data = UserDataSchema.max(apiConstants.songLimit).nullable().parse(await res.json()) ?? [];
        useSongStore.getState().update({
            userId,
            data,
            at: res.headers.get("Last-Modified") || undefined,
        });
        return data;
    });
}
export async function saveData(data: UserData): Promise<true> {
    const userId = UserStore.getCurrentUser()?.id;
    return await authFetch(new URL("api/data", apiConstants.api), {
        method: "PUT",
        body: JSON.stringify(data),
        headers: {
            "Content-Type": "application/json",
        },
    })
        .then(async res => {
            const json = await res?.json();
            if (json !== true) throw new Error("Song Spotlight did not confirm the save.");
            useSongStore
                .getState().update({
                    userId,
                    data,
                    at: res?.headers.get("Last-Modified") || undefined,
                });
            return json;
        });
}
export async function deleteData(): Promise<true> {
    const userId = UserStore.getCurrentUser()?.id;
    const token = useAuthorizationStore.getState().getToken(userId);
    return await authFetch(new URL("api/data", apiConstants.api), {
        method: "DELETE",
    })
        .then(res => res?.json())
        .then(json => {
            if (json !== true) throw new Error("Song Spotlight did not confirm the deletion.");
            useSongStore.getState().delete(userId);
            const current = useAuthorizationStore.getState().getToken(userId);
            if (current === token || (token?.refresh && current?.refresh === token.refresh))
                useAuthorizationStore.getState().deleteTokens(userId);
            return json;
        });
}
