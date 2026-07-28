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

import { MessageAttachment } from "@vencord/discord-types";

import { Flogger, settings } from "../..";
import { LoggedAttachment, LoggedMessage, LoggedMessageJSON } from "../../types";
import { deleteImage, downloadAttachment, getImage, } from "./ImageManager";

const MAX_ATTACHMENT_BLOB_URLS = 100;
const ATTACHMENT_BLOB_URL_TTL = 10 * 60 * 1000;

type AttachmentBlobUrlCacheEntry = {
    promise: Promise<string | null>;
    url?: string;
    lastAccessedAt: number;
};

const attachmentBlobUrlCache = new Map<string, AttachmentBlobUrlCacheEntry>();

function getAttachmentBlobUrlCacheKey(attachment: LoggedAttachment) {
    return `${attachment.id}:${attachment.fileExtension ?? ""}`;
}

function revokeAttachmentBlobUrlEntry(key: string, entry: AttachmentBlobUrlCacheEntry) {
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
        entry.url = undefined;
        return;
    }

    void entry.promise.then(url => {
        if (url && attachmentBlobUrlCache.get(key) !== entry) {
            URL.revokeObjectURL(url);
        }
    }, () => { });
}

function pruneAttachmentBlobUrlCache() {
    const expiresBefore = Date.now() - ATTACHMENT_BLOB_URL_TTL;
    for (const [key, entry] of attachmentBlobUrlCache) {
        if (entry.lastAccessedAt < expiresBefore) {
            attachmentBlobUrlCache.delete(key);
            revokeAttachmentBlobUrlEntry(key, entry);
        }
    }
    while (attachmentBlobUrlCache.size > MAX_ATTACHMENT_BLOB_URLS) {
        const oldest = attachmentBlobUrlCache.entries().next().value;
        if (!oldest) return;

        const [key, entry] = oldest;
        attachmentBlobUrlCache.delete(key);
        revokeAttachmentBlobUrlEntry(key, entry);
    }
}

export function clearAttachmentBlobUrlCache() {
    for (const [key, entry] of attachmentBlobUrlCache) {
        revokeAttachmentBlobUrlEntry(key, entry);
    }
    attachmentBlobUrlCache.clear();
}

export function getFileExtension(str: string) {
    const matches = str.match(/(\.[a-zA-Z0-9]+)(?:\?.*)?$/);
    if (!matches) return null;

    return matches[1];
}

export function isAttachmentGoodToCache(attachment: MessageAttachment, fileExtension: string) {
    if (attachment.size > settings.store.attachmentSizeLimitInMegabytes * 1024 * 1024) {
        return false;
    }
    const attachmentFileExtensionsStr = settings.store.attachmentFileExtensions.trim();

    if (attachmentFileExtensionsStr === "")
        return true;

    const allowedFileExtensions = attachmentFileExtensionsStr.split(",");

    if (fileExtension.startsWith(".")) {
        fileExtension = fileExtension.slice(1);
    }

    if (!fileExtension || !allowedFileExtensions.includes(fileExtension)) {
        return false;
    }

    return true;
}

export async function cacheMessageImages(message: LoggedMessage | LoggedMessageJSON) {
    try {
        for (const attachment of message.attachments) {
            const fileExtension = getFileExtension(attachment.filename ?? attachment.url) ?? attachment?.content_type?.split("/")?.[1] ?? ".png";

            if (!isAttachmentGoodToCache(attachment, fileExtension)) {
                continue;
            }

            attachment.oldUrl = attachment.url;
            attachment.oldProxyUrl = attachment.proxy_url;

            // only normal urls work if theres a charset in the content type /shrug
            if (attachment?.content_type?.includes(";")) {
                attachment.proxy_url = attachment.url;
            } else {
                // apparently proxy urls last longer
                attachment.url = attachment.proxy_url;
                attachment.proxy_url = attachment.url;
            }

            attachment.fileExtension = fileExtension;

            const path = await downloadAttachment(attachment);

            if (!path) {
                Flogger.error("Failed to cache attachment", attachment);
                continue;
            }

            attachment.path = path;
        }

    } catch (error) {
        Flogger.error("Error caching message images:", error);
    }
}

export async function deleteMessageImages(message: LoggedMessage | LoggedMessageJSON) {
    for (let i = 0; i < message.attachments.length; i++) {
        const attachment = message.attachments[i];
        await deleteImage(attachment.id);
    }
}

export async function getAttachmentBlobUrl(attachment: LoggedAttachment) {
    pruneAttachmentBlobUrlCache();
    const key = getAttachmentBlobUrlCacheKey(attachment);
    const cached = attachmentBlobUrlCache.get(key);
    if (cached) {
        cached.lastAccessedAt = Date.now();
        attachmentBlobUrlCache.delete(key);
        attachmentBlobUrlCache.set(key, cached);
        return cached.promise;
    }

    const promise = (async () => {
        const imageData = await getImage(attachment.id, attachment.fileExtension);
        if (!imageData) return null;

        const blob = new Blob([imageData]);
        const resUrl = URL.createObjectURL(blob);

        return resUrl;
    })();
    const entry: AttachmentBlobUrlCacheEntry = { promise, lastAccessedAt: Date.now() };

    void promise.then(url => {
        if (!url) return;

        entry.url = url;
        if (attachmentBlobUrlCache.get(key) !== entry) {
            URL.revokeObjectURL(url);
            entry.url = undefined;
        }
    }, () => {
        if (attachmentBlobUrlCache.get(key) === entry) {
            attachmentBlobUrlCache.delete(key);
        }
    });

    attachmentBlobUrlCache.set(key, entry);
    pruneAttachmentBlobUrlCache();
    return promise;
}
