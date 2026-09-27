/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DefaultSettings, PlainSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import { chooseFile, saveFile } from "@utils/web";
import { moment, Toasts, UserStore } from "@webpack/common";

import { DataStore } from "..";

type BackupType = "all" | "plugins" | "css" | "datastore";
const LOCAL_DATASTORE_KEYS = new Set<unknown>([
    "Vencord_cloudSecret", "Vencord_cloudManifest", "Vencord_cloudApiVersions", "VencordQuickCss",
    "ThemeLibrary_uniqueToken", "decor-auth", "songspotlight-auth", "vc-streaks-auth", "rdb-auth",
    "ScheduledMessages_queue", "VCLastVoiceChannel", "VCLastVoiceChannelSession", "KeepCurrentChannel_previousData",
    "ChannelTabs_openChannels_v2", "ChannelTabs_unreadFallbacks_v1"
]);
const LOCAL_PLUGIN_SETTINGS = new Map<string, readonly string[]>([
    ["FileUpload", [
        "serviceUrl", "ziplineToken", "folderId", "ezHostKey", "nestToken", "encryptingHostKey", "catboxUserhash", "sharexConfig",
        "gofileToken", "pixelVaultKey", "pixelDrainKey", "corsProxyUrl", "s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId",
        "s3SecretAccessKey", "s3SessionToken", "s3PublicUrl", "s3Prefix", "s3ForcePathStyle", "webdavUrl", "webdavUsername",
        "webdavPassword", "webdavDirectory", "webdavServerType", "webdavShareType"
    ]],
    ["RichPresence", [
        "abs_serverUrl", "abs_username", "abs_password", "jf_serverUrl", "jf_apiKey", "jf_userId", "nd_serverUrl", "nd_username",
        "nd_password", "nd_lastfmApiKey", "serverUrl", "username", "password", "apiKey", "userId", "_migrated"
    ]],
    ["Translate", ["deeplApiKey", "kagiSession"]],
    ["InvisibleChat", ["savedPasswords"]],
    ["MusicRichPresence", ["apiKey"]],
    ["AudioBookShelfRichPresence", ["serverUrl", "username", "password"]],
    ["JellyfinRichPresence", ["serverUrl", "apiKey", "userId"]]
]);
export function isLocalDataStoreKey(key: unknown) {
    if (LOCAL_DATASTORE_KEYS.has(key)) return true;
    if (typeof key !== "string") return false;
    if (key.startsWith("Vencord_cloudManifest:") || key.startsWith("VoiceMessageTranscriber_")) return true;
    if (!/^(?:VoiceStats_totals|ProfileDataset|ProfilePresets_v2_Main|ProfilePresets_v2_Server)(?::|$)/.test(key)) return false;
    const userId = UserStore.getCurrentUser()?.id;
    return !userId || ![
        `VoiceStats_totals:${userId}`, `VoiceStats_totals:recovered:${userId}`, `ProfileDataset:${userId}:main`,
        `ProfilePresets_v2_Main:${userId}`, `ProfilePresets_v2_Server:${userId}`
    ].includes(key);
}

function scopeAccountData(value: unknown) {
    if (value === undefined) return undefined;
    if (!isObject(value)) throw new Error("Account data must be an object.");
    const userId = UserStore.getCurrentUser()?.id;
    return userId && Object.hasOwn(value, userId) ? { [userId]: value[userId] } : {};
}

export function getCloudDataStoreEntries(entries: [IDBValidKey, unknown][]): [IDBValidKey, unknown][] {
    return entries.filter(([key]) => !isLocalDataStoreKey(key))
        .map(([key, value]) => [key, key === "ChannelTabs_bookmarks" ? scopeAccountData(value) : value]);
}

export function omitCloudSettings(settings: object) {
    const filtered = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "cloud"));
    if (isObject(filtered.plugins)) {
        const plugins = Object.fromEntries(Object.entries(filtered.plugins).map(([name, values]) => [name,
            isObject(values) ? Object.fromEntries(Object.entries(values).filter(([key]) => !LOCAL_PLUGIN_SETTINGS.get(name)?.includes(key))) : values
        ]));
        if (isObject(plugins.ChannelTabs) && "tabSet" in plugins.ChannelTabs) {
            plugins.ChannelTabs = { ...plugins.ChannelTabs, tabSet: scopeAccountData(plugins.ChannelTabs.tabSet) };
        }
        filtered.plugins = plugins;
    }
    return filtered;
}

const toast = (type: string, message: string) =>
    Toasts.show({
        type,
        message,
        id: Toasts.genId()
    });

const toastSuccess = () =>
    toast(Toasts.Type.SUCCESS, "Settings successfully imported. Restart to apply changes!");

