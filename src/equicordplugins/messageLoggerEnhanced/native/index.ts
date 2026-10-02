/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, unlink } from "node:fs/promises";
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
const logger = new Logger("MessageLoggerEnhanced");

let imageCacheDir: string;

const getImageCacheDir = async () => imageCacheDir ?? await getDefaultNativeImageDir();

export async function initDirs() {
    const { imageCacheDir: icd } = await getSettings();

    imageCacheDir = icd || await getDefaultNativeImageDir();
}
initDirs();

export async function init(_event: IpcMainInvokeEvent) {
    const imageDir = await getImageCacheDir();

    await ensureDirectoryExists(imageDir);
    const files = await readdir(imageDir);
    for (const filename of files) {
        const attachmentId = getAttachmentIdFromFilename(filename);
        nativeSavedImages.set(attachmentId, path.join(imageDir, filename));
    }
}

export async function getImageNative(_event: IpcMainInvokeEvent, attachmentId: string): Promise<Uint8Array | Buffer | null> {
    const imagePath = nativeSavedImages.get(attachmentId);
    if (!imagePath) return null;

    try {
        return await readFile(imagePath);
    } catch (error: any) {
        console.error(error);
        return null;
    }
}

export async function deleteFileNative(_event: IpcMainInvokeEvent, attachmentId: string) {
    const imagePath = nativeSavedImages.get(attachmentId);
    if (!imagePath) return;

    await unlink(imagePath);
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
    const settings = await getSettings();
    const defaultPath = settings[logKey] || await getDefaultNativeDataDir();

    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath });
    const dir = res.filePaths[0];

    if (!dir) throw Error("Invalid Directory");

    settings[logKey] = dir;

    await saveSettings(settings);

    if (logKey === "imageCacheDir") {
        imageCacheDir = dir;
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

export async function downloadAttachment(_event: IpcMainInvokeEvent, attachment: unknown): Promise<{ error: string | null; path: string | null; }> {
    let temporaryPath: string | undefined;
    try {
        if (!attachment || typeof attachment !== "object"
            || !("id" in attachment) || typeof attachment.id !== "string" || !/^\d{1,20}$/.test(attachment.id)
            || !("fileExtension" in attachment) || typeof attachment.fileExtension !== "string" || !/^\.?[a-z0-9]{1,16}$/i.test(attachment.fileExtension)
            || !("url" in attachment) || !("oldUrl" in attachment))
            return { error: "Invalid attachment.", path: null };

        const urls = [attachment.url, attachment.oldUrl].map(value => {
            if (typeof value !== "string" || value.length > 8192) return null;
            const url = URL.parse(value);
            return url?.protocol === "https:" && !url.port && !url.username && !url.password
                && ["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"].includes(url.hostname) ? url : null;
        });
        const [url, oldUrl] = urls;
        if (!url || !oldUrl) return { error: "Invalid attachment URL.", path: null };

        const settings = await getSettings();
        const allowedExtensionsStr = settings.attachmentFileExtensions?.trim() || "";
        if (allowedExtensionsStr === "" || allowedExtensionsStr.toLowerCase() === "none") {
            return { error: "All attachment downloads are currently blocked by settings configurations.", path: null };
        }

        const allowedList = allowedExtensionsStr.split(",").map((ext: string) => ext.trim().toLowerCase());
        const cleanExt = attachment.fileExtension.replace(/^\./, "").toLowerCase();

        if (blockedExts.includes(cleanExt) || !allowedList.includes(cleanExt)) {
            return { error: `File type .${cleanExt} is blocked by settings configurations.`, path: null };
        }

        const existingImage = nativeSavedImages.get(attachment.id);
        if (existingImage)
            return {
                error: null,
                path: existingImage
            };

        const signal = AbortSignal.timeout(120_000);
        const maxBytes = 500 * 1024 * 1024;
        let downloadUrl = url;
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await fetch(downloadUrl, { redirect: "error", signal });
            if (res.status !== 200) {
                await res.body?.cancel();
                if (attempt === 3) return { error: "Could not download this attachment.", path: null };
                if ([403, 404, 415].includes(res.status)) downloadUrl = oldUrl;
                await sleep(1000);
                continue;
            }
            if (!res.body || Number(res.headers.get("content-length")) > maxBytes) {
                await res.body?.cancel();
                return { error: "Attachment exceeds the download limit.", path: null };
            }

            const root = path.resolve(await getImageCacheDir());
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
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > maxBytes) throw new Error("Attachment exceeds the download limit.");
                    await file.writeFile(value);
                }
            } finally {
                try { await file.close(); }
                finally {
                    try { await reader.cancel(); }
                    finally { reader.releaseLock(); }
                }
            }
            signal.throwIfAborted();
            await rename(temporaryPath, finalPath);
            temporaryPath = undefined;
            nativeSavedImages.set(attachment.id, finalPath);
            return { error: null, path: finalPath };
        }
        return { error: "Could not download this attachment.", path: null };
    } catch {
        return { error: "Could not download this attachment.", path: null };
    } finally {
        if (temporaryPath) await unlink(temporaryPath).catch(() => logger.warn("Could not remove an incomplete attachment."));
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
