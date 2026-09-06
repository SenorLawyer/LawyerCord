/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Message, MessageAttachment } from "@vencord/discord-types";
import { UserStore } from "@webpack/common";

import { discordEditedTimestamp } from "./messageMetadata";
import type { DecryptIncomingAttachmentsResult } from "./native";
import { isEncryptedMessage } from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const SPOILER_FLAG = 8;
const ANIMATED_FLAG = 32;
// Discord treats a missing scan version as pending and can obscure media from non-friends.
// E2EE plaintext cannot be scanned by Discord, so use its explicit local/unscanned sentinel
// instead of misrepresenting the ciphertext attachment's scan as applying to decrypted bytes.
const LOCAL_CONTENT_SCAN_VERSION = -1;

interface ExtendedAttachment extends MessageAttachment {
    content_scan_version?: number;
    description?: string;
    duration_secs?: number;
    flags?: number;
}

export type AttachmentCacheStatus =
    | { status: "idle" | "loading" | "ready"; }
    | { status: "failed"; reason: string; };

interface AttachmentCacheEntry {
    attachments: ExtendedAttachment[];
    bytes: number;
    disposed: boolean;
    lastAccess: number;
    listeners: Set<() => void>;
    objectUrls: string[];
    status: AttachmentCacheStatus;
}

const cache = new Map<string, AttachmentCacheEntry>();
let cachedBytes = 0;

function cacheKey(message: Message): string {
    return `${UserStore.getCurrentUser()?.id ?? ""}\0${message.author.id}\0${discordEditedTimestamp(message)}\0${message.channel_id}\0${message.id}\0${message.content}\0${message.attachments.map(attachment =>
        `${attachment.id}:${attachment.size}:${attachment.url}:${attachment.proxy_url}`).join("\0")}`;
}

function cloneWithAttachments(message: Message, attachments: ExtendedAttachment[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.attachments = attachments;
    return clone;
}

function notify(entry: AttachmentCacheEntry): void {
    if (entry.disposed) return;
    for (const listener of entry.listeners) listener();
    entry.listeners.clear();
}

function removeEntry(key: string, entry: AttachmentCacheEntry): void {
    cache.delete(key);
    cachedBytes -= entry.bytes;
    entry.disposed = true;
    entry.listeners.clear();
    for (const url of entry.objectUrls) URL.revokeObjectURL(url);
}

function pruneCache(protectedKey: string): void {
    while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
        let oldest: [string, AttachmentCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status.status === "loading") continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        removeEntry(...oldest);
    }
}

function failureReason(result: DecryptIncomingAttachmentsResult): string {
    if (result.status === "decrypted") return "";
    if (result.status === "untrusted_author") return "Verify the sender's encryption key before opening attachments.";
    if (result.status === "replay_detected") return "The encrypted attachment bundle conflicts with a previously authenticated message.";
    if (result.status === "invalid_message") return "The encrypted attachment bundle failed authentication.";
    if (result.status === "invalid_input") return result.error;
    if (result.status === "unavailable") return "Secure key storage is unavailable.";
    if ("error" in result && result.error === "attachment_download_failed") return "Discord could not provide the encrypted attachment bytes.";
    if ("error" in result && result.error === "attachment_too_large") return "The encrypted attachments exceed the local safety limit.";
    return "The encrypted attachments could not be decrypted.";
}

async function loadEntry(message: Message, key: string, entry: AttachmentCacheEntry): Promise<void> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) {
        entry.status = { status: "failed", reason: "Discord has no authenticated user." };
        notify(entry);
        return;
    }
    const result = await Native.decryptIncomingAttachments(localUserId, {
        channelId: message.channel_id,
        content: message.content,
        discordAuthorId: message.author.id,
        discordEditedTimestamp: discordEditedTimestamp(message),
        discordMessageId: message.id,
        attachments: message.attachments.map(attachment => ({
            id: attachment.id,
            proxyUrl: attachment.proxy_url,
            size: attachment.size,
            url: attachment.url,
        })),
    });
    if (entry.disposed) return;
    if (result.status !== "decrypted") {
        entry.status = { status: "failed", reason: failureReason(result) };
        notify(entry);
        return;
    }
    const attachments: ExtendedAttachment[] = [];
    const objectUrls: string[] = [];
    let bytes = 0;
    for (const attachment of result.attachments) {
        const { metadata } = attachment;
        const blob = new Blob([Uint8Array.from(attachment.data).buffer], {
            type: metadata.mimeType || "application/octet-stream",
        });
        const objectUrl = URL.createObjectURL(blob);
        if (entry.disposed) {
            URL.revokeObjectURL(objectUrl);
            for (const previousUrl of objectUrls) URL.revokeObjectURL(previousUrl);
            return;
        }
        objectUrls.push(objectUrl);
        bytes += blob.size;
        attachments.push({
            id: attachment.id,
            filename: metadata.name,
            content_scan_version: LOCAL_CONTENT_SCAN_VERSION,
            content_type: metadata.mimeType || undefined,
            size: metadata.size,
            spoiler: metadata.spoiler,
            url: `${objectUrl}#`,
            proxy_url: `${objectUrl}#`,
            description: metadata.description ?? undefined,
            width: metadata.width ?? undefined,
            height: metadata.height ?? undefined,
            duration_secs: metadata.duration ?? undefined,
            flags: (metadata.spoiler ? SPOILER_FLAG : 0) |
                (metadata.mimeType === "image/gif" ? ANIMATED_FLAG : 0),
        });
    }
    entry.attachments = attachments;
    entry.objectUrls = objectUrls;
    entry.bytes = bytes;
    entry.lastAccess = Date.now();
    entry.status = { status: "ready" };
    cachedBytes += bytes;
    notify(entry);
    pruneCache(key);
}

function ensureEntry(message: Message): AttachmentCacheEntry | null {
    if (!isEncryptedMessage(message.content) || message.attachments.length === 0) return null;
    const key = cacheKey(message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        return existing;
    }
    const entry: AttachmentCacheEntry = {
        attachments: [],
        bytes: 0,
        disposed: false,
        lastAccess: Date.now(),
        listeners: new Set(),
        objectUrls: [],
        status: { status: "loading" },
    };
    cache.set(key, entry);
    void loadEntry(message, key, entry).catch(() => {
        if (entry.disposed) return;
        entry.status = { status: "failed", reason: "The encrypted attachments could not be loaded." };
        notify(entry);
    });
    return entry;
}

export function patchEncryptedMessageAttachments(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content) && message.attachments.length > 0)
        return cloneWithAttachments(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status.status === "loading") entry.listeners.add(onReady);
    return cloneWithAttachments(message, entry.status.status === "ready" ? entry.attachments : []);
}

export function encryptedAttachmentStatus(message: Message): AttachmentCacheStatus {
    return ensureEntry(message)?.status ?? { status: "idle" };
}

export function subscribeEncryptedAttachmentStatus(message: Message, listener: () => void): () => void {
    const entry = ensureEntry(message);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
}

export function clearEncryptedAttachmentCache(): void {
    for (const [key, entry] of cache) removeEntry(key, entry);
    cachedBytes = 0;
}
