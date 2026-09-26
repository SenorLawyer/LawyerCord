/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { PlainSettings, Settings } from "@api/Settings";
import { readResponseText } from "@shared/readResponseText";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import { relaunch } from "@utils/native";
import { SettingsRouter, UserStore } from "@webpack/common";
import { deflateSync } from "fflate";

import { deauthorizeCloud, getCloudAuth, getCloudUrl } from "./cloudSetup";
import { captureCloudImportState, exportSettings, importSettings, isLocalDataStoreKey, omitCloudSettings, serializeDataStore } from "./offline";
import { ManifestEntry, SyncRequest, SyncResponse } from "./types";

const logger = new Logger("SettingsSync:Cloud", "#39b7e0");

const MANIFEST_STORE_KEY = "Vencord_cloudManifest";
const API_VERSION_STORE_KEY = "Vencord_cloudApiVersions";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_SYNC_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_TIMESTAMP_RESPONSE_BYTES = 1024 * 1024;

type ApiVersion = "v2" | "v1";

const SYNC_DIRECTION_KEY = "Vencord_cloudSyncDirection";
const SETTINGS_DIRTY_KEY = "Vencord_settingsDirty";
let localSettingsRevision = 0;
export const getCloudSyncDirection = () => localStorage.getItem(SYNC_DIRECTION_KEY) || "both";
export const setCloudSyncDirection = (direction: "push" | "pull" | "both" | "manual") => localStorage.setItem(SYNC_DIRECTION_KEY, direction);
export const areLocalSettingsDirty = () => localStorage.getItem(SETTINGS_DIRTY_KEY) === "true";
export const markLocalSettingsDirty = () => {
    localSettingsRevision++;
    localStorage.setItem(SETTINGS_DIRTY_KEY, "true");
};
export const markLocalSettingsClean = () => localStorage.removeItem(SETTINGS_DIRTY_KEY);

async function loadApiVersionMap(): Promise<Record<string, ApiVersion>> {
    return await DataStore.get<Record<string, ApiVersion>>(API_VERSION_STORE_KEY) ?? {};
}

async function getApiVersion(origin: string): Promise<ApiVersion> {
    const map = await loadApiVersionMap();
    return map[origin] ?? "v2";
}

