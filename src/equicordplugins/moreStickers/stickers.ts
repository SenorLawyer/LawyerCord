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

function isStickerPackMeta(value: unknown): value is StickerPackMeta {
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
        && typeof pack.title === "string" && isSticker(pack.logo);
}

export function isStickerPack(value: unknown): value is StickerPack {
    return isStickerPackMeta(value) && "stickers" in value
        && Array.isArray(value.stickers) && value.stickers.every(isSticker);
}

/**
  * Save a sticker pack to the DataStore
  *
  * @param {StickerPack} sp The StickerPack to save.
  * @return {Promise<void>}
  */
export async function saveStickerPack(sp: StickerPack, packsKey: string = PACKS_KEY): Promise<void> {
    if (sp.title === "null") sp = { ...sp, title: sp.id.match(/\d+/)?.[0] ?? sp.id };
    const { id, title, author, logo, dynamic } = sp;
    const meta = { id, title, author, logo, dynamic };

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
    const packs = await DataStore.get<unknown>(packsKey) ?? [];
    if (!Array.isArray(packs) || !packs.every(isStickerPackMeta)) throw new Error("Saved sticker pack metadata is invalid.");
    return packs;
}

/**
 * Get a sticker pack from the DataStore
 *
 * @param {string} id The id of the sticker pack.
 * @return {Promise<StickerPack | null>}
 * */
export async function getStickerPack(id: string): Promise<StickerPack | null> {
    const stored = await DataStore.get<unknown>(`MoreStickers:PackData:${id}`);
    const pack = stored === undefined ? await DataStore.get<unknown>(id) : stored;
    return isStickerPack(pack) && pack.id === id ? pack : null;
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
