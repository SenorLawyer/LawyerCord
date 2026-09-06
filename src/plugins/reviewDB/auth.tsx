/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore } from "@webpack/common";

import { ReviewDBAuth } from "./entities";

const DATA_STORE_KEY = "rdb-auth";
const AUTH_URL = "https://manti.vendicated.dev/api/reviewdb/auth";

export let Auth: ReviewDBAuth = {};

export async function initAuth() {
    const userId = UserStore.getCurrentUser()?.id;
    Auth = {};
    const auth = await getAuth(userId);
    if (UserStore.getCurrentUser()?.id === userId) Auth = auth ?? {};
}

export async function getAuth(userId = UserStore.getCurrentUser()?.id): Promise<ReviewDBAuth | undefined> {
    if (!userId) return;
    const auth = await DataStore.get(DATA_STORE_KEY);
    return auth?.[userId];
}

export async function getToken() {
    const auth = await getAuth();
    return auth?.token;
}

export async function updateAuth(newAuth: ReviewDBAuth | ((auth: ReviewDBAuth) => ReviewDBAuth)) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return;
    return DataStore.update(DATA_STORE_KEY, auth => {
        auth ??= {};
        const accountAuth = auth[currentUserId] ??= {};
        const update = typeof newAuth === "function" ? newAuth(accountAuth) : newAuth;

        if (update.token) accountAuth.token = update.token;
        if (update.user) accountAuth.user = update.user;
        if (UserStore.getCurrentUser()?.id === currentUserId) Auth = accountAuth;

        return auth;
    });
}

export function authorize(callback?: () => void) {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    openModal(props =>
        <OAuth2AuthorizeModal
            {...props}
            scopes={["identify"]}
            responseType="code"
            redirectUri={AUTH_URL}
            permissions={0n}
            clientId="915703782174752809"
            cancelCompletesFlow={false}
            callback={async (response: { location: string }) => {
                if (UserStore.getCurrentUser()?.id !== userId) return;
                try {
                    const url = new URL(response.location);
                    if (url.origin + url.pathname !== AUTH_URL || url.username || url.password)
                        throw new Error("Unexpected ReviewDB authorization URL.");
                    url.searchParams.set("clientMod", "vencord");
                    const res = await fetch(url, {
                        redirect: "error",
                        headers: { Accept: "application/json" }
                    });
                    if (UserStore.getCurrentUser()?.id !== userId) return;

                    if (!res.ok) {
                        const { message } = await res.json();
                        if (UserStore.getCurrentUser()?.id !== userId) return;
                        showToast(message ?? "An error occured while authorizing", Toasts.Type.FAILURE);
                        return;
                    }

                    const data: unknown = await res.json();
                    if (UserStore.getCurrentUser()?.id !== userId) return;
                    if (typeof data !== "object" || data === null || !("token" in data) || typeof data.token !== "string" || !data.token.trim())
                        throw new Error("ReviewDB returned an invalid authorization token.");
                    await updateAuth({ token: data.token });
                    if (UserStore.getCurrentUser()?.id !== userId) return;
                    showToast("Successfully logged in!", Toasts.Type.SUCCESS);
                    callback?.();
                } catch (e) {
                    new Logger("ReviewDB").error("Failed to authorize", e);
                }
            }}
        />
    );
}
