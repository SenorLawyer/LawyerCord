/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { FileHandle, open } from "node:fs/promises";

import { dialog, IpcMainInvokeEvent } from "electron";

const activeFiles = new Map<string, { fileHandle: FileHandle; decoder: TextDecoder; }>();

export async function startNativeLogImport(_event: IpcMainInvokeEvent, defaultPath?: string) {
    const res = await dialog.showOpenDialog({
        title: "Import Logs",
        filters: [{ name: "Logs", extensions: ["json"] }],
        properties: ["openFile"],
        defaultPath
    });
    const [path] = res.filePaths;

    if (!path) throw Error("No file selected");

    const fileHandle = await open(path, "r");
    const fileId = randomUUID();
    activeFiles.set(fileId, { fileHandle, decoder: new TextDecoder() });

    return fileId;
}

export async function readNativeLogChunk(_event: IpcMainInvokeEvent, fileId: string): Promise<string | null> {
    const file = activeFiles.get(fileId);
    if (!file) return null;
    const { fileHandle, decoder } = file;

    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length);

    if (bytesRead === 0) {
        await fileHandle.close();
        activeFiles.delete(fileId);
        return decoder.decode() || null;
    }

    return decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
}

export async function closeNativeLogImport(_event: IpcMainInvokeEvent, fileId: string) {
    const file = activeFiles.get(fileId);
    if (file) {
        await file.fileHandle.close();
        activeFiles.delete(fileId);
    }
}
