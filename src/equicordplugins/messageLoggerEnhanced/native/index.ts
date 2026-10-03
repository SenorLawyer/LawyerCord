/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { Logger } from "@utils/Logger";
import { dialog, IpcMainInvokeEvent, shell } from "electron";

import { getSettings, saveSettings } from "./settings";
export * from "./export";
export * from "./import";

import { blockedExts } from "../list";
import { DEFAULT_ATTACHMENT_FILE_EXTENSIONS } from "../utils/constants";
import { ensureDirectoryExists, getAttachmentIdFromFilename, sleep } from "./utils";

export { getSettings };
export function messageLoggerEnhancedUniqueIdThingyIdkMan() { }

const nativeSavedImages = new Map<string, string>();
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const logger = new Logger("MessageLoggerEnhanced");
interface DownloadResult { error: string | null; path: string | null; busy?: true; }
interface Attachment { id: string; fileExtension: string; url: URL; oldUrl: URL; }
interface Download {
    key: string;
    controller: AbortController;
    owners: Map<IpcMainInvokeEvent["sender"], { promise: Promise<DownloadResult>; resolve: (result: DownloadResult) => void; }>;
}
interface DownloadOwner {
    cancel: () => void;
    waiter?: { promise: Promise<boolean>; resolve: (available: boolean) => void; };
}
const MAX_DOWNLOADS = 4;
const downloads = new Map<string, Download>();
const downloadOwners = new Map<IpcMainInvokeEvent["sender"], DownloadOwner>();
let imageScan = 0;

let imageCacheDir: string;
let directoryInit: Promise<void> | undefined;
let directoryRevision = 0;

const getImageCacheDir = async () => {
    if (!imageCacheDir) await (directoryInit ??= initDirs().finally(() => directoryInit = undefined));
    return imageCacheDir;
};

export async function initDirs() {
    const revision = ++directoryRevision;
    const { imageCacheDir: icd } = await getSettings();

    const dir = icd || await getDefaultNativeImageDir();
    await ensureDirectoryExists(dir);
    const root = await realpath(dir);
    if (revision !== directoryRevision) return;
    imageCacheDir = root;
    for (const work of downloads.values()) {
        if (!work.key.startsWith("\0")) continue;
        downloads.delete(work.key);
        work.key = imageCacheDir + work.key;
        downloads.set(work.key, work);
    }
}

export async function init(_event: IpcMainInvokeEvent) {
    const scan = ++imageScan;
    const imageDir = await getImageCacheDir();

    await ensureDirectoryExists(imageDir);
    const files = await readdir(imageDir, { withFileTypes: true });
    if (scan !== imageScan) return;
    nativeSavedImages.clear();
    for (const file of files) {
        if (!file.isFile()) continue;
        const filename = file.name;
        if (!/^\d{1,20}\.[a-z0-9]{1,16}$/i.test(filename)) continue;
        const attachmentId = getAttachmentIdFromFilename(filename);
        nativeSavedImages.set(attachmentId, path.join(imageDir, filename));
    }
}

export async function getImageNative(_event: IpcMainInvokeEvent, attachmentId: unknown): Promise<Uint8Array<ArrayBuffer> | null> {
    if (typeof attachmentId !== "string" || !/^\d{1,20}$/.test(attachmentId)) return null;
    const imagePath = nativeSavedImages.get(attachmentId);
    if (!imagePath) return null;

    try {
        const root = await realpath(await getImageCacheDir());
        const resolved = await realpath(imagePath);
        if (!resolved.startsWith(path.join(root, path.sep))) return null;
        const file = await open(resolved, "r");
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null;
            const buffer = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < buffer.length) {
                const { bytesRead } = await file.read(buffer, offset, buffer.length - offset);
                if (!bytesRead) return null;
                offset += bytesRead;
            }
            return buffer;
        } finally {
            await file.close();
        }
    } catch {
        logger.warn("Could not read a cached attachment.");
        return null;
    }
}

