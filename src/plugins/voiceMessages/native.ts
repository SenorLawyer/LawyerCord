/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent } from "electron";
import { readFile, rm } from "fs/promises";
import { basename, normalize } from "path";

export async function readRecording(_: IpcMainInvokeEvent, filePath: string) {
    if (typeof filePath !== "string") return null;
    filePath = normalize(filePath);
    const filename = basename(filePath);
    const discordBaseDirWithTrailingSlash = normalize(app.getPath("userData") + "/");
    if (!/^\d*recording\.ogg$/.test(filename) || !filePath.startsWith(discordBaseDirWithTrailingSlash)) return null;

    try {
        const buf = await readFile(filePath);
        rm(filePath).catch(() => { });
        return Uint8Array.from(buf);
    } catch {
        return null;
    }
}
