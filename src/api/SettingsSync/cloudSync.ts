/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { PlainSettings, Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import { SettingsRouter, UserStore } from "@webpack/common";
import { deflateSync, inflateSync } from "fflate";

import { deauthorizeCloud, getCloudAuth, getCloudUrl } from "./cloudSetup";
import { exportSettings, importSettings, isLocalDataStoreKey, omitCloudSettings, serializeDataStore } from "./offline";
import { ManifestEntry, SyncRequest, SyncResponse } from "./types";

const logger = new Logger("SettingsSync:Cloud", "#39b7e0");

const MANIFEST_STORE_KEY = "Vencord_cloudManifest";
const API_VERSION_STORE_KEY = "Vencord_cloudApiVersions";

type ApiVersion = "v2" | "v1";

const SYNC_DIRECTION_KEY = "Vencord_cloudSyncDirection";
const SETTINGS_DIRTY_KEY = "Vencord_settingsDirty";
export const getCloudSyncDirection = () => localStorage.getItem(SYNC_DIRECTION_KEY) || "both";
export const setCloudSyncDirection = (direction: "push" | "pull" | "both" | "manual") => localStorage.setItem(SYNC_DIRECTION_KEY, direction);
export const areLocalSettingsDirty = () => localStorage.getItem(SETTINGS_DIRTY_KEY) === "true";
export const markLocalSettingsDirty = () => localStorage.setItem(SETTINGS_DIRTY_KEY, "true");
export const markLocalSettingsClean = () => localStorage.removeItem(SETTINGS_DIRTY_KEY);

async function loadApiVersionMap(): Promise<Record<string, ApiVersion>> {
    return await DataStore.get<Record<string, ApiVersion>>(API_VERSION_STORE_KEY) ?? {};
}

async function getApiVersion(origin: string): Promise<ApiVersion> {
    const map = await loadApiVersionMap();
    return map[origin] ?? "v2";
}

function getCloudSyncContext() {
    const url = getCloudUrl();
    const userId = UserStore.getCurrentUser()?.id;
    const isCurrent = () => userId !== undefined && UserStore.getCurrentUser()?.id === userId && getCloudUrl().href === url.href;
    return {
        url,
        isCurrent,
        assertCurrent: () => {
            if (!isCurrent()) throw new Error("Cloud sync account or service changed.");
        }
    };
}

async function setApiVersion(version: ApiVersion, origin: string) {
    await DataStore.update<Record<string, ApiVersion>>(API_VERSION_STORE_KEY, map => {
        map ??= {};
        map[origin] = version;
        return map;
    });
}

function toBase64(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++)
        binary += String.fromCharCode(data[i]);
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function computeChecksum(data: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    const bytes = new Uint8Array(hash, 0, 8);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function getLocalManifest(): Promise<ManifestEntry[]> {
    return await DataStore.get<ManifestEntry[]>(MANIFEST_STORE_KEY) ?? [];
}

async function saveLocalManifest(manifest: ManifestEntry[]) {
    await DataStore.set(MANIFEST_STORE_KEY, manifest);
}

async function buildLocalData(): Promise<Map<string, Uint8Array>> {
    const encoder = new TextEncoder();
    const data = new Map<string, Uint8Array>();

    data.set("settings", encoder.encode(JSON.stringify(omitCloudSettings(VencordNative.settings.get()))));

    const quickCss = await VencordNative.quickCss.get();
    data.set("quickCss", encoder.encode(quickCss));

    const dataStoreEntries = await DataStore.entries();
    data.set("dataStore", encoder.encode(serializeDataStore(dataStoreEntries.filter(([key]) => !isLocalDataStoreKey(key)))));

    return data;
}

async function applyDownloads(downloads: SyncResponse["downloads"], context: ReturnType<typeof getCloudSyncContext>) {
    if (downloads.length === 0) return false;

    let settingsChanged = false;
    const decoder = new TextDecoder();

    for (const dl of downloads) {
        context.assertCurrent();
        const text = decoder.decode(fromBase64(dl.value));

        if (dl.key === "settings") {
            await importSettings(JSON.stringify({ settings: JSON.parse(text) }), "all", true);
            settingsChanged = true;
        } else if (dl.key === "quickCss") {
            await VencordNative.quickCss.set(text);
            settingsChanged = true;
        } else if (dl.key === "dataStore") {
            await importSettings(JSON.stringify({ dataStore: JSON.parse(text) }), "datastore", true);
            settingsChanged = true;
        } else if (dl.key.startsWith("dataStore/")) {
            const dsKey = dl.key.slice("dataStore/".length);
            if (isLocalDataStoreKey(dsKey)) continue;
            await DataStore.set(dsKey, JSON.parse(text));
        }
    }

    return settingsChanged;
}

function handleAuthFailure() {
    showNotification({
        title: "Cloud Settings",
        body: "Cloud sync was disabled because this account isn't connected. Reconnect in Cloud Settings.",
        color: "var(--yellow-360)",
        onClick: () => SettingsRouter.openUserSettings("equicord_cloud_panel"),
    });
    Settings.cloud.authenticated = false;
}

async function doSyncV2(uploads: SyncRequest["uploads"], clientManifest: ManifestEntry[], context: ReturnType<typeof getCloudSyncContext>): Promise<SyncResponse | null> {
    const auth = await getCloudAuth();
    context.assertCurrent();
    let res: Response;
    try {
        res = await fetch(new URL("/v2/sync", context.url), {
            method: "POST",
            headers: {
                Authorization: auth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ client_manifest: clientManifest, uploads } satisfies SyncRequest),
        });
    } catch (e) {
        context.assertCurrent();
        logger.error("v2 sync network error, will retry next sync", e);
        return null;
    }

    context.assertCurrent();
    if (res.status === 404) {
        logger.info("Server does not support v2, falling back to v1");
        await setApiVersion("v1", context.url.origin);
        return null;
    }

    if (res.status === 401) {
        handleAuthFailure();
        return null;
    }

    if (!res.ok) {
        logger.error(`Sync failed, API returned ${res.status}`);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings (API returned ${res.status}).`,
            color: "var(--red-360)",
        });
        return null;
    }

    const response: SyncResponse = await res.json();
    context.assertCurrent();
    if (response.errors.length)
        throw new Error("The cloud server could not synchronize all data. Please try again.");
    return response;
}

async function putV2(context: ReturnType<typeof getCloudSyncContext>, manual?: boolean) {
    const localManifest = await getLocalManifest();
    context.assertCurrent();
    const manifestMap = new Map(localManifest.map(e => [e.key, e]));

    const localData = await buildLocalData();
    context.assertCurrent();
    const uploads: SyncRequest["uploads"] = [];

    for (const [key, value] of localData) {
        const checksum = await computeChecksum(value);
        context.assertCurrent();
        const existing = manifestMap.get(key);

        if (!existing || existing.checksum !== checksum)
            uploads.push({ key, value: toBase64(value), checksum });
    }

    if (uploads.length === 0 && !manual) {
        logger.info("No changes to push");
        delete localStorage.Vencord_settingsDirty;
        return;
    }

    const response = await doSyncV2(uploads, localManifest, context);
    context.assertCurrent();
    if (!response) return;

    const hadDownloads = await applyDownloads(response.downloads, context);
    context.assertCurrent();

    PlainSettings.cloud.settingsSyncVersion = Date.now();
    await VencordNative.settings.set(PlainSettings);
    context.assertCurrent();
    await saveLocalManifest(response.server_manifest);
    context.assertCurrent();

    logger.info(`Sync complete: ${response.uploaded.length} uploaded, ${response.downloads.length} downloaded`);

    if (manual) {
        showNotification({
            title: "Cloud Settings",
            body: hadDownloads
                ? "Settings synced! Click here to restart to fully apply changes."
                : "Settings synchronized to the cloud!",
            color: "var(--green-360)",
            onClick: hadDownloads ? (IS_WEB ? () => location.reload() : relaunch) : undefined,
            noPersist: true,
        });
    }

    delete localStorage.Vencord_settingsDirty;
}

async function getV2(context: ReturnType<typeof getCloudSyncContext>, shouldNotify: boolean, force: boolean) {
    const localManifest = force ? [] : await getLocalManifest();
    context.assertCurrent();

    const response = await doSyncV2([], localManifest, context);
    context.assertCurrent();
    if (!response) return false;

    if (response.downloads.length === 0) {
        logger.info("Settings up to date");
        if (shouldNotify)
            showNotification({
                title: "Cloud Settings",
                body: "Your settings are up to date.",
                noPersist: true,
            });
        return false;
    }

    const settingsChanged = await applyDownloads(response.downloads, context);
    context.assertCurrent();

    PlainSettings.cloud.settingsSyncVersion = Date.now();
    await VencordNative.settings.set(PlainSettings);
    context.assertCurrent();
    await saveLocalManifest(response.server_manifest);
    context.assertCurrent();

    logger.info(`Pulled ${response.downloads.length} keys from cloud`);

    if (shouldNotify)
        showNotification({
            title: "Cloud Settings",
            body: settingsChanged
                ? "Your settings have been updated! Click here to restart to fully apply changes!"
                : "Cloud data synchronized.",
            color: "var(--green-360)",
            onClick: settingsChanged ? (IS_WEB ? () => location.reload() : relaunch) : undefined,
            noPersist: true,
        });

    delete localStorage.Vencord_settingsDirty;
    return true;
}

async function deleteV2(context: ReturnType<typeof getCloudSyncContext>) {
    const auth = await getCloudAuth();
    if (!context.isCurrent()) return;

    const manifestRes = await fetch(new URL("/v2/manifest", context.url), {
        headers: { Authorization: auth },
    });
    if (!context.isCurrent()) return;

    if (!manifestRes.ok) {
        showNotification({
            title: "Cloud Settings",
            body: `Could not fetch manifest for deletion (API returned ${manifestRes.status}).`,
            color: "var(--red-360)",
        });
        return;
    }

    const { entries }: { entries: ManifestEntry[]; } = await manifestRes.json();
    if (!context.isCurrent()) return;

    await Promise.all(entries.map(async entry => {
        const res = await fetch(new URL(`/v2/data/${encodeURIComponent(entry.key)}`, context.url), {
            method: "DELETE",
            headers: { Authorization: auth },
        });
        if (!res.ok && res.status !== 404)
            throw new Error(`Could not delete cloud data (API returned ${res.status}).`);
    }));
    if (!context.isCurrent()) return;

    await saveLocalManifest([]);
    if (!context.isCurrent()) return;

    PlainSettings.cloud.settingsSyncVersion = 0;
    await VencordNative.settings.set(PlainSettings);
    if (!context.isCurrent()) return;

    logger.info("Settings deleted from cloud successfully");
    showNotification({
        title: "Cloud Settings",
        body: "Settings deleted from cloud!",
        color: "var(--green-360)",
    });
}

async function putV1(context: ReturnType<typeof getCloudSyncContext>, manual?: boolean) {
    const settings = await exportSettings({ syncDataStore: false, minify: true, cloud: true });

    context.assertCurrent();
    const auth = await getCloudAuth();
    context.assertCurrent();
    const res = await fetch(new URL("/v1/settings", context.url), {
        method: "PUT",
        headers: {
            Authorization: auth,
            "Content-Type": "application/octet-stream",
        },
        body: deflateSync(new TextEncoder().encode(settings)) as Uint8Array<ArrayBuffer>,
    });

    context.assertCurrent();
    if (!res.ok) {
        logger.error(`Failed to sync up, API returned ${res.status}`);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings to cloud (API returned ${res.status}).`,
            color: "var(--red-360)",
        });
        return;
    }

    const { written } = await res.json();
    context.assertCurrent();
    PlainSettings.cloud.settingsSyncVersion = written;
    await VencordNative.settings.set(PlainSettings);
    context.assertCurrent();

    logger.info("Settings uploaded to cloud successfully");

    if (manual) {
        showNotification({
            title: "Cloud Settings",
            body: "Synchronized settings to the cloud!",
            noPersist: true,
        });
    }

    delete localStorage.Vencord_settingsDirty;
}

