/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, UserStore } from "@webpack/common";

export const logger = new Logger("SettingsSync:CloudSetup", "#39b7e0");

export const getCloudUrl = () => new URL(Settings.cloud.url);
const getCloudUrlOrigin = () => getCloudUrl().origin;

const getUserId = () => {
    const id = UserStore.getCurrentUser()?.id;
    if (!id) throw new Error("User not yet logged in");
    return id;
};

export async function getAuthorization() {
    const origin = getCloudUrlOrigin();
    const key = `${origin}:${getUserId()}`;
    const secrets = await DataStore.get<Record<string, string>>("Vencord_cloudSecret") ?? {};
    if (secrets[key] !== undefined) return secrets[key];

    // we need to migrate from the old format here
    if (secrets[origin]) {
        let authorization: string | undefined;
        await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
            secrets ??= {};
            if (secrets[key] === undefined && secrets[origin] !== undefined) {
                secrets[key] = secrets[origin];
                delete secrets[origin];
            }
            authorization = secrets[key];
            return secrets;
        });
        return authorization;
    }

    return secrets[key];
}

async function setAuthorization(secret: string) {
    const key = `${getCloudUrlOrigin()}:${getUserId()}`;
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        secrets ??= {};
        secrets[key] = secret;
        return secrets;
    });
}

export async function deauthorizeCloud() {
    const key = `${getCloudUrlOrigin()}:${getUserId()}`;
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        secrets ??= {};
        delete secrets[key];
        return secrets;
    });
}

export async function authorizeCloud() {
    if (await getAuthorization() !== undefined) {
        Settings.cloud.authenticated = true;
        return;
    }

    try {
        const oauthConfiguration = await fetch(new URL("/v1/oauth/settings", getCloudUrl()));
        var { clientId, redirectUri } = await oauthConfiguration.json();
    } catch {
        showNotification({
            title: "Cloud Integration",
            body: "Setup failed (couldn't retrieve OAuth configuration)."
        });
        Settings.cloud.authenticated = false;
        return;
    }

    openModal((props: any) => <OAuth2AuthorizeModal
        {...props}
        scopes={["identify"]}
        responseType="code"
        redirectUri={redirectUri}
        permissions={0n}
        clientId={clientId}
        cancelCompletesFlow={false}
        callback={async ({ location }: any) => {
            if (!location) {
                Settings.cloud.authenticated = false;
                return;
            }

            try {
                const res = await fetch(location, {
                    headers: { Accept: "application/json" }
                });
                const data = await res.json();
                if (data.secret) {
                    logger.info("Authorized with cloud");
                    await setAuthorization(data.secret);
                    showNotification({
                        title: "Cloud Integration",
                        body: "Cloud integrations enabled!"
                    });
                    Settings.cloud.authenticated = true;
                } else {
                    logger.error("OAuth callback returned no secret", data);
                    showNotification({
                        title: "Cloud Integration",
                        body: data.error
                            ? `Setup failed: ${data.error}`
                            : "Setup failed (no secret returned)."
                    });
                    Settings.cloud.authenticated = false;
                }
            } catch (e: any) {
                logger.error("Failed to authorize", e);
                showNotification({
                    title: "Cloud Integration",
                    body: `Setup failed (${e.toString()}).`
                });
                Settings.cloud.authenticated = false;
            }
        }
        }
    />);
}

export async function getCloudAuth() {
    const userId = getUserId();
    const origin = getCloudUrlOrigin();
    const secret = await getAuthorization();
    if (UserStore.getCurrentUser()?.id !== userId || getCloudUrlOrigin() !== origin)
        throw new Error("Cloud authorization changed. Please try again.");
    if (typeof secret !== "string" || !secret)
        throw new Error("Cloud authorization is unavailable. Please authorize this account.");
    return window.btoa(`${secret}:${userId}`);
}
