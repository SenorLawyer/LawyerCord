/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ensureSafePath } from "@main/ipcMain";
import { THEMES_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent } from "electron";
import { existsSync, writeFileSync } from "fs";

import type { Theme } from "./types";

function getThemePath(theme: Pick<Theme, "name">): string | null {
    if (typeof theme?.name !== "string" || !theme.name) return null;
    return ensureSafePath(THEMES_DIR, `${theme.name}.theme.css`);
}

export async function themeExists(_: IpcMainInvokeEvent, theme: Pick<Theme, "name">) {
    const path = getThemePath(theme);
    return path ? existsSync(path) : false;
}

export async function downloadTheme(_: IpcMainInvokeEvent, theme: Pick<Theme, "id" | "name">) {
    const path = getThemePath(theme);
    if (!path || typeof theme?.id !== "string" || !theme.id) throw new Error("Invalid theme details.");

    try {
        const download = await fetch(`https://themes.equicord.org/api/download/${encodeURIComponent(theme.id)}`);
        if (!download.ok) throw new Error("Theme download failed.");
        const content = await download.text();
        writeFileSync(path, content);
    } catch {
        throw new Error("Theme download failed.");
    }
}
