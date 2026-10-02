/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import { proxyLazy } from "@utils/lazy";
import { useForceUpdater } from "@utils/react";
import { PluginNative } from "@utils/types";
import { Channel, MessageAttachment } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { Constants, DraftType, FluxDispatcher, lodash, MessageActions, PendingReplyStore, PermissionStore, RestAPI, Toasts, UploadAttachmentStore, UploadHandler, UploadManager, useCallback, useEffect, useMemo, useRef, UserSettingsActionCreators, UserSettingsProtoStore, UserStore, useStateFromStores } from "@webpack/common";
import { deflateSync, Inflate } from "fflate";
import { Key } from "react";
import { JsonValue } from "type-fest";

import { base64ToUint8Array, uint8ArrayToBase64 } from "./polyfills";
import { AttachmentTransformer, CustomItemDef, CustomItemFormat, FavouriteItem, FavouriteItemFormat, ImageUtils as ImageUtils_, ItemsDef, ResizeObserverHook, UnfurledEmbedsResponse } from "./types";

const Native = VencordNative.pluginHelpers.FavouriteAnything as PluginNative<typeof import("./native")>;

export const cl = classNameFactory("vc-favouriteAnything-");

export const useResizeObserver: ResizeObserverHook = findByCodeLazy("borderBoxSize", "blockSize", "inlineSize");
export const ImageUtils: ImageUtils_ = findByPropsLazy("isAnimated", "getFormatQuality");
export const transformAttachment: AttachmentTransformer = findByCodeLazy("return{uniqueId", ".IS_ANIMATED");

const encoder = new TextEncoder();
const MAX_METADATA_BYTES = 64 * 1024;

const defineItem = <const A, const B extends JsonValue>(item: CustomItemDef<A, B>) => item;
function defineItems<T extends Record<CustomItemFormat, CustomItemDef>>(def: ItemsDef<T>) {
    type Type<F extends CustomItemFormat> = T[F] extends CustomItemDef<infer A> ? A : never;

    return {
        encode: <F extends CustomItemFormat>(format: F, data: Type<F>) => {
            try {
                const obj = [format, def[format].encode(data)];

                const bytes = encoder.encode(JSON.stringify(obj));
                if (bytes.byteLength > MAX_METADATA_BYTES) return null;
                const encoded = uint8ArrayToBase64(deflateSync(bytes));
                return encoded.length <= MAX_METADATA_BYTES ? encoded : null;
            } catch {
                return null;
            }
        },
        decode: (raw: string) => {
            try {
                if (!raw || raw.length > MAX_METADATA_BYTES) return null;

                const compressed = base64ToUint8Array(raw);
                const decoder = new TextDecoder();
                let text = "";
                let size = 0;
                const inflater = new Inflate((chunk, final) => {
                    size += chunk.byteLength;
                    if (size > MAX_METADATA_BYTES) throw new Error("Favourite metadata is too large.");
                    text += decoder.decode(chunk, { stream: !final });
                });
                for (let offset = 0; offset < compressed.length; offset += 256)
                    inflater.push(compressed.subarray(offset, offset + 256), offset + 256 >= compressed.length);
                const parsed: unknown = JSON.parse(text);
                if (!Array.isArray(parsed) || parsed.length !== 2) return null;

                const [format, data] = parsed as [keyof typeof def, JsonValue];
                if (typeof format !== "number" || !Object.hasOwn(def, format)) return null;

                return { format, data: def[format].decode(data) } as {
                    [F in CustomItemFormat]: { format: F; data: Type<F>; };
                }[CustomItemFormat];
            } catch {
                return null;
            }
        },
        stringify: <F extends CustomItemFormat>(format: F, item: Type<F>) => def[format].stringify(item)
    };
}