export async function deleteFileNative(_event: IpcMainInvokeEvent, attachmentId: string) {
    const imagePath = nativeSavedImages.get(attachmentId);
    if (!imagePath) return;

    await unlink(imagePath);
    nativeSavedImages.delete(attachmentId);
}

export async function getDefaultNativeImageDir(): Promise<string> {
    return path.join(await getDefaultNativeDataDir(), "savedImages");
}

export async function getDefaultNativeDataDir(): Promise<string> {
    return path.join(DATA_DIR, "MessageLoggerData");
}

export async function getDefaultAttachmentFileExtensions(): Promise<string> {
    return DEFAULT_ATTACHMENT_FILE_EXTENSIONS;
}

export async function chooseDir(event: IpcMainInvokeEvent, logKey: "logsDir" | "imageCacheDir") {
    if (logKey !== "logsDir" && logKey !== "imageCacheDir") throw new Error("Invalid directory setting.");
    const settings = await getSettings();
    const defaultPath = settings[logKey] || await getDefaultNativeDataDir();

    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath });
    const dir = res.filePaths[0];

    if (!dir) throw Error("Invalid Directory");

    settings[logKey] = dir;

    await saveSettings(settings);

    if (logKey === "imageCacheDir") {
        const root = await realpath(dir);
        directoryRevision++;
        for (const work of downloads.values()) work.controller.abort();
        nativeSavedImages.clear();
        imageCacheDir = root;
        await init(event);
    }

    return dir;
}

export async function showItemInFolder(_event: IpcMainInvokeEvent) {
    shell.showItemInFolder(await getImageCacheDir());
}

export async function chooseFile(_event: IpcMainInvokeEvent, title: string, filters: Electron.FileFilter[], defaultPath?: string) {
    const res = await dialog.showOpenDialog({ title, filters, properties: ["openFile"], defaultPath });
    const [path] = res.filePaths;

    if (!path) throw Error("Invalid file");

    return await readFile(path, "utf-8");
}

function releaseDownloadOwner(sender: IpcMainInvokeEvent["sender"]) {
    const owner = downloadOwners.get(sender);
    if (!owner || owner.waiter || [...downloads.values()].some(work => work.owners.has(sender))) return;
    sender.removeListener("destroyed", owner.cancel);
    sender.removeListener("render-process-gone", owner.cancel);
    downloadOwners.delete(sender);
}

function getDownloadOwner(sender: IpcMainInvokeEvent["sender"]) {
    let owner = downloadOwners.get(sender);
    if (!owner) {
        owner = { cancel: () => cancelDownloads(sender) };
        downloadOwners.set(sender, owner);
        sender.once("destroyed", owner.cancel);
        sender.once("render-process-gone", owner.cancel);
    }
    return owner;
}

function cancelDownloads(sender: IpcMainInvokeEvent["sender"]) {
    for (const work of downloads.values()) {
        const owner = work.owners.get(sender);
        if (!owner) continue;
        work.owners.delete(sender);
        owner.resolve({ error: "Attachment download was cancelled.", path: null });
        if (!work.owners.size) work.controller.abort();
    }
    const owner = downloadOwners.get(sender);
    owner?.waiter?.resolve(false);
    if (owner) owner.waiter = undefined;
    releaseDownloadOwner(sender);
}

export function waitForAttachmentDownloadCapacity(event: IpcMainInvokeEvent): Promise<boolean> {
    if (event.sender.isDestroyed()) return Promise.resolve(false);
    if (downloads.size < MAX_DOWNLOADS && ![...downloads.values()].some(work => work.controller.signal.aborted)) return Promise.resolve(true);
    const owner = getDownloadOwner(event.sender);
    if (!owner.waiter) {
        let resolve: (available: boolean) => void = () => {};
        const promise = new Promise<boolean>(done => resolve = done);
        owner.waiter = { promise, resolve };
    }
    return owner.waiter.promise;
}

