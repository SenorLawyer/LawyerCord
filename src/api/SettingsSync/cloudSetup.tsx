/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { readResponseText } from "@shared/readResponseText";
import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import { OAuth2AuthorizeModal, openModal, UserStore } from "@webpack/common";

export const logger = new Logger("SettingsSync:CloudSetup", "#39b7e0");
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;

export const getCloudUrl = () => new URL(Settings.cloud.url);
const getCloudUrlOrigin = () => getCloudUrl().origin;
let authorizationAttempt = 0;

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

export function cancelCloudAuthorization() {
    authorizationAttempt++;
    Settings.cloud.authenticated = false;
}

export async function deauthorizeCloud() {
    cancelCloudAuthorization();
    const key = `${getCloudUrlOrigin()}:${getUserId()}`;
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        secrets ??= {};
        delete secrets[key];
        return secrets;
    });
}

export async function authorizeCloud(replaceAuthorization = false) {
    const attempt = ++authorizationAttempt;
    const userId = getUserId();
    const service = Settings.cloud.url;
    const key = `${getCloudUrlOrigin()}:${userId}`;
    const isCurrent = () => attempt === authorizationAttempt
        && UserStore.getCurrentUser()?.id === userId && Settings.cloud.url === service;
    let clientId: string;
    let redirectUri: string;
    let redirect: URL;
    try {
        if (replaceAuthorization) {
            Settings.cloud.authenticated = false;
            await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
                secrets ??= {};
                delete secrets[key];
                return secrets;
            });
            if (!isCurrent()) return;
        }
        const authorization = await getAuthorization();
        if (!isCurrent()) return;
        if (typeof authorization === "string" && authorization) {
            Settings.cloud.authenticated = true;
            return;
        }
        const oauthConfiguration = await fetch(new URL("/v1/oauth/settings", getCloudUrl()), {
            signal: AbortSignal.timeout(30_000)
        });
        if (!oauthConfiguration.ok) throw new Error("Cloud configuration request failed.");
        const configuration: unknown = JSON.parse(await readResponseText(oauthConfiguration, MAX_AUTH_RESPONSE_BYTES));
        if (!isCurrent()) return;
        if (!configuration || typeof configuration !== "object"
            || !("clientId" in configuration) || typeof configuration.clientId !== "string" || !configuration.clientId
            || !("redirectUri" in configuration) || typeof configuration.redirectUri !== "string")
            throw new Error("Invalid cloud authorization configuration.");
        const parsedRedirect = parseUrl(configuration.redirectUri);
        if (!parsedRedirect || !["http:", "https:"].includes(parsedRedirect.protocol) || parsedRedirect.username || parsedRedirect.password)
            throw new Error("Invalid cloud authorization redirect.");
        clientId = configuration.clientId;
        redirectUri = configuration.redirectUri;
        redirect = parsedRedirect;
    } catch {
        if (!isCurrent()) return;
        showNotification({
            title: "Cloud Integration",
            body: "Setup failed. Could not read authorization or retrieve valid cloud configuration."
        });
        Settings.cloud.authenticated = false;
        return;
    }

    openModal(props => <OAuth2AuthorizeModal
        {...props}
        scopes={["identify"]}
        responseType="code"
        redirectUri={redirectUri}
        permissions={0n}
        clientId={clientId}
        cancelCompletesFlow={false}
        callback={async ({ location }: { location?: string; }) => {
            if (!isCurrent()) return;
            if (!location) {
                authorizationAttempt++;
                Settings.cloud.authenticated = false;
                return;
            }

            try {
                const callbackUrl = parseUrl(location);
                if (!callbackUrl || callbackUrl.origin !== redirect.origin || callbackUrl.pathname !== redirect.pathname || callbackUrl.username || callbackUrl.password)
                    throw new Error("Unexpected cloud authorization callback.");
                const res = await fetch(callbackUrl, {
                    signal: AbortSignal.timeout(30_000),
                    headers: { Accept: "application/json" }
                });
                if (!res.ok) throw new Error("Cloud authorization request failed.");
                const data: unknown = JSON.parse(await readResponseText(res, MAX_AUTH_RESPONSE_BYTES));
                if (!isCurrent()) return;
                if (!data || typeof data !== "object") throw new Error("Invalid cloud authorization response.");
                if ("secret" in data && typeof data.secret === "string" && data.secret) {
                    const { secret } = data;
                    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
                        secrets ??= {};
                        if (isCurrent()) secrets[key] = secret;
                        return secrets;
                    });
                    if (!isCurrent()) return;
                    logger.info("Authorized with cloud");
                    showNotification({
                        title: "Cloud Integration",
                        body: "Cloud integrations enabled!"
                    });
                    Settings.cloud.authenticated = true;
                } else {
                    logger.error("OAuth callback returned no secret");
                    showNotification({
                        title: "Cloud Integration",
                        body: "error" in data && typeof data.error === "string" && data.error
                            ? `Setup failed: ${data.error}`
                            : "Setup failed (no secret returned)."
                    });
                    Settings.cloud.authenticated = false;
                }
            } catch (e: unknown) {
                if (!isCurrent()) return;
                if (e instanceof SyntaxError) e = new Error("The cloud server returned invalid JSON.");
                logger.error("Failed to authorize", e);
                showNotification({
                    title: "Cloud Integration",
                    body: `Setup failed (${String(e)}).`
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