// Encode/Decode definitions for custom favourite items.
// The encode callback must return a json compatible object, preferably as compact as possible.
// Decode must recreate the original object based on the encoded value.
// Stringify returns a simple string representation used for thumbnail text and expression picker search.
export const defs = defineItems({
    [CustomItemFormat.ATTACHMENT]: defineItem({
        encode: ({ id, filename, size, url, content_type = "", title, description }: MessageAttachment) => [
            id,
            filename,
            size,
            new URL(url).pathname,
            content_type,
            title ?? null,
            description ?? null
        ],
        decode: data => {
            if (!Array.isArray(data) || data.length < 4 || data.length > 7) return null;
            const [id, filename, size, path, content_type, title, description] = data;
            if ([id, filename, content_type, title, description].some(value => value != null && typeof value !== "string")
                || (size != null && (typeof size !== "number" || !Number.isFinite(size) || size < 0))
                || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
            const cdn = new URL(`https://${window.GLOBAL_ENV.CDN_HOST}`);
            const media = new URL(`https://${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}`);
            const url = new URL(path, cdn);
            const proxy = new URL(path, media);
            if (url.origin !== cdn.origin || proxy.origin !== media.origin) return null;
            return {
                id: id ?? "0",
                filename: filename ?? "UNKNOWN",
                size: size ?? 0,
                url: `${url}`,
                proxy_url: `${proxy}`,
                content_type: content_type || "application/octet-stream",
                spoiler: filename?.startsWith("SPOILER_") ?? false,
                title: title ?? undefined,
                description: description ?? undefined
            };
        },
        stringify: ({ title, filename }) => title?.trim() || filename
    })
    // This could be expanded in the future with other item types (e.g. voice messages)
});

// TODO: make thumbnails prettier
const fallbackThumbnail = new URL("https://images-ext-1.discordapp.net/external/pGTJg3YdSHpyGTltH4vZUKEyQoNzf5mtqbSJs7I4ebc/https/equicord.org/assets/plugins/favoriteAnything/invalid.png");

export async function getThumbnailUrl(data: string, width: number, height: number): Promise<URL | null> {
    try {
        const decoded = defs.decode(data);
        if (!decoded || !width || !height) return null;

        const text = defs.stringify(decoded.format, decoded.data);
        const url = new URL(`https://placehold.jp/42/444/fff/${width}x${height}.png`);
        url.searchParams.append("text", text);

        return await RestAPI.post({
            url: Constants.Endpoints.UNFURL_EMBED_URLS,
            body: { urls: [url] },
            retries: 3
        }).then(({ body }: { body: UnfurledEmbedsResponse; }) => {
            const [{ thumbnail } = {}] = body.embeds;
            return thumbnail?.proxy_url ? new URL(thumbnail.proxy_url) : fallbackThumbnail;
        });
    } catch {
        return fallbackThumbnail;
    }
}

export const isAllowedHost = proxyLazy(() => {
    // GLOBAL_ENV is not initialized immediately
    const allowedHosts = new Set<string>([window.GLOBAL_ENV.CDN_HOST]);
    for (const endpoints of [window.GLOBAL_ENV.IMAGE_PROXY_ENDPOINTS, window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT]) {
        for (const endpoint of endpoints.split(",")) {
            const host = URL.parse(`https://${endpoint}`)?.hostname;
            if (host) allowedHosts.add(host);
        }
    }

    return (value: string) => allowedHosts.has(value);
});

const attachmentRequests = new Set<AbortController>();

export function cancelAttachmentSends() {
    for (const controller of attachmentRequests) controller.abort();
    attachmentRequests.clear();
}

async function fetchAttachment(attachment: MessageAttachment, signal: AbortSignal): Promise<File> {
    if (!IS_WEB) {
        const result = await Native.fetchAttachment(attachment);
        if (signal.aborted) throw new Error("Attachment download was cancelled.");
        if (!result.success) throw new Error(result.error);
        return new File([result.data], result.filename, { type: result.type });
    }

    const { content_type, filename } = attachment;
    const url = URL.parse(attachment.url);
    if (!url || url.protocol !== "https:" || url.port || url.username || url.password || !isAllowedHost(url.hostname))
        throw new Error("Invalid attachment URL.");

    const maxBytes = 500 * 1024 * 1024;
    const res = await fetch(url, { headers: { Accept: "*/*" }, redirect: "error", signal });
    if (!res.ok || !res.body || Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        throw new Error("Could not download this attachment.");
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
        for (;;) {
            if (signal.aborted) throw new Error("Attachment download was cancelled.");
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error("Attachment exceeds the download size limit.");
            chunks.push(value);
        }
    } finally {
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }

    if (signal.aborted) throw new Error("Attachment download was cancelled.");
    return new File(chunks, filename, { type: res.headers.get("content-type") || content_type || "application/octet-stream" });
}

export async function sendAttachment(attachment: MessageAttachment, channel: Channel) {
    const accountId = UserStore.getCurrentUser()?.id;
    if (!accountId || !isPluginEnabled("FavouriteAnything")) return;
    const controller = new AbortController();
    attachmentRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const isCurrent = () => !controller.signal.aborted && UserStore.getCurrentUser()?.id === accountId && isPluginEnabled("FavouriteAnything");
    const { filename, title, description } = attachment;
    try {
        const file = await fetchAttachment(attachment, controller.signal).catch(() => {
            if (isCurrent()) Toasts.show({ message: `Couldn't fetch ${filename}`, id: Toasts.genId(), type: Toasts.Type.FAILURE });
            return null;
        });
        if (!file || !isCurrent()) return;
        clearTimeout(timeout);

        // Using promptToUpload instead of addFiles directly since it has file size checks with error popups
        const uploaded = await UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage).then(() => true, () => {
            if (isCurrent()) Toasts.show({ message: `Couldn't upload ${filename}`, id: Toasts.genId(), type: Toasts.Type.FAILURE });
            return false;
        });
        if (!uploaded || !isCurrent()) return;

        const uploads = [...UploadAttachmentStore.getUploads(channel.id, DraftType.ChannelMessage)];
        const uploadIdx = uploads.findIndex(({ item }) => item.file === file);
        if (uploadIdx === -1) return;

        const reply = PendingReplyStore.getPendingReply(channel.id);

        const [upload] = uploads.splice(uploadIdx);
        UploadManager.setUploads({ uploads, channelId: channel.id, draftType: DraftType.ChannelMessage });
        // Empty titles and descriptions are allowed
        if (title != null) upload.filename = title;
        if (description != null) upload.description = description;

        FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId: channel.id });

        return await sendMessage(channel.id, {}, false, {
            ...MessageActions.getSendMessageOptionsForReply(reply),
            attachmentsToUpload: [upload]
        }).then(isCurrent, () => {
            if (isCurrent()) Toasts.show({ message: `Couldn't send ${filename}`, id: Toasts.genId(), type: Toasts.Type.FAILURE });
            return false;
        });
    } finally {
        clearTimeout(timeout);
        attachmentRequests.delete(controller);
    }
}