async function getCloudSyncContext(checkLocalEdits = false) {
    const url = getCloudUrl();
    const userId = UserStore.getCurrentUser()?.id;
    const revision = localSettingsRevision;
    const isCurrent = () => userId !== undefined && UserStore.getCurrentUser()?.id === userId && getCloudUrl().href === url.href;
    return {
        expected: checkLocalEdits ? await captureCloudImportState() : undefined,
        url,
        manifestKey: `${MANIFEST_STORE_KEY}:${url.origin}:${userId}`,
        isCurrent,
        assertCurrent: () => {
            if (!isCurrent()) throw new Error("Cloud sync account or service changed.");
            if (checkLocalEdits && localSettingsRevision !== revision)
                throw new Error("Local settings changed during sync. Try again to include your latest changes.");
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

async function getLocalManifest(context: Awaited<ReturnType<typeof getCloudSyncContext>>): Promise<ManifestEntry[]> {
    return await DataStore.get<ManifestEntry[]>(context.manifestKey) ?? [];
}

async function saveLocalManifest(context: Awaited<ReturnType<typeof getCloudSyncContext>>, manifest: ManifestEntry[]) {
    await DataStore.set(context.manifestKey, manifest);
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

async function applyDownloads(downloads: SyncResponse["downloads"], context: Awaited<ReturnType<typeof getCloudSyncContext>>) {
    if (downloads.length === 0) return false;
    if (new Set(downloads.map(({ key }) => key)).size !== downloads.length)
        throw new Error("The cloud server returned duplicate download records.");

    const backup: { settings?: unknown; quickCss?: string; dataStore?: unknown[]; } = {};
    const decoder = new TextDecoder();

    for (const dl of downloads) {
        if (dl.key.startsWith("dataStore/") && isLocalDataStoreKey(dl.key.slice("dataStore/".length))) continue;
        const text = decoder.decode(fromBase64(dl.value));

        if (dl.key === "settings") {
            backup.settings = JSON.parse(text);
        } else if (dl.key === "quickCss") {
            backup.quickCss = text;
        } else if (dl.key === "dataStore") {
            const entries: unknown = JSON.parse(text);
            if (!Array.isArray(entries)) throw new Error("Cloud DataStore must contain key and value pairs.");
            backup.dataStore = (backup.dataStore ?? []).concat(entries);
        } else if (dl.key.startsWith("dataStore/")) {
            (backup.dataStore ??= []).push([dl.key.slice("dataStore/".length), JSON.parse(text)]);
        }
    }

    if (Object.keys(backup).length === 0) return false;
    await importSettings(JSON.stringify(backup), "all", true, context.assertCurrent, context.expected);
    return true;
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

function isManifestEntry(value: unknown): value is ManifestEntry {
    return isObject(value) && "key" in value && typeof value.key === "string"
        && "version" in value && typeof value.version === "number" && Number.isFinite(value.version)
        && "checksum" in value && typeof value.checksum === "string";
}

function isSyncResponse(value: unknown): value is SyncResponse {
    return isObject(value)
        && "server_manifest" in value && Array.isArray(value.server_manifest) && value.server_manifest.every(isManifestEntry)
        && "uploaded" in value && Array.isArray(value.uploaded) && value.uploaded.every(isManifestEntry)
        && "errors" in value && Array.isArray(value.errors) && value.errors.every((entry: unknown) =>
            isObject(entry) && "key" in entry && typeof entry.key === "string" && "error" in entry && typeof entry.error === "string")
        && "downloads" in value && Array.isArray(value.downloads) && value.downloads.every((entry: unknown) =>
            isManifestEntry(entry) && "value" in entry && typeof entry.value === "string"
            && (["settings", "quickCss", "dataStore"].includes(entry.key)
                || (entry.key.startsWith("dataStore/") && entry.key.length > "dataStore/".length)));
}

async function doSyncV2(uploads: SyncRequest["uploads"], clientManifest: ManifestEntry[], context: Awaited<ReturnType<typeof getCloudSyncContext>>): Promise<SyncResponse | null> {
    const auth = await getCloudAuth();
    context.assertCurrent();
    const res = await fetch(new URL("/v2/sync", context.url), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: "POST",
        headers: {
            Authorization: auth,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_manifest: clientManifest, uploads } satisfies SyncRequest),
    });

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

    const response: unknown = JSON.parse(await readResponseText(res, MAX_SYNC_RESPONSE_BYTES));
    context.assertCurrent();
    if (!isSyncResponse(response))
        throw new Error("The cloud server returned invalid or unsupported sync data.");
    if (response.errors.length)
        throw new Error("The cloud server could not synchronize all data. Please try again.");
    return response;
}

async function putV2(context: Awaited<ReturnType<typeof getCloudSyncContext>>, manual?: boolean) {
    const localManifest = await getLocalManifest(context);
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
    await VencordNative.settings.set({ ...VencordNative.settings.get(), cloud: PlainSettings.cloud }, undefined, context.expected?.settings);
    context.assertCurrent();
    await saveLocalManifest(context, response.server_manifest);
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

async function getV2(context: Awaited<ReturnType<typeof getCloudSyncContext>>, shouldNotify: boolean, force: boolean) {
    const localManifest = force ? [] : await getLocalManifest(context);
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
    await VencordNative.settings.set({ ...VencordNative.settings.get(), cloud: PlainSettings.cloud }, undefined, context.expected?.settings);
    context.assertCurrent();
    await saveLocalManifest(context, response.server_manifest);
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

async function deleteV2(context: Awaited<ReturnType<typeof getCloudSyncContext>>) {
    const auth = await getCloudAuth();
    if (!context.isCurrent()) return;

    const manifestRes = await fetch(new URL("/v2/manifest", context.url), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    const manifest: unknown = JSON.parse(await readResponseText(manifestRes, MAX_SYNC_RESPONSE_BYTES));
    if (!context.isCurrent()) return;
    if (!isObject(manifest) || !("entries" in manifest) || !Array.isArray(manifest.entries) || !manifest.entries.every(isManifestEntry))
        throw new Error("The cloud server returned an invalid deletion manifest.");

    for (const entry of manifest.entries) {
        const res = await fetch(new URL(`/v2/data/${encodeURIComponent(entry.key)}`, context.url), {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            method: "DELETE",
            headers: { Authorization: auth },
        });
        if (!context.isCurrent()) return;
        if (!res.ok && res.status !== 404)
            throw new Error(`Could not delete cloud data (API returned ${res.status}).`);
    }

    await saveLocalManifest(context, []);
    if (!context.isCurrent()) return;

    PlainSettings.cloud.settingsSyncVersion = 0;
    await VencordNative.settings.set({ ...VencordNative.settings.get(), cloud: PlainSettings.cloud }, undefined, context.expected?.settings);
    if (!context.isCurrent()) return;

    logger.info("Settings deleted from cloud successfully");
    showNotification({
        title: "Cloud Settings",
        body: "Settings deleted from cloud!",
        color: "var(--green-360)",
    });
}

function isSyncVersion(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function putV1(context: Awaited<ReturnType<typeof getCloudSyncContext>>, manual?: boolean) {
    const settings = await exportSettings({ syncDataStore: false, minify: true, cloud: true });

    context.assertCurrent();
    const auth = await getCloudAuth();
    context.assertCurrent();
    const res = await fetch(new URL("/v1/settings", context.url), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    const response: unknown = JSON.parse(await readResponseText(res, MAX_TIMESTAMP_RESPONSE_BYTES));
    context.assertCurrent();
    if (!isObject(response) || !("written" in response) || !isSyncVersion(response.written))
        throw new Error("The cloud server returned an invalid sync timestamp.");
    PlainSettings.cloud.settingsSyncVersion = response.written;
    await VencordNative.settings.set({ ...VencordNative.settings.get(), cloud: PlainSettings.cloud }, undefined, context.expected?.settings);
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

async function getV1(context: Awaited<ReturnType<typeof getCloudSyncContext>>, shouldNotify: boolean, force: boolean) {
    context.assertCurrent();
    const auth = await getCloudAuth();
    context.assertCurrent();
    const res = await fetch(new URL("/v1/settings", context.url), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: "GET",
        headers: {
            Authorization: auth,
            Accept: "application/octet-stream",
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

    const etag = res.headers.get("etag");
    const written = Number(etag);
    if (etag === null || !/^\d+$/.test(etag) || !isSyncVersion(written))
        throw new Error("The cloud server returned an invalid sync timestamp.");
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

    if (!res.body) throw new Error("The cloud settings response is empty.");
    let compressedBytes = 0;
    const compressed = res.body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
        transform(chunk, controller) {
            context.assertCurrent();
            compressedBytes += chunk.byteLength;
            if (compressedBytes > MAX_SYNC_RESPONSE_BYTES) throw new Error("Cloud settings exceed the download size limit.");
            for (let offset = 0; offset < chunk.length; offset += 1024)
                controller.enqueue(chunk.subarray(offset, offset + 1024));
        }
    }));
    const expanded = compressed.pipeThrough(new DecompressionStream("deflate-raw"));
    const settings = await readResponseText(new Response(expanded), MAX_SYNC_RESPONSE_BYTES);
    context.assertCurrent();
    await importSettings(settings, "all", true, context.assertCurrent, context.expected);
    context.assertCurrent();

    PlainSettings.cloud.settingsSyncVersion = written;
    await VencordNative.settings.set({ ...VencordNative.settings.get(), cloud: PlainSettings.cloud }, undefined, context.expected?.settings);
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

async function deleteV1(context: Awaited<ReturnType<typeof getCloudSyncContext>>) {
    const auth = await getCloudAuth();
    if (!context.isCurrent()) return;
    const res = await fetch(new URL("/v1/settings", context.url), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

let cloudOperationPending = false;

function beginCloudOperation(shouldNotify: boolean) {
    if (cloudOperationPending) {
        if (shouldNotify) showNotification({
            title: "Cloud Settings",
            body: "Another cloud operation is still running. Try again when it finishes.",
            noPersist: true,
        });
        return false;
    }
    cloudOperationPending = true;
    return true;
}

export async function putCloudSettings(manual?: boolean) {
    if (!beginCloudOperation(Boolean(manual))) return false;
    let context: Awaited<ReturnType<typeof getCloudSyncContext>> | undefined;
    try {
        context = await getCloudSyncContext(true);
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
        if (e instanceof SyntaxError) e = new Error("The cloud server returned invalid JSON.");
        logger.error("Failed to sync up", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings to the cloud (${String(e)}).`,
            color: "var(--red-360)",
        });
    } finally {
        cloudOperationPending = false;
    }
}

export async function getCloudSettings(shouldNotify = true, force = false) {
    if (!beginCloudOperation(shouldNotify)) return false;
    let context: Awaited<ReturnType<typeof getCloudSyncContext>> | undefined;
    try {
        context = await getCloudSyncContext(true);
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
        if (e instanceof SyntaxError) e = new Error("The cloud server returned invalid JSON.");
        logger.error("Failed to sync down", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not synchronize settings from the cloud (${String(e)}).`,
            color: "var(--red-360)",
        });
        return false;
    } finally {
        cloudOperationPending = false;
    }
}

export async function deleteCloudSettings() {
    if (!beginCloudOperation(true)) return;
    let context: Awaited<ReturnType<typeof getCloudSyncContext>> | undefined;
    try {
        context = await getCloudSyncContext();
        const version = await getApiVersion(context.url.origin);
        if (!context.isCurrent()) return;
        if (version === "v2")
            await deleteV2(context);
        else
            await deleteV1(context);
    } catch (e: unknown) {
        if (context && !context.isCurrent()) return;
        if (e instanceof SyntaxError) e = new Error("The cloud server returned invalid JSON.");
        logger.error("Failed to delete", e);
        showNotification({
            title: "Cloud Settings",
            body: `Could not delete settings (${String(e)}).`,
            color: "var(--red-360)",
        });
    } finally {
        cloudOperationPending = false;
    }
}

export async function eraseAllCloudData() {
    if (!beginCloudOperation(true)) return;
    let context: Awaited<ReturnType<typeof getCloudSyncContext>> | undefined;
    try {
        context = await getCloudSyncContext();
        const auth = await getCloudAuth();
        context.assertCurrent();
        const res = await fetch(new URL("/v1/", context.url), {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            method: "DELETE",
            headers: { Authorization: auth },
        });
        context.assertCurrent();

        if (!res.ok)
            throw new Error(`API returned ${res.status}.`);

        Settings.cloud.authenticated = false;
        await deauthorizeCloud();
        context.assertCurrent();
        await saveLocalManifest(context, []);
        context.assertCurrent();

        showNotification({
            title: "Cloud Integrations",
            body: "Successfully erased all data.",
            color: "var(--green-360)",
        });
    } catch (error: unknown) {
        if (context && !context.isCurrent()) return;
        logger.error("Failed to erase cloud data", error);
        showNotification({
            title: "Cloud Integrations",
            body: `Could not finish erasing cloud data (${String(error)}).`,
            color: "var(--red-360)",
        });
    } finally {
        cloudOperationPending = false;
    }
}
