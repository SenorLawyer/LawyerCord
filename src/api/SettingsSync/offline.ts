/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DefaultSettings, PlainSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import { chooseFile, saveFile } from "@utils/web";
import { moment, Toasts } from "@webpack/common";

import { DataStore } from "..";

type BackupType = "all" | "plugins" | "css" | "datastore";
const LOCAL_DATASTORE_KEYS = new Set<unknown>(["Vencord_cloudSecret", "Vencord_cloudManifest", "Vencord_cloudApiVersions"]);
export const isLocalDataStoreKey = (key: unknown) => LOCAL_DATASTORE_KEYS.has(key);

export const omitCloudSettings = (settings: object) => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "cloud"));

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

export async function importSettings(data: string, type: BackupType = "all", cloud = false, checkCurrent?: () => void) {
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
            dataStore = cloud ? value.filter(([key]) => !isLocalDataStoreKey(key)) : value;
        }
    }

    try {
        checkCurrent?.();
        if (settings) {
            deepMerge(PlainSettings, settings);
            await VencordNative.settings.set(PlainSettings);
        }
        checkCurrent?.();
        if (quickCss !== undefined) await VencordNative.quickCss.set(quickCss);
        checkCurrent?.();
        if (dataStore) await DataStore.setMany(dataStore);
    } catch (cause) {
        throw new Error("Settings import did not finish. Some changes may already have been applied.", { cause });
    }
}

export async function exportSettings({ syncDataStore = true, type = "all", minify, cloud = false }: { syncDataStore?: boolean; type?: BackupType; minify?: boolean; cloud?: boolean; }) {
    let settings: object | undefined = type === "all" || type === "plugins" ? VencordNative.settings.get() : undefined;
    if (cloud && settings) settings = omitCloudSettings(settings);
    const quickCss = type === "all" || type === "css" ? await VencordNative.quickCss.get() : undefined;
    const dataStore = syncDataStore && (type === "all" || type === "datastore") ? await DataStore.entries() : undefined;
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