export function hasPermission(permission: bigint, channel: Channel | null): boolean {
    return !!channel && (PermissionStore.can(permission, channel) || channel.isPrivate());
}

const diacriticsRegex = /[\u0300-\u036f]/g;
function normalize(str: string) {
    return str.normalize("NFD").replace(diacriticsRegex, "").normalize("NFKC").toLowerCase().trim();
}

// Stolen from favGifSearch
function fuzzySearch(searchQuery: string, searchString: string) {
    let searchIndex = 0;
    let score = 0;

    for (let i = 0; i < searchString.length; i++) {
        if (searchString[i] === searchQuery[searchIndex]) {
            score++;
            searchIndex++;
        } else {
            score--;
        }

        if (searchIndex === searchQuery.length) {
            return score;
        }
    }

    return null;
}

export function useFavourites(itemFormat: CustomItemFormat, searchQuery?: string) {
    useEffect(() => void UserSettingsActionCreators.FrecencyUserSettingsActionCreators.loadIfNecessary(), []);

    const savedItems = useStateFromStores(
        [UserSettingsProtoStore],
        () => {
            const gifs: Record<string, FavouriteItem> | undefined =
                UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs?.gifs;
            return gifs ? Object.entries(gifs)
                .filter(([, item]) => item.format === FavouriteItemFormat.NONE)
                .map(([url, { src, order, width, height }]) => ({ url, src, order, width, height })) : null;
        },
        [],
        lodash.isEqual
    );
    const items = useMemo(() => savedItems?.flatMap(({ src, ...item }) => {
        const decoded = defs.decode(URL.parse(src)?.hash.slice(1) ?? "");
        return decoded?.data && decoded.format === itemFormat ? [{ ...item, ...decoded }] : [];
    }) ?? null, [savedItems, itemFormat]);

    const { state } = useStateFromStores(
        [UserSettingsProtoStore],
        () => {
            const query = searchQuery && normalize(searchQuery);

            if (!items) return { query, state: null };
            if (!query) return { query, state: items.toSorted((a, b) => b.order - a.order) };

            const state = items
                .map(item => ({
                    item,
                    score: fuzzySearch(query, normalize(defs.stringify(item.format, item.data)))
                }))
                .filter(({ score }) => score !== null)
                .sort((a, b) => b.score! - a.score!)
                .map(({ item }) => item);

            return { query, state };
        },
        [items, searchQuery],
        // Do not rerender components using this hook unless the query has changed or the items were loaded for the first time
        // This matches the behavior of the gif picker, where unfavouriting an item doesn't immediately hide it
        (prev, next) => !!prev.state === !!next.state && prev.query === next.query
    );

    return state;
}

// Helper hook for the ListScroller component, similar utility is used in the forum channel list view
// for keeping track of the individual row heights
export function useListScroller() {
    const rowHeights = useRef(new Map<Key, number>());
    const update = useForceUpdater();

    const handleResize = useCallback((key: Key, height: number) => {
        if (height === rowHeights.current.get(key)) return;

        rowHeights.current.set(key, height);
        update();
    }, []);

    return [rowHeights.current, handleResize] as const;
}
