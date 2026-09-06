/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Logger } from "@utils/Logger";
import { Toasts } from "@webpack/common";

import { getRecentStickers } from "./components/misc";
import { deleteStickerPack, getStickerPack, getStickerPackMetas, saveStickerPack } from "./stickers";
import { Sticker, StickerPack, StickerPackMeta } from "./types";

const PACKS_KEY = "MoreStickers:Packs";
const PACKS_KEY_OLD = "Vencord-MoreStickers-Packs";

const RECENT_STICKERS_KEY = "MoreStickers:RecentStickers";
const RECENT_STICKERS_KEY_OLD = "Vencord-MoreStickers-RecentStickers";
const logger = new Logger("MoreStickers");

function migrateStickerPackId(oldStickerPackId: string): string {
    if (oldStickerPackId.startsWith("Vencord-MoreStickers-Line-Pack")) {
        const id = oldStickerPackId.replace("Vencord-MoreStickers-Line-Pack-", "");
        return "MoreStickers:Line:Pack:" + id;
    } else if (oldStickerPackId.startsWith("Vencord-MoreStickers-Line-Emoji-Pack")) {
        const id = oldStickerPackId.replace("Vencord-MoreStickers-Line-Emoji-Pack-", "");
        return "MoreStickers:Line:Emoji-Pack:" + id;
    } else {
        return oldStickerPackId;
    }
}

function migrateStickerId(oldStickerId: string): string {
    if (oldStickerId.startsWith("Vencord-MoreStickers-Line-Sticker")) {
        const [stickerPackId, stickerId] = oldStickerId.replace("Vencord-MoreStickers-Line-Sticker", "").split("-", 2);
        return "MoreStickers:Line:Sticker:" + stickerPackId + ":" + stickerId;
    } else if (oldStickerId.startsWith("Vencord-MoreStickers-Line-Emoji")) {
        const [stickerPackId, stickerId] = oldStickerId.replace("Vencord-MoreStickers-Line-Emoji", "").split("-", 2);
        return "MoreStickers:Line-Emoji:" + stickerPackId + ":" + stickerId;
    } else {
        return oldStickerId;
    }
}

function migrateSticker(oldSticker: Sticker): Sticker {
    return {
        ...oldSticker,
        id: migrateStickerId(oldSticker.id),
        stickerPackId: migrateStickerPackId(oldSticker.stickerPackId),
    };
}

function migrateStickerPack(oldStickerPack: StickerPack): StickerPack {
    return {
        ...oldStickerPack,
        id: migrateStickerPackId(oldStickerPack.id),
        logo: migrateSticker(oldStickerPack.logo),
        stickers: oldStickerPack.stickers.map(migrateSticker),
    };
}

export async function isV1() {
    return (await getStickerPackMetas(PACKS_KEY_OLD)).length > 0
        || (await getRecentStickers(RECENT_STICKERS_KEY_OLD)).length > 0;
}

export async function migrate() {
    const newPackMetas = await getStickerPackMetas(PACKS_KEY);
    let oldPackMetas = await getStickerPackMetas(PACKS_KEY_OLD);

    for (const oldStickerPackMeta of oldPackMetas) {
        try {
            const newId = migrateStickerPackId(oldStickerPackMeta.id);
            if (!newPackMetas.some(pack => pack.id === newId) || await getStickerPack(newId) === null) {
                const oldStickerPack = await getStickerPack(oldStickerPackMeta.id);
                if (oldStickerPack === null) continue;
                await saveStickerPack(migrateStickerPack(oldStickerPack), PACKS_KEY);
            }
            if (newId === oldStickerPackMeta.id) {
                await DataStore.update<StickerPackMeta[]>(PACKS_KEY_OLD, packs => packs?.filter(pack => pack.id !== oldStickerPackMeta.id) ?? []);
            } else {
                await deleteStickerPack(oldStickerPackMeta.id, PACKS_KEY_OLD);
            }
        } catch (e) {
            logger.error("Failed to migrate sticker pack", e);
        }
    }

    oldPackMetas = await getStickerPackMetas(PACKS_KEY_OLD);
    if (oldPackMetas.length > 0) {
        Toasts.show({
            message: "Migration incomplete. Some sticker packs could not be migrated.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 1000 }
        });
        return;
    }
    await DataStore.del(PACKS_KEY_OLD);

    const oldRecentStickers = await getRecentStickers(RECENT_STICKERS_KEY_OLD);
    if (oldRecentStickers.length > 0) {
        const newRecentStickers = oldRecentStickers.map(migrateSticker);
        await DataStore.update<Sticker[]>(RECENT_STICKERS_KEY, current =>
            [...current ?? [], ...newRecentStickers.filter(sticker => !current?.some(existing => existing.id === sticker.id))].slice(0, 16));
    }
    await DataStore.del(RECENT_STICKERS_KEY_OLD);

    Toasts.show({
        message: "Sticker Pack Migration Complete",
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: {
            duration: 1000
        }
    });
}
