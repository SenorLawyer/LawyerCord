/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ensureSafePath } from "@main/ipcMain";
import { THEMES_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent } from "electron";
import { existsSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import type { Theme } from "./types";

function getThemePath(theme: Pick<Theme, "name">): string | null {
    if (typeof theme?.name !== "string" || !theme.name || /[/\\:]/.test(theme.name) || theme.name.includes("\0")) return null;
    return ensureSafePath(THEMES_DIR, `${theme.name}.theme.css`);
}

export async function themeExists(_: IpcMainInvokeEvent, theme: Pick<Theme, "name">) {
    const path = getThemePath(theme);
    return path ? existsSync(path) : false;
}

export async function downloadTheme(_: IpcMainInvokeEvent, theme: Pick<Theme, "id" | "name">) {
    const path = getThemePath(theme);
    const validId = typeof theme?.id === "number"
        ? Number.isSafeInteger(theme.id) && theme.id > 0
        : typeof theme?.id === "string" && theme.id.length > 0;
    if (!path || !validId) throw new Error("Invalid theme details.");

    try {
        const maxBytes = 10 * 1024 * 1024;
        const download = await fetch(`https://themes.equicord.org/api/download/${encodeURIComponent(theme.id)}`, {
            redirect: "error", signal: AbortSignal.timeout(30_000)
        });
        if (!download.ok || !download.body || Number(download.headers.get("content-length")) > maxBytes) {
            await download.body?.cancel();
            throw new Error("Theme download failed.");
        }
        const reader = download.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel();
                    throw new Error("Theme download failed.");
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        const temporaryDirectory = mkdtempSync(join(THEMES_DIR, ".theme-"));
        const temporaryFile = join(temporaryDirectory, "theme.css");
        try {
            writeFileSync(temporaryFile, Buffer.concat(chunks, size).toString("utf8"));
            renameSync(temporaryFile, path);
        } finally {
            rmSync(temporaryFile, { force: true });
            rmdirSync(temporaryDirectory);
        }
    } catch {
        throw new Error("Theme download failed.");
    }
}
