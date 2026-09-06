/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { isObject } from "@utils/misc";

import { removeRecentStickerByPackId } from "./components";
import { Sticker, StickerPack, StickerPackMeta } from "./types";

const PACKS_KEY = "MoreStickers:Packs";

function isSticker(value: unknown): value is Sticker {
    if (!isObject(value)) return false;
    const sticker = value as Record<string, unknown>;
    return typeof sticker.id === "string" && sticker.id.length > 0
        && typeof sticker.image === "string"
        && typeof sticker.title === "string"
        && typeof sticker.stickerPackId === "string" && sticker.stickerPackId.length > 0
        && (sticker.filename === undefined || typeof sticker.filename === "string")
        && (sticker.isAnimated === undefined || typeof sticker.isAnimated === "boolean");
}

export function isStickerPack(value: unknown): value is StickerPack {
    if (!isObject(value)) return false;
    const pack = value as Record<string, unknown>;
    if (pack.author !== undefined) {
        if (!isObject(pack.author)) return false;
        const author = pack.author as Record<string, unknown>;
        if (typeof author.name !== "string" || typeof author.url !== "string") return false;
    }
    if (pack.dynamic !== undefined) {
        if (!isObject(pack.dynamic)) return false;
        const dynamic = pack.dynamic as Record<string, unknown>;
        if (typeof dynamic.refreshUrl !== "string"
            || (dynamic.version !== undefined && typeof dynamic.version !== "string")
            || (dynamic.authHeaders !== undefined && (!isObject(dynamic.authHeaders) || !Object.values(dynamic.authHeaders).every(header => typeof header === "string")))) return false;
    }
    return typeof pack.id === "string" && pack.id.length > 0
        && typeof pack.title === "string" && isSticker(pack.logo)
        && Array.isArray(pack.stickers) && pack.stickers.every(isSticker);
}

/**
  * Convert StickerPack to StickerPackMeta
  *
  * @param {StickerPack} sp The StickerPack to convert.
  * @return {StickerPackMeta} The sticker pack metadata.
  */
function stickerPackToMeta(sp: StickerPack): StickerPackMeta {
    return {
        id: sp.id,
        title: sp.title = sp.title === "null" ? sp.id.match(/\d+/)?.[0] ?? sp.id : sp.title,
        author: sp.author,
        logo: sp.logo,
        dynamic: sp.dynamic,
    };
}

/**
  * Save a sticker pack to the DataStore
  *
  * @param {StickerPack} sp The StickerPack to save.
  * @return {Promise<void>}
  */
export async function saveStickerPack(sp: StickerPack, packsKey: string = PACKS_KEY): Promise<void> {
    const meta = stickerPackToMeta(sp);

    await Promise.all([
        DataStore.set(`MoreStickers:PackData:${sp.id}`, sp),
        DataStore.update<StickerPackMeta[]>(packsKey, packs => packs?.some(p => p.id === sp.id)
            ? packs.map(p => p.id === sp.id ? meta : p)
            : [...packs ?? [], meta])
    ]);
}

/**
  * Get sticker packs' metadata from the DataStore
  *
  * @return {Promise<StickerPackMeta[]>}
  */
export async function getStickerPackMetas(packsKey: string | undefined = PACKS_KEY): Promise<StickerPackMeta[]> {
    return await DataStore.get<StickerPackMeta[]>(packsKey) ?? [];
}

/**
 * Get a sticker pack from the DataStore
 *
 * @param {string} id The id of the sticker pack.
 * @return {Promise<StickerPack | null>}
 * */
export async function getStickerPack(id: string): Promise<StickerPack | null> {
    const pack = await DataStore.get<StickerPack | null>(`MoreStickers:PackData:${id}`);
    if (pack !== undefined) return pack;
    const legacy = await DataStore.get<StickerPack>(id);
    return legacy?.id === id && typeof legacy.title === "string" && Array.isArray(legacy.stickers) ? legacy : null;
}

/**
 * Delete a sticker pack from the DataStore
 *
 * @param {string} id The id of the sticker pack.
 * @return {Promise<void>}
 * */
export async function deleteStickerPack(id: string, packsKey: string = PACKS_KEY): Promise<void> {
    await Promise.all([
        DataStore.set(`MoreStickers:PackData:${id}`, null),
        removeRecentStickerByPackId(id),
        DataStore.update<StickerPackMeta[]>(packsKey, packs => packs?.filter(p => p.id !== id) ?? [])
    ]);
}