const toastFailure = (err: unknown) =>
    toast(Toasts.Type.FAILURE, `Failed to import settings: ${String(err)}`);

const logger = new Logger("SettingsSync:Offline", "#39b7e0");

function deepMerge(target: object, source: object) {
    const values = target as Record<string, unknown>;
    for (const [key, value] of Object.entries(source)) {
        if (isObject(value)) {
            const current = values[key];
            const next = isObject(current) ? current : {};
            deepMerge(next, value);
            values[key] = next;
        } else {
            values[key] = value;
        }
    }
}

function isSafeObject(obj: unknown): boolean {
    if (obj == null || typeof obj !== "object") return true;

    for (const [key, value] of Object.entries(obj)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) {
            return false;
        }
        if (!isSafeObject(value)) {
            return false;
        }
    }

    return true;
}

function isDataStoreKey(key: unknown): key is IDBValidKey {
    return typeof key === "string" || (typeof key === "number" && !Number.isNaN(key))
        || (Array.isArray(key) && key.every(isDataStoreKey));
}

function validateSettingTypes(settings: object, defaults: object) {
    const values = settings as Record<string, unknown>;
    for (const [key, expected] of Object.entries(defaults)) {
        if (!Object.hasOwn(values, key) || expected === undefined) continue;
        const value = values[key];
        if (Array.isArray(expected)) {
            if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string"))
                throw new Error(`Invalid setting: ${key}.`);
        } else if (isObject(expected)) {
            if (!isObject(value)) throw new Error(`Invalid setting: ${key}.`);
            validateSettingTypes(value, expected);
        } else if (typeof value !== typeof expected || (typeof value === "number" && !Number.isFinite(value))) {
            throw new Error(`Invalid setting: ${key}.`);
        }
    }
}

export async function captureCloudImportState(syncDataStore = true) {
    const settings = JSON.stringify(VencordNative.settings.get());
    const quickCss = await VencordNative.quickCss.get();
    const entries = syncDataStore ? await DataStore.entries<IDBValidKey, unknown>() : [];
    return {
        settings,
        quickCss,
        dataStore: new Map(getCloudDataStoreEntries(entries.filter(([key]) => isDataStoreKey(key)))
            .map(([key, value]) => [JSON.stringify(key), value] as const))
    };
}

export async function importSettings(data: string, type: BackupType = "all", cloud = false, checkCurrent?: () => void, expected?: Awaited<ReturnType<typeof captureCloudImportState>>) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        throw new Error("Invalid settings backup JSON.");
    }

    if (!isObject(parsed) || !isSafeObject(parsed))
        throw new Error("Invalid settings backup.");

    let settings: object | undefined;
    let quickCss: string | undefined;
    let dataStore: [IDBValidKey, unknown][] | undefined;
    if (type === "all" || type === "plugins") {
        const value = "settings" in parsed ? parsed.settings : undefined;
        if (value !== undefined || type === "plugins" || !cloud) {
            if (!isObject(value)) throw new Error("Plugin settings must be an object.");
            validateSettingTypes(value, DefaultSettings);
            if ("plugins" in value && isObject(value.plugins) && Object.values(value.plugins).some((plugin: unknown) =>
                !isObject(plugin) || ("enabled" in plugin && typeof plugin.enabled !== "boolean"))) {
                throw new Error("Plugin settings must contain objects with boolean enabled flags.");
            }
            settings = cloud ? omitCloudSettings(value) : value;
        }
    }
    if (type === "all" || type === "css") {
        const value = "quickCss" in parsed ? parsed.quickCss : undefined;
        if (value !== undefined || type === "css") {
            if (typeof value !== "string") throw new Error("QuickCSS must be a string.");
            quickCss = value;
        }
    }
    if (type === "all" || type === "datastore") {
        const value = "dataStore" in parsed ? parsed.dataStore : undefined;
        if (value !== undefined || type === "datastore") {
            if (!Array.isArray(value) || !value.every((entry: unknown): entry is [IDBValidKey, unknown] =>
                Array.isArray(entry) && entry.length === 2 && isDataStoreKey(entry[0]))) {
                throw new Error("DataStore must contain valid key and value pairs.");
            }
            dataStore = cloud ? getCloudDataStoreEntries(value) : value;
        }
    }

    try {
        checkCurrent?.();
        if (settings) {
            const next: typeof PlainSettings = expected ? JSON.parse(expected.settings) : structuredClone(PlainSettings);
            deepMerge(next, settings);
            await VencordNative.settings.set(next, undefined, expected?.settings);
            checkCurrent?.();
            deepMerge(PlainSettings, settings);
            if (expected) expected.settings = JSON.stringify(next);
        }
        checkCurrent?.();
        if (quickCss !== undefined) {
            await VencordNative.quickCss.set(quickCss, expected?.quickCss);
            if (expected) expected.quickCss = quickCss;
        }
        checkCurrent?.();
        if (dataStore) {
            if (expected || (cloud && dataStore.some(([key]) => key === "ChannelTabs_bookmarks"))) {
                const entries = new Map(dataStore.map(entry => [JSON.stringify(entry[0]), entry]));
                await DataStore.updateMany([...entries.values()].map(([key, value]) => [key, (current: unknown) => {
                    checkCurrent?.();
                    const scoped = cloud && key === "ChannelTabs_bookmarks" ? scopeAccountData(current) : current;
                    if (expected) {
                        const previous = expected.dataStore.get(JSON.stringify(key));
                        if (scoped !== previous && (scoped === undefined || previous === undefined
                            || serializeDataStore([[key, scoped]]) !== serializeDataStore([[key, previous]])))
                            throw new Error("Stored data changed during sync. Try again to include your latest changes.");
                    }
                    return cloud && key === "ChannelTabs_bookmarks" && isObject(value)
                        ? { ...(isObject(current) ? current : {}), ...value }
                        : value;
                }]));
                for (const [key, value] of entries.values()) expected?.dataStore.set(JSON.stringify(key), value);
            } else {
                await DataStore.setMany(dataStore);
            }
        }
    } catch (cause) {
        throw new Error("Settings import did not finish. Some changes may already have been applied.", { cause });
    }
}

