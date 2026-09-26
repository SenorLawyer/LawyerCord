/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Embed, Message } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Constants, RestAPI, UserStore } from "@webpack/common";

import type { SecureStickerItem } from "./attachments";
import { extractSecureEmbedUrls } from "./embedUrls";
import { discordEditedTimestamp } from "./messageMetadata";
import type { DecryptIncomingResult } from "./native";
import { isEncryptedMessage } from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const convertEmbed = findByCodeLazy(".uniqueId(\"embed_\")") as (
    channelId: string,
    messageId: string,
    embed: Record<string, unknown>,
) => Embed | null;
const MAX_CACHE_ENTRIES = 256;
const MAX_UNFURL_CACHE_ENTRIES = 128;
const LOCAL_CONTENT_SCAN_VERSION = -1;
const SUCCESSFUL_UNFURL_TTL = 30 * 60 * 1_000;
const EMPTY_UNFURL_TTL = 30_000;
const UNFURL_RETRY_DELAYS = [0, 250, 1_000, 3_000] as const;

interface EmbedCacheEntry {
    embeds: Embed[];
    lastAccess: number;
    listeners: Set<() => void>;
    status: "loading" | "ready";
    stickers: SecureStickerItem[];
}

interface UnfurlCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<Record<string, unknown>[]>;
}

const cache = new Map<string, EmbedCacheEntry>();
const unfurlCache = new Map<string, UnfurlCacheEntry>();

function cacheKey(message: Message): string {
    return `${UserStore.getCurrentUser()?.id ?? ""}\0${message.channel_id}\0${message.id}\0${message.author?.id ?? ""}\0${discordEditedTimestamp(message) ?? ""}\0${message.content}`;
}

function cloneWithEmbeds(message: Message, embeds: Embed[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.embeds = embeds;
    return clone;
}

function cloneWithStickers(message: Message, stickers: SecureStickerItem[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.stickerItems = stickers.map(sticker => ({
        format_type: sticker.formatType,
        id: sticker.id,
        name: sticker.name,
    }));
    return clone;
}

function notify(entry: EmbedCacheEntry): void {
    for (const listener of entry.listeners) {
        try {
            listener();
        } catch {
            // Discord may dispose a message renderer before an asynchronous unfurl finishes.
        }
    }
    entry.listeners.clear();
}

function pruneCache(protectedKey: string): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
        let oldest: [string, EmbedCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status === "loading") continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        cache.delete(oldest[0]);
    }
}

function pruneUnfurlCache(protectedKey: string, now: number): void {
    for (const [key, entry] of unfurlCache) {
        if (key !== protectedKey && entry.expiresAt <= now) unfurlCache.delete(key);
    }
    while (unfurlCache.size > MAX_UNFURL_CACHE_ENTRIES) {
        let oldest: [string, UnfurlCacheEntry] | null = null;
        for (const value of unfurlCache) {
            if (value[0] === protectedKey) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        unfurlCache.delete(oldest[0]);
    }
}

async function requestUnfurl(url: string): Promise<Record<string, unknown>[]> {
    for (const retryDelay of UNFURL_RETRY_DELAYS) {
        if (retryDelay > 0) await new Promise(resolve => setTimeout(resolve, retryDelay));
        try {
            const response = await RestAPI.post({
                url: Constants.Endpoints.UNFURL_EMBED_URLS,
                body: { urls: [url] },
                retries: 1,
            });
            const embeds = Array.isArray(response?.body?.embeds) ? response.body.embeds : [];
            if (embeds.length > 0) return embeds;
        } catch {
            // Discord's unfurl service can be temporarily unavailable; retry without disturbing the message row.
        }
    }
    return [];
}

function unfurlUrl(url: string): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const existing = unfurlCache.get(url);
    if (existing && existing.expiresAt > now) {
        existing.lastAccess = now;
        return existing.promise;
    }
    if (existing) unfurlCache.delete(url);
    const entry: UnfurlCacheEntry = {
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve([]),
    };
    entry.promise = requestUnfurl(url).then(embeds => {
        if (unfurlCache.get(url) === entry) {
            const settledAt = Date.now();
            entry.expiresAt = settledAt + (embeds.length > 0 ? SUCCESSFUL_UNFURL_TTL : EMPTY_UNFURL_TTL);
            entry.lastAccess = settledAt;
            pruneUnfurlCache(url, settledAt);
        }
        return embeds;
    });
    unfurlCache.set(url, entry);
    pruneUnfurlCache(url, now);
    return entry.promise;
}

