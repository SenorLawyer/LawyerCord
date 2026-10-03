/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import {
    createStore,
    del,
    get,
    keys,
    set,
} from "@api/DataStore";
import { sleep } from "@utils/misc";

import { Flogger, Native, settings } from "../..";
import { LoggedAttachment } from "../../types";
import { DEFAULT_IMAGE_CACHE_DIR } from "../constants";

const ImageStore = createStore("MessageLoggerImageData", "MessageLoggerImageStore");

interface IDBSavedImage { attachmentId: string, path: string; }
const idbSavedImages = new Map<string, IDBSavedImage>();
let imagePaths: Promise<void> | undefined;
export let downloadLifetime = new AbortController();
const downloads = new Map<string, Promise<string | undefined>>();

function loadImagePaths() {
    const owner = downloadLifetime;
    return imagePaths ??= keys(ImageStore).then(paths => {
        if (owner.signal.aborted) return;
        for (const path of paths) {
            const str = path.toString();
            if (!str.startsWith(`${DEFAULT_IMAGE_CACHE_DIR}/`)) continue;
            const attachmentId = str.split("/")[1].split(".")[0];
            idbSavedImages.set(attachmentId, { attachmentId, path: str });
        }
    }).catch(err => {
        if (downloadLifetime === owner) imagePaths = undefined;
        Flogger.error("Failed to get idb images", err);
    });
}

export function stopDownloads() {
    downloadLifetime.abort();
    downloadLifetime = new AbortController();
    downloads.clear();
    idbSavedImages.clear();
    imagePaths = undefined;
}

export async function getImage(attachmentId: string, fileExt?: string | null): Promise<Uint8Array<ArrayBuffer> | null> {
    const owner = downloadLifetime;
    await loadImagePaths();
    if (owner.signal.aborted) return null;
    // for people who have access to native api but some images are still in idb
    // also for people who dont have native api
    const idbPath = idbSavedImages.get(attachmentId)?.path;
    if (idbPath)
        return (await get<Uint8Array<ArrayBuffer>>(idbPath, ImageStore)) ?? null;

    if (IS_WEB) return null;

    return await Native.getImageNative(attachmentId);
}

export function downloadAttachment(attachment: Pick<LoggedAttachment, "id" | "url" | "oldUrl" | "fileExtension">, signal: AbortSignal = downloadLifetime.signal): Promise<string | undefined> {
    const cached = downloads.get(attachment.id);
    if (cached) return cached;
    const owner = downloadLifetime;
    const promise = (async () => {
        const lifetime = AbortSignal.any([owner.signal, signal]);
        if (IS_WEB) return downloadAttachmentWeb(attachment, AbortSignal.any([lifetime, AbortSignal.timeout(120_000)]));
        for (;;) {
            lifetime.throwIfAborted();
            const result = await Native.tryDownloadAttachment(attachment);
            lifetime.throwIfAborted();
            if (result.busy) {
                if (!await Native.waitForAttachmentDownloadCapacity()) throw new DOMException("Attachment download canceled.", "AbortError");
                continue;
            }
            if (result.error || !result.path) {
                Flogger.error("Failed to download attachment", result.error);
                return;
            }
            return result.path;
        }
    })().finally(() => {
        if (downloads.get(attachment.id) === promise) downloads.delete(attachment.id);
    });
    downloads.set(attachment.id, promise);
    return promise;
}

export async function deleteImage(attachmentId: string): Promise<void> {
    await loadImagePaths();
    const idbPath = idbSavedImages.get(attachmentId)?.path;
    if (idbPath) {
        idbSavedImages.delete(attachmentId);
        return await del(idbPath, ImageStore);
    }

    if (IS_WEB) return;

    await Native.deleteFileNative(attachmentId);
}

async function downloadAttachmentWeb(attachemnt: Pick<LoggedAttachment, "id" | "url" | "oldUrl" | "fileExtension">, signal: AbortSignal, attempts = 0): Promise<string | undefined> {
    if (!attachemnt?.url || !attachemnt?.id || !attachemnt?.fileExtension) {
        Flogger.error("Invalid attachment", attachemnt);
        return;
    }

    signal.throwIfAborted();
    const res = await fetch(attachemnt.url, { signal });
    if (res.status !== 200) {
        await res.body?.cancel();
        if (res.status === 404 || res.status === 403) return;
        attempts++;
        if (attempts > 3) {
            Flogger.warn(`Failed to get attachment ${attachemnt.id} for caching, error code ${res.status}`);
            return;
        }

        await sleep(1000);
        return downloadAttachmentWeb(attachemnt, signal, attempts);
    }
    const maxBytes = Math.min(settings.store.attachmentSizeLimitInMegabytes, 500) * 1024 * 1024;
    if (!res.body || Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        return;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) return;
            chunks.push(value);
        }
    } finally {
        try { await reader.cancel(); }
        finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const path = `${DEFAULT_IMAGE_CACHE_DIR}/${attachemnt.id}${attachemnt.fileExtension}`;

    await set(path, bytes, ImageStore);
    signal.throwIfAborted();
    idbSavedImages.set(attachemnt.id, { attachmentId: attachemnt.id, path });

    return path;
}