export async function exportSettings({ syncDataStore = true, type = "all", minify, cloud = false }: { syncDataStore?: boolean; type?: BackupType; minify?: boolean; cloud?: boolean; }) {
    let settings: object | undefined = type === "all" || type === "plugins" ? VencordNative.settings.get() : undefined;
    if (cloud && settings) settings = omitCloudSettings(settings);
    const quickCss = type === "all" || type === "css" ? await VencordNative.quickCss.get() : undefined;
    let dataStore = syncDataStore && (type === "all" || type === "datastore") ? await DataStore.entries() : undefined;
    if (cloud && dataStore) dataStore = getCloudDataStoreEntries(dataStore);
    if (dataStore) serializeDataStore(dataStore);

    switch (type) {
        case "all": {
            return JSON.stringify({ settings, quickCss, ...(dataStore && { dataStore }) }, null, minify ? undefined : 4);
        }
        case "plugins": {
            return JSON.stringify({ settings }, null, minify ? undefined : 4);
        }
        case "css": {
            return JSON.stringify({ quickCss }, null, minify ? undefined : 4);
        }
        case "datastore": {
            return JSON.stringify({ dataStore }, null, minify ? undefined : 4);
        }
    }
}

export function serializeDataStore(entries: [IDBValidKey, unknown][]): string {
    try {
        return JSON.stringify(entries, function (this: Record<string, unknown>, key: string) {
            const value = this[key];
            if (value === null || typeof value === "string" || typeof value === "boolean"
                || (typeof value === "number" && Number.isFinite(value))
                || (typeof value === "object" && (Array.isArray(value) || Object.prototype.toString.call(value) === "[object Object]"))) {
                return value;
            }
            throw new Error("Unsupported DataStore value.");
        });
    } catch {
        throw new Error("DataStore contains values that this JSON backup format cannot preserve.");
    }
}

export async function downloadSettingsBackup(type: BackupType = "all", { minify }: { minify?: boolean; } = {}) {
    try {
        const syncDataStore = type === "all" || type === "datastore";
        const backup = await exportSettings({ minify, type, syncDataStore });
        const filename = `lawyercord-${type}-backup-${moment().format("YYYY-MM-DD")}.json`;
        const data = new TextEncoder().encode(backup);

        if (IS_DISCORD_DESKTOP) {
            await DiscordNative.fileManager.saveWithDialog(data, filename);
        } else {
            saveFile(new File([data], filename, { type: "application/json" }));
        }
    } catch (err) {
        logger.error("Failed to export settings:", err);
        toast(Toasts.Type.FAILURE, `Failed to export settings: ${String(err)}`);
        throw err;
    }
}

export async function uploadSettingsBackup(type: BackupType = "all", showToast = true): Promise<void> {
    try {
        let data: string;
        if (IS_DISCORD_DESKTOP) {
            const [file] = await DiscordNative.fileManager.openFiles({
                filters: [
                    { name: "LawyerCord Settings Backup", extensions: ["json"] },
                    { name: "all", extensions: ["*"] }
                ]
            });
            if (!file) return;
            data = new TextDecoder().decode(file.data);
        } else {
            const file = await chooseFile("application/json");
            if (!file) return;
            data = await file.text();
        }
        await importSettings(data, type);
        if (showToast) toastSuccess();
    } catch (err) {
        logger.error(err);
        if (showToast) toastFailure(err);
    }
}
