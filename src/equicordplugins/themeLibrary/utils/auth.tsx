/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { logger, themeRequest } from "@equicordplugins/themeLibrary/components/ThemeTab";
import { OAuth2AuthorizeModal, openModal,Toasts, UserStore } from "@webpack/common";

const TOKEN_KEY = "ThemeLibrary_uniqueToken";

export async function getThemeLibraryToken(): Promise<string | null> {
    return await DataStore.get<string>(TOKEN_KEY) ?? null;
}

export async function authorizeUser(triggerModal: boolean = true) {
    const isAuthorized = await getAuthorization();

    if (isAuthorized === false) {
        if (!triggerModal) return false;
        openModal((props: any) => <OAuth2AuthorizeModal
            {...props}
            scopes={["identify", "connections"]}
            responseType="code"
            redirectUri="https://themes.equicord.org/api/user/auth"
            permissions={0n}
            clientId="1464006702125940736"
            cancelCompletesFlow={false}
            callback={async ({ location }: any) => {
                if (!location) return logger.error("No redirect location returned");

                try {
                    const response = await fetch(location, {
                        headers: { Accept: "application/json" }
                    });

                    const { token } = await response.json();

                    if (token) {
                        await DataStore.set(TOKEN_KEY, token);
                        showNotification({
                            title: "ThemeLibrary",
                            body: "Successfully authorized with ThemeLibrary!"
                        });
                    } else {
                        showNotification({
                            title: "ThemeLibrary",
                            body: "Failed to authorize, check console"
                        });
                    }
                } catch (e: any) {
                    logger.error("Failed to authorize", e);
                    showNotification({
                        title: "ThemeLibrary",
                        body: "Failed to authorize, check console"
                    });
                }
            }
            }
        />);
    } else {
        return isAuthorized;
    }
}

export async function deauthorizeUser() {
    const uniqueToken = await getThemeLibraryToken();

    if (!uniqueToken) return Toasts.show({
        message: "No uniqueToken present, try authorizing first!",
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        options: {
            duration: 2e3,
            position: Toasts.Position.BOTTOM
        }
    });

    const currentUser = UserStore.getCurrentUser();
    if (!currentUser) return Toasts.show({
        message: "Unable to deauthorize while logged out.",
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        options: {
            duration: 2e3,
            position: Toasts.Position.BOTTOM
        }
    });

    const res = await themeRequest("/user/revoke", {
        method: "DELETE",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${uniqueToken}`
        },
        body: JSON.stringify({ userId: currentUser.id })
    });

    try {
        let cleared = false;
        // try to delete anyway
        await DataStore.update<string | undefined>(TOKEN_KEY, token => {
            if (token !== uniqueToken) return token;
            cleared = true;
            return undefined;
        });
        if (res.ok && cleared) showNotification({
            title: "ThemeLibrary",
            body: "Successfully deauthorized from ThemeLibrary!"
        });
    } catch (e) {
        logger.error("Failed to delete token", e);
        showNotification({
            title: "ThemeLibrary",
            body: "Failed to deauthorize, check console"
        });
    }
}

export async function getAuthorization() {
    const uniqueToken = await getThemeLibraryToken();
    if (!uniqueToken) return false;

    // check if valid
    const res = await themeRequest("/user/findUserByToken", {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${uniqueToken}`
        },
    });
    return res.ok ? uniqueToken : false;
}

export async function isAuthorized(triggerModal: boolean = true) {
    const authorization = await getAuthorization();

    if (authorization === false) {
        await authorizeUser(triggerModal);
        return false;
    }

    return true;
}
