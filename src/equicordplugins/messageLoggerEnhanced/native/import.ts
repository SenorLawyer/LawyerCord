/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { FileHandle, open } from "node:fs/promises";

import { Logger } from "@utils/Logger";
import { dialog, IpcMainInvokeEvent } from "electron";

interface ImportFile {
    fileHandle: FileHandle;
    decoder: TextDecoder;
    sender: IpcMainInvokeEvent["sender"];
    busy: boolean;
    cancel(): void;
    timer: ReturnType<typeof setTimeout>;
}

const activeFiles = new Map<string, ImportFile>();
const starting = new Map<number, object>();
const logger = new Logger("MessageLoggerEnhanced");

async function closeImport(id: string) {
    const entry = activeFiles.get(id);
    if (!entry) return;
    activeFiles.delete(id);
    clearTimeout(entry.timer);
    entry.sender.removeListener("destroyed", entry.cancel);
    entry.sender.removeListener("render-process-gone", entry.cancel);
    try {
        await entry.fileHandle.close();
    } catch {
        throw new Error("Could not close the log import.");
    }
}

export async function startNativeLogImport(event: IpcMainInvokeEvent, defaultPath?: string) {
    if (starting.has(event.sender.id) || [...activeFiles.values()].some(entry => entry.sender === event.sender))
        throw new Error("A log import is already open.");
    const request = {};
    starting.set(event.sender.id, request);
    const cancelStart = () => { if (starting.get(event.sender.id) === request) starting.delete(event.sender.id); };
    event.sender.once("destroyed", cancelStart);
    event.sender.once("render-process-gone", cancelStart);
    try {
        const res = await dialog.showOpenDialog({
            title: "Import Logs",
            filters: [{ name: "Logs", extensions: ["json"] }],
            properties: ["openFile"],
            defaultPath: typeof defaultPath === "string" && defaultPath.length <= 4096 ? defaultPath : undefined
        });
        const [path] = res.filePaths;
        if (!path || event.sender.isDestroyed() || starting.get(event.sender.id) !== request) throw new Error("No file selected.");
        const fileHandle = await open(path, "r");
        const id = randomUUID();
        const cancel = () => { void closeImport(id).catch(() => logger.warn("Could not close a log import.")); };
        const timer = setTimeout(cancel, 300_000);
        timer.unref();
        activeFiles.set(id, { fileHandle, decoder: new TextDecoder(), sender: event.sender, busy: false, cancel, timer });
        event.sender.once("destroyed", cancel);
        event.sender.once("render-process-gone", cancel);
        if (event.sender.isDestroyed() || starting.get(event.sender.id) !== request) {
            await closeImport(id);
            throw new Error("The log import was cancelled.");
        }
        return id;
    } catch {
        throw new Error("Could not open the log import.");
    } finally {
        event.sender.removeListener("destroyed", cancelStart);
        event.sender.removeListener("render-process-gone", cancelStart);
        if (starting.get(event.sender.id) === request) starting.delete(event.sender.id);
    }
}

export async function readNativeLogChunk(event: IpcMainInvokeEvent, id: string): Promise<string | null> {
    const entry = activeFiles.get(id);
    if (!entry || entry.sender !== event.sender || entry.busy) throw new Error("The log import is unavailable.");
    entry.busy = true;
    entry.timer.refresh();
    try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await entry.fileHandle.read(buffer, 0, buffer.length);
        if (activeFiles.get(id) !== entry) throw new Error("The log import was cancelled.");
        if (bytesRead === 0) {
            const tail = entry.decoder.decode();
            await closeImport(id);
            return tail || null;
        }
        return entry.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    } catch {
        await closeImport(id);
        throw new Error("Could not read the log import.");
    } finally {
        entry.busy = false;
    }
}

export async function closeNativeLogImport(event: IpcMainInvokeEvent, id: string) {
    if (activeFiles.get(id)?.sender === event.sender) await closeImport(id);
}

export async function closeNativeLogImports(event: IpcMainInvokeEvent) {
    starting.delete(event.sender.id);
    await Promise.all([...activeFiles].filter(([, entry]) => entry.sender === event.sender).map(([id]) => closeImport(id)));
}