async function getV1(context: ReturnType<typeof getCloudSyncContext>, shouldNotify: boolean, force: boolean) {
    context.assertCurrent();
    const auth = await getCloudAuth();
    context.assertCurrent();
    const res = await fetch(new URL("/v1/settings", context.url), {
        method: "GET",
        headers: {
            Authorization: auth,
            Accept: "application/octet-stream",
            "If-None-Match": Settings.cloud.settingsSyncVersion.toString(),
        },
    });

    context.assertCurrent();
    if (res.status === 401) {
        handleAuthFailure();
        return false;
    }

    if (res.status === 404) {
        logger.info("No settings on the cloud");
        if (shouldNotify)
            showNotification({
                title: "Cloud Settings",
                body: "There are no settings in the cloud.",
                noPersist: true,
            });
        return false;
    }

    if (res.status === 304) {
        logger.info("Settings up to date");
        if (shouldNotify)
            showNotification({
                title: "Cloud Settings",
                body: "Your settings are up to date.",
                noPersist: true,
            });
        return false;
    }

    if (!res.ok) {
        logger.error(`Failed to sync down, API returned ${res.status}`);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings from the cloud (API returned ${res.status}).`,
            color: "var(--red-360)",
        });
        return false;
    }

    const written = Number(res.headers.get("etag")!);
    const localWritten = Settings.cloud.settingsSyncVersion;

    if (!force && written < localWritten) {
        if (shouldNotify)
            showNotification({
                title: "Cloud Settings",
                body: "Your local settings are newer than the cloud ones.",
                noPersist: true,
            });
        return false;
    }

    const data = await res.arrayBuffer();
    context.assertCurrent();
    const settings = new TextDecoder().decode(inflateSync(new Uint8Array(data)));
    await importSettings(settings, "all", true, context.assertCurrent);
    context.assertCurrent();

    PlainSettings.cloud.settingsSyncVersion = written;
    await VencordNative.settings.set(PlainSettings);
    context.assertCurrent();

    logger.info("Settings loaded from cloud successfully");
    if (shouldNotify)
        showNotification({
            title: "Cloud Settings",
            body: "Your settings have been updated! Click here to restart to fully apply changes!",
            color: "var(--green-360)",
            onClick: IS_WEB ? () => location.reload() : relaunch,
            noPersist: true,
        });

    delete localStorage.Vencord_settingsDirty;
    return true;
}

async function deleteV1(context: ReturnType<typeof getCloudSyncContext>) {
    const auth = await getCloudAuth();
    if (!context.isCurrent()) return;
    const res = await fetch(new URL("/v1/settings", context.url), {
        method: "DELETE",
        headers: { Authorization: auth },
    });
    if (!context.isCurrent()) return;

    if (!res.ok) {
        logger.error(`Failed to delete, API returned ${res.status}`);
        showNotification({
            title: "Cloud Settings",
            body: `Could not delete settings (API returned ${res.status}).`,
            color: "var(--red-360)",
        });
        return;
    }

    logger.info("Settings deleted from cloud successfully");
    showNotification({
        title: "Cloud Settings",
        body: "Settings deleted from cloud!",
        color: "var(--green-360)",
    });
}

export function shouldCloudSync(direction: "push" | "pull") {
    const localDirection = getCloudSyncDirection();
    return localDirection === direction || localDirection === "both";
}

export async function putCloudSettings(manual?: boolean) {
    let context: ReturnType<typeof getCloudSyncContext> | undefined;
    try {
        context = getCloudSyncContext();
        const version = await getApiVersion(context.url.origin);
        context.assertCurrent();
        if (version === "v2") {
            await putV2(context, manual);
            context.assertCurrent();
            const nextVersion = await getApiVersion(context.url.origin);
            context.assertCurrent();
            if (nextVersion === "v1")
                await putV1(context, manual);
        } else {
            await putV1(context, manual);
        }
    } catch (e: unknown) {
        if (context && !context.isCurrent()) return;
        logger.error("Failed to sync up", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings to the cloud (${String(e)}).`,
            color: "var(--red-360)",
        });
    }
}