function getDownloadResult(work: Download, sender: IpcMainInvokeEvent["sender"]) {
    let result = work.owners.get(sender);
    if (!result) {
        getDownloadOwner(sender);
        let resolve: (result: DownloadResult) => void = () => {};
        const promise = new Promise<DownloadResult>(done => resolve = done);
        result = { promise, resolve };
        work.owners.set(sender, result);
    }
    return result.promise;
}

export function downloadAttachment(event: IpcMainInvokeEvent, attachment: unknown): Promise<DownloadResult> {
    return tryDownloadAttachment(event, attachment);
}

export function tryDownloadAttachment(event: IpcMainInvokeEvent, attachment: unknown): Promise<DownloadResult> {
    if (!attachment || typeof attachment !== "object"
        || !("id" in attachment) || typeof attachment.id !== "string" || !/^\d{1,20}$/.test(attachment.id)
        || !("fileExtension" in attachment) || typeof attachment.fileExtension !== "string" || !/^\.?[a-z0-9]{1,16}$/i.test(attachment.fileExtension)
        || !("url" in attachment) || !("oldUrl" in attachment))
        return Promise.resolve({ error: "Invalid attachment.", path: null });
    const urls = [attachment.url, attachment.oldUrl].map(value => {
        if (typeof value !== "string" || value.length > 8192) return null;
        const url = URL.parse(value);
        return url?.protocol === "https:" && !url.port && !url.username && !url.password
            && ["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"].includes(url.hostname) ? url : null;
    });
    const [url, oldUrl] = urls;
    if (!url || !oldUrl) return Promise.resolve({ error: "Invalid attachment URL.", path: null });
    if (event.sender.isDestroyed()) return Promise.resolve({ error: "Attachment download was cancelled.", path: null });
    const fileExtension = attachment.fileExtension.replace(/^\./, "").toLowerCase();
    const key = `${imageCacheDir ?? ""}\0${attachment.id}.${fileExtension}`;
    const pending = downloads.get(key);
    if (pending && !pending.controller.signal.aborted) return getDownloadResult(pending, event.sender);
    if (pending || downloads.size >= MAX_DOWNLOADS)
        return Promise.resolve({ error: "Attachment downloads are busy. Retry when capacity is available.", path: null, busy: true });
    const controller = new AbortController();
    const work: Download = { key, controller, owners: new Map() };
    downloads.set(key, work);
    const result = getDownloadResult(work, event.sender);
    void downloadAttachmentFile({ id: attachment.id, fileExtension, url, oldUrl }, controller.signal).then(result => {
        controller.abort();
        downloads.delete(work.key);
        for (const [sender, owner] of work.owners) {
            releaseDownloadOwner(sender);
            owner.resolve(result);
        }
        for (const [sender, owner] of downloadOwners) {
            if (!owner.waiter) continue;
            owner.waiter.resolve(true);
            owner.waiter = undefined;
            releaseDownloadOwner(sender);
        }
    });
    return result;
}

export function cancelNativeAttachmentDownloads(event: IpcMainInvokeEvent) {
    cancelDownloads(event.sender);
}

