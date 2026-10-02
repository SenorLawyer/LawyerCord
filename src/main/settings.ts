/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Settings } from "@api/Settings";
import { IpcEvents } from "@shared/IpcEvents";
import { SettingsStore } from "@shared/SettingsStore";
import { mergeDefaults } from "@utils/mergeDefaults";
import { ipcMain } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";

import { NATIVE_SETTINGS_FILE, SETTINGS_DIR, SETTINGS_FILE } from "./utils/constants";

mkdirSync(SETTINGS_DIR, { recursive: true });

function readSettings<T = object>(name: string, file: string): Partial<T> {
    try {
        const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
        if (typeof data !== "object" || data === null || Array.isArray(data))
            throw new Error("Settings must contain an object.");
        return data as Partial<T>;
    } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT"))
            console.error(`Failed to read ${name} settings`, err);

        return {};
    }
}

function writeSettings(file: string, data: object) {
    const temporaryFile = `${file}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(data, null, 4));
    renameSync(temporaryFile, file);
}

export const RendererSettings = new SettingsStore(readSettings<Settings>("renderer", SETTINGS_FILE));

ipcMain.handle(IpcEvents.GET_SETTINGS_DIR, () => SETTINGS_DIR);
ipcMain.on(IpcEvents.GET_SETTINGS, e => e.returnValue = RendererSettings.plain);

ipcMain.handle(IpcEvents.SET_SETTINGS, (_, data: Settings, pathToNotify?: string, expected?: string) => {
    if (typeof data !== "object" || data === null || Array.isArray(data)
        || pathToNotify !== undefined && typeof pathToNotify !== "string"
        || expected !== undefined && typeof expected !== "string")
        throw new Error("Invalid settings data.");
    if (expected !== undefined && JSON.stringify(RendererSettings.plain) !== expected)
        throw new Error("Settings changed during sync. Try again to include your latest changes.");
    try {
        writeSettings(SETTINGS_FILE, data);
    } catch (e) {
        console.error("Failed to write renderer settings", e);
        throw new Error("Failed to save settings.");
    }
    RendererSettings.setData(data, pathToNotify);
});

export interface NativeSettings {
    plugins: {
        [plugin: string]: {
            [setting: string]: unknown;
        };
    };
    customCspRules: Record<string, string[]>;
}

const DefaultNativeSettings: NativeSettings = {
    plugins: {},
    customCspRules: {}
};

const nativeSettings = readSettings<NativeSettings>("native", NATIVE_SETTINGS_FILE);
mergeDefaults(nativeSettings, DefaultNativeSettings);

export const NativeSettings = new SettingsStore(nativeSettings as NativeSettings);

NativeSettings.addGlobalChangeListener(() => {
    try {
        writeSettings(NATIVE_SETTINGS_FILE, NativeSettings.plain);
    } catch (e) {
        console.error("Failed to write native settings", e);
    }
});
