/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { FileHandle, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Logger } from "@utils/Logger";
import { dialog, IpcMainInvokeEvent } from "electron";

interface ExportFile {
    file: FileHandle;
    temporary: string;
    destination: string;
    sender: IpcMainInvokeEvent["sender"];
    busy: boolean;
    cancel(): void;
    timer: ReturnType<typeof setTimeout>;
}

const activeFiles = new Map<string, ExportFile>();
const starting = new Map<number, object>();
const logger = new Logger("MessageLoggerEnhanced");

async function discardExport(id: string) {
    const entry = activeFiles.get(id);
    if (!entry) return;
    activeFiles.delete(id);
    clearTimeout(entry.timer);
    entry.sender.removeListener("destroyed", entry.cancel);
    entry.sender.removeListener("render-process-gone", entry.cancel);
    try {
        await entry.file.close();
    } catch {
        logger.warn("Could not close an incomplete log export.");
    } finally {
        await unlink(entry.temporary).catch(() => logger.warn("Could not remove an incomplete log export."));
    }
}

export async function startNativeLogExport(event: IpcMainInvokeEvent, filename: unknown) {
    if (starting.has(event.sender.id) || [...activeFiles.values()].some(entry => entry.sender === event.sender))
        throw new Error("A log export is already open.");
    const request = {};
    starting.set(event.sender.id, request);
    const cancelStart = () => { if (starting.get(event.sender.id) === request) starting.delete(event.sender.id); };
    event.sender.once("destroyed", cancelStart);
    event.sender.once("render-process-gone", cancelStart);
    try {
        const { filePath, canceled } = await dialog.showSaveDialog({
            defaultPath: typeof filename === "string" && filename.length <= 255 ? filename : "message-logger-logs-idb.json",
            filters: [{ name: "JSON", extensions: ["json"] }]
        });
        if (canceled || !filePath || event.sender.isDestroyed() || starting.get(event.sender.id) !== request) throw new Error("No file path selected.");
        const id = randomUUID();
        const temporary = join(dirname(filePath), `.${id}.tmp`);
        const file = await open(temporary, "wx");
        const cancel = () => { void discardExport(id).catch(() => logger.warn("Could not close a log export.")); };
        const timer = setTimeout(cancel, 300_000);
        timer.unref();
        activeFiles.set(id, { file, temporary, destination: filePath, sender: event.sender, busy: false, cancel, timer });
        event.sender.once("destroyed", cancel);
        event.sender.once("render-process-gone", cancel);
        if (event.sender.isDestroyed() || starting.get(event.sender.id) !== request) {
            await discardExport(id);
            throw new Error("The log export was cancelled.");
        }
        return id;
    } catch {
        throw new Error("Could not start the log export.");
    } finally {
        event.sender.removeListener("destroyed", cancelStart);
        event.sender.removeListener("render-process-gone", cancelStart);
        if (starting.get(event.sender.id) === request) starting.delete(event.sender.id);
    }
}

export async function writeNativeLogChunk(event: IpcMainInvokeEvent, id: string, chunk: unknown) {
    const entry = activeFiles.get(id);
    if (!entry || entry.sender !== event.sender || entry.busy) throw new Error("The log export is unavailable.");
    if (typeof chunk !== "string" || chunk.length > 16 * 1024 * 1024) throw new Error("The log chunk is too large.");
    entry.busy = true;
    entry.timer.refresh();
    try {
        await entry.file.writeFile(chunk, "utf8");
        if (activeFiles.get(id) !== entry) throw new Error("The log export was cancelled.");
    } catch {
        await discardExport(id);
        throw new Error("Could not write the log export.");
    } finally {
        entry.busy = false;
    }
}

export async function finishNativeLogExport(event: IpcMainInvokeEvent, id: string) {
    const entry = activeFiles.get(id);
    if (!entry || entry.sender !== event.sender || entry.busy) throw new Error("The log export is unavailable.");
    entry.busy = true;
    try {
        await entry.file.sync();
        await entry.file.close();
        if (activeFiles.get(id) !== entry) throw new Error("The log export was cancelled.");
        await rename(entry.temporary, entry.destination);
        activeFiles.delete(id);
        clearTimeout(entry.timer);
        entry.sender.removeListener("destroyed", entry.cancel);
        entry.sender.removeListener("render-process-gone", entry.cancel);
    } catch {
        await discardExport(id);
        throw new Error("Could not finish the log export.");
    }
}

export async function cancelNativeLogExport(event: IpcMainInvokeEvent, id: string) {
    if (activeFiles.get(id)?.sender === event.sender) await discardExport(id);
}

export async function cancelNativeLogExports(event: IpcMainInvokeEvent) {
    starting.delete(event.sender.id);
    await Promise.all([...activeFiles].filter(([, entry]) => entry.sender === event.sender).map(([id]) => discardExport(id)));
}