async function downloadAttachmentFile(attachment: Attachment, cancelled: AbortSignal): Promise<DownloadResult> {
    let temporaryPath: string | undefined;
    let response: Response | undefined;
    try {
        const root = await getImageCacheDir();
        cancelled.throwIfAborted();
        const { url, oldUrl, fileExtension: cleanExt } = attachment;
        const settings = await getSettings();
        cancelled.throwIfAborted();
        const allowedExtensionsStr = settings.attachmentFileExtensions?.trim() || "";
        if (allowedExtensionsStr === "" || allowedExtensionsStr.toLowerCase() === "none") {
            return { error: "All attachment downloads are currently blocked by settings configurations.", path: null };
        }

        const allowedList = allowedExtensionsStr.split(",").map((ext: string) => ext.trim().toLowerCase());

        if (blockedExts.includes(cleanExt) || !allowedList.includes(cleanExt)) {
            return { error: `File type .${cleanExt} is blocked by settings configurations.`, path: null };
        }

        const existingImage = nativeSavedImages.get(attachment.id);
        if (existingImage === path.join(root, `${attachment.id}.${cleanExt}`))
            return {
                error: null,
                path: existingImage
            };

        const signal = AbortSignal.any([cancelled, AbortSignal.timeout(120_000)]);
        const maxBytes = MAX_ATTACHMENT_BYTES;
        let downloadUrl = url;
        for (let attempt = 0; attempt < 4; attempt++) {
            signal.throwIfAborted();
            const res = response = await fetch(downloadUrl, { redirect: "error", signal });
            signal.throwIfAborted();
            if (res.status !== 200) {
                await res.body?.cancel();
                response = undefined;
                if (attempt === 3) return { error: "Could not download this attachment.", path: null };
                if ([403, 404, 415].includes(res.status)) downloadUrl = oldUrl;
                await sleep(1000);
                continue;
            }
            if (!res.body || Number(res.headers.get("content-length")) > maxBytes) {
                await res.body?.cancel();
                response = undefined;
                return { error: "Attachment exceeds the download limit.", path: null };
            }

            const finalPath = path.resolve(root, `${attachment.id}.${cleanExt}`);
            if (!finalPath.startsWith(path.join(root, path.sep))) return { error: "Invalid attachment path.", path: null };
            await ensureDirectoryExists(root);
            temporaryPath = path.join(root, `${randomUUID()}.tmp`);
            const file = await open(temporaryPath, "wx");
            const reader = res.body.getReader();
            let bytes = 0;
            try {
                for (;;) {
                    signal.throwIfAborted();
                    const { done, value } = await reader.read();
                    signal.throwIfAborted();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > maxBytes) throw new Error("Attachment exceeds the download limit.");
                    await file.writeFile(value);
                }
            } finally {
                try { await file.close(); }
                finally {
                    try { await reader.cancel(); }
                    finally { reader.releaseLock(); response = undefined; }
                }
            }
            signal.throwIfAborted();
            await rename(temporaryPath, finalPath);
            temporaryPath = undefined;
            signal.throwIfAborted();
            nativeSavedImages.set(attachment.id, finalPath);
            return { error: null, path: finalPath };
        }
        return { error: "Could not download this attachment.", path: null };
    } catch {
        if (cancelled.aborted) return { error: "Attachment download was interrupted. Retry when capacity is available.", path: null, busy: true };
        return { error: "Could not download this attachment.", path: null };
    } finally {
        try { await response?.body?.cancel().catch(() => logger.warn("Could not close an attachment response.")); }
        finally {
            if (temporaryPath) await unlink(temporaryPath).catch(() => logger.warn("Could not remove an incomplete attachment."));
        }
    }
}

export async function updateAllowedExtensions(_event: IpcMainInvokeEvent, cleanExtensionsString: unknown) {
    if (cleanExtensionsString !== undefined && (typeof cleanExtensionsString !== "string" || cleanExtensionsString.length > 4096)) return;
    const settings = await getSettings();
    const incomingRaw = cleanExtensionsString?.trim() || "";

    if (incomingRaw === "") {
        settings.attachmentFileExtensions = "none";
        await saveSettings(settings);
        return;
    }

    const validatedExtensions = incomingRaw
        .split(",")
        .map(ext => ext.trim().toLowerCase())
        .filter(ext => /^[a-z0-9]{1,16}$/.test(ext) && !blockedExts.includes(ext));

    if (validatedExtensions.length === 0) {
        settings.attachmentFileExtensions = "none";
    } else {
        settings.attachmentFileExtensions = validatedExtensions.join(",");
    }

    await saveSettings(settings);
}
