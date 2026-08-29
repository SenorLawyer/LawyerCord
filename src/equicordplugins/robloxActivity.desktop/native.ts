/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { exec as nodeExec } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { promisify } from "util";

const exec = promisify(nodeExec);

export async function isRobloxRunning(_event: IpcMainInvokeEvent): Promise<boolean | null> {
    if (process.platform !== "win32") return null;

    try {
        const { stdout } = await exec('tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe"', { windowsHide: true });
        return stdout.toLowerCase().includes("robloxplayerbeta.exe");
    } catch {
        return null;
    }
}