export async function getCloudSettings(shouldNotify = true, force = false) {
    let context: ReturnType<typeof getCloudSyncContext> | undefined;
    try {
        context = getCloudSyncContext();
        const version = await getApiVersion(context.url.origin);
        context.assertCurrent();
        if (version === "v2") {
            const result = await getV2(context, shouldNotify, force);
            context.assertCurrent();
            const nextVersion = await getApiVersion(context.url.origin);
            context.assertCurrent();
            if (nextVersion === "v1")
                return await getV1(context, shouldNotify, force);
            return result;
        }
        return await getV1(context, shouldNotify, force);
    } catch (e: unknown) {
        if (context && !context.isCurrent()) return false;
        logger.error("Failed to sync down", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings from the cloud (${String(e)}).`,
            color: "var(--red-360)",
        });
        return false;
    }
}

export async function deleteCloudSettings() {
    let context: ReturnType<typeof getCloudSyncContext> | undefined;
    try {
        context = getCloudSyncContext();
        const version = await getApiVersion(context.url.origin);
        if (!context.isCurrent()) return;
        if (version === "v2")
            await deleteV2(context);
        else
            await deleteV1(context);
    } catch (e: unknown) {
        if (context && !context.isCurrent()) return;
        logger.error("Failed to delete", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not delete settings (${String(e)}).`,
            color: "var(--red-360)",
        });
    }
}

export async function eraseAllCloudData() {
    const res = await fetch(new URL("/v1/", getCloudUrl()), {
        method: "DELETE",
        headers: { Authorization: await getCloudAuth() },
    });

    if (!res.ok) {
        logger.error(`Failed to erase data, API returned ${res.status}`);
        showNotification({
            title: "Cloud Integrations",
            body: `Could not erase all data (API returned ${res.status}), please contact support.`,
            color: "var(--red-360)",
        });
        return;
    }

    Settings.cloud.authenticated = false;
    await deauthorizeCloud();
    await saveLocalManifest([]);

    showNotification({
        title: "Cloud Integrations",
        body: "Successfully erased all data.",
        color: "var(--green-360)",
    });
}
