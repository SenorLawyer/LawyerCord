/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Settings } from "@api/Settings";
import { IpcEvents } from "@shared/IpcEvents";
import { SettingsStore } from "@shared/SettingsStore";
import { mergeDefaults } from "@utils/mergeDefaults";
import { randomUUID } from "crypto";
import { ipcMain, type WebContents } from "electron";
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

const settingsSessions = new WeakMap<WebContents, { token: string; revision: number; }>();
ipcMain.on(IpcEvents.GET_SETTINGS_SESSION, event => {
    const token = randomUUID();
    settingsSessions.set(event.sender, { token, revision: 0 });
    event.returnValue = token;
});

function setRendererSettings(event: { sender: WebContents; }, data: Settings, pathToNotify?: string | string[], expected?: string, revision?: number, token?: string) {
    if (typeof data !== "object" || data === null || Array.isArray(data)
        || pathToNotify !== undefined && typeof pathToNotify !== "string" && !(Array.isArray(pathToNotify) && pathToNotify.length <= 256 && pathToNotify.every(path => typeof path === "string"))
        || expected !== undefined && typeof expected !== "string")
        throw new Error("Invalid settings data.");
    const session = settingsSessions.get(event.sender);
    if (revision !== undefined) {
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid settings revision.");
        if (!session || session.token !== token || revision <= session.revision) return;
    }
    if (expected !== undefined && JSON.stringify(RendererSettings.plain) !== expected)
        throw new Error("Settings changed during sync. Try again to include your latest changes.");
    try {
        writeSettings(SETTINGS_FILE, data);
    } catch (e) {
        console.error("Failed to write renderer settings", e);
        throw new Error("Failed to save settings.");
    }
    if (session && revision !== undefined) session.revision = revision;
    RendererSettings.setData(data, pathToNotify);
}

ipcMain.handle(IpcEvents.SET_SETTINGS, setRendererSettings);
ipcMain.on(IpcEvents.SET_SETTINGS, (event, data, paths, expected, revision, token) => {
    try {
        setRendererSettings(event, data, paths, expected, revision, token);
        event.returnValue = null;
    } catch {
        event.returnValue = "Failed to save settings.";
    }
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