async function unfurlEmbeds(urls: string[]): Promise<Record<string, unknown>[]> {
    return (await Promise.all(urls.map(unfurlUrl))).flat();
}

function finishEntry(key: string, entry: EmbedCacheEntry): void {
    if (cache.get(key) !== entry) return;
    entry.lastAccess = Date.now();
    entry.status = "ready";
    notify(entry);
    pruneCache(key);
}

async function loadEntry(message: Message, key: string, entry: EmbedCacheEntry): Promise<void> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId || !message.author?.id) {
        finishEntry(key, entry);
        return;
    }
    let decrypted: DecryptIncomingResult;
    try {
        decrypted = await Native.decryptIncoming(localUserId, {
            channelId: message.channel_id,
            content: message.content,
            discordAuthorId: message.author.id,
            discordEditedTimestamp: discordEditedTimestamp(message),
            discordMessageId: message.id,
        });
    } catch {
        finishEntry(key, entry);
        return;
    }
    if (cache.get(key) !== entry) return;
    if (UserStore.getCurrentUser()?.id !== localUserId) {
        cache.delete(key);
        return;
    }
    if (decrypted.status !== "decrypted") {
        finishEntry(key, entry);
        return;
    }
    entry.stickers = decrypted.stickers ?? [];
    const urls = extractSecureEmbedUrls(decrypted.plaintext);
    if (urls.length === 0) {
        finishEntry(key, entry);
        return;
    }
    // Matching Discord's native previews requires disclosing only the extracted URLs to its unfurl service.
    const rawEmbeds = await unfurlEmbeds(urls);
    const converted: Embed[] = [];
    for (const rawEmbed of rawEmbeds) {
        try {
            const embed = convertEmbed(message.channel_id, message.id, {
                ...rawEmbed,
                // Discord cannot scan a preview that only exists after local authenticated decryption.
                content_scan_version: LOCAL_CONTENT_SCAN_VERSION,
            });
            if (embed) converted.push(embed);
        } catch {
            // One malformed response must not hide other Discord-provided embeds.
        }
    }
    if (cache.get(key) !== entry) return;
    entry.embeds = converted;
    finishEntry(key, entry);
}

function ensureEntry(message: Message): EmbedCacheEntry | null {
    if (!isEncryptedMessage(message.content)) return null;
    const key = cacheKey(message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        return existing;
    }
    const entry: EmbedCacheEntry = {
        embeds: [],
        lastAccess: Date.now(),
        listeners: new Set(),
        status: "loading",
        stickers: [],
    };
    cache.set(key, entry);
    void loadEntry(message, key, entry);
    return entry;
}

export function patchEncryptedMessageEmbeds(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithEmbeds(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithEmbeds(message, entry.status === "ready" ? entry.embeds : []);
}

export function patchEncryptedMessageStickers(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithStickers(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithStickers(message, entry.status === "ready" ? entry.stickers : []);
}

export function clearEncryptedEmbedCache(): void {
    cache.clear();
    unfurlCache.clear();
}

export async function prefetchEncryptedMessageEmbeds(plaintext: string): Promise<void> {
    const urls = extractSecureEmbedUrls(plaintext);
    if (urls.length > 0) await unfurlEmbeds(urls);
}
