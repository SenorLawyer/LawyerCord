/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Toasts } from "@webpack/common";

import { settings } from "../settings";
import { Collection, Gif } from "../types";
import { getFormat } from "./getFormat";
import { logger } from "./misc";

export const DATA_COLLECTION_NAME = "gif-collections-collections";

export let cache_collections: Collection[] = [];
const collectionNameByGifId = new Map<string, string>();
const gifById = new Map<string, Gif>();

function rebuildLookupCaches(collections: Collection[]) {
    collectionNameByGifId.clear();
    gifById.clear();

    for (const collection of collections) {
        for (const gif of collection.gifs) {
            collectionNameByGifId.set(gif.id, collection.name);
            gifById.set(gif.id, gif);
        }
    }
}

export const getCollections = async (): Promise<Collection[]> => (await DataStore.get<Collection[]>(DATA_COLLECTION_NAME)) ?? [];

async function saveCollections(collections: Collection[]) {
    cache_collections = collections;
    rebuildLookupCaches(collections);
    await DataStore.set(DATA_COLLECTION_NAME, collections);
}

export const refreshCacheCollection = async (): Promise<void> => {
    const collections = await getCollections();
    cache_collections = collections;
    rebuildLookupCaches(collections);
};

export async function createCollection(name: string, gifs: Gif[]): Promise<void> {
    const collections = [...cache_collections];
    const fullName = `${settings.store.collectionPrefix}${name}`;

    if (collections.some(c => c.name === fullName)) {
        Toasts.show({ message: "That collection already exists", type: Toasts.Type.FAILURE, id: Toasts.genId(), options: { duration: 3000, position: Toasts.Position.BOTTOM } });
        return;
    }

    const latestGifSrc = gifs[gifs.length - 1]?.src ?? settings.store.defaultEmptyCollectionImage;
    collections.push({
        name: fullName,
        src: latestGifSrc,
        format: getFormat(latestGifSrc),
        type: "Category",
        gifs,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
    });

    await saveCollections(collections);
}

export async function addToCollection(name: string, gif: Gif): Promise<void> {
    const collections = [...cache_collections];
    const collection = collections.find(c => c.name === name);
    if (!collection) return void logger.warn("Collection not found");

    if (settings.store.preventDuplicates && collection.gifs.some(g => g.url === gif.url)) {
        Toasts.show({ message: "This GIF is already in the collection", type: Toasts.Type.FAILURE, id: Toasts.genId(), options: { duration: 3000, position: Toasts.Position.BOTTOM } });
        return;
    }

    collection.gifs = [...collection.gifs, { ...gif, addedAt: Date.now() }];
    collection.src = gif.src;
    collection.format = getFormat(gif.src);
    collection.lastUpdated = Date.now();

    await saveCollections(collections);
}

export async function renameCollection(oldName: string, newName: string): Promise<void> {
    const collections = [...cache_collections];
    const collection = collections.find(c => c.name === oldName);
    if (!collection) return void logger.warn("Collection not found");

    collection.name = `${settings.store.collectionPrefix}${newName}`;
    collection.lastUpdated = Date.now();

    await saveCollections(collections);
}

export async function removeFromCollection(id: string): Promise<void> {
    const collections = [...cache_collections];
    const collection = collections.find(c => c.gifs.some(g => g.id === id));
    if (!collection) return void logger.warn("Collection not found");

    collection.gifs = collection.gifs.filter(g => g.id !== id);
    const latestGifSrc = collection.gifs.length ? collection.gifs[collection.gifs.length - 1].src : settings.store.defaultEmptyCollectionImage;
    collection.src = latestGifSrc;
    collection.format = getFormat(latestGifSrc);
    collection.lastUpdated = Date.now();

    await saveCollections(collections);
}

export async function deleteCollection(name: string): Promise<void> {
    await saveCollections(cache_collections.filter(c => c.name !== name));
}

export async function moveGifToCollection(gifId: string, fromName: string, toName: string): Promise<void> {
    const collections = [...cache_collections];
    const from = collections.find(c => c.name === fromName);
    const to = collections.find(c => c.name === toName);
    if (!from || !to) return void logger.warn("Collection not found");

    const gifIndex = from.gifs.findIndex(g => g.id === gifId);
    if (gifIndex === -1) return void logger.warn("Gif not found");

    const gif = { ...from.gifs[gifIndex], addedAt: Date.now() };
    from.gifs = from.gifs.filter((_, i) => i !== gifIndex);
    to.gifs = [...to.gifs, gif];

    const updateCollectionMeta = (col: Collection) => {
        const latest = col.gifs.length ? col.gifs[col.gifs.length - 1].src : settings.store.defaultEmptyCollectionImage;
        col.src = latest;
        col.format = getFormat(latest);
        col.lastUpdated = Date.now();
    };

    updateCollectionMeta(from);
    updateCollectionMeta(to);

    await saveCollections(collections);
}

export async function updateGifUrls(ids: Set<string>, urls: Record<string, string>): Promise<boolean> {
    let changed = false;
    const collections = cache_collections.map(collection => {
        let updated = false;
        const gifs = collection.gifs.map(gif => {
            if (!ids.has(gif.id)) return gif;
            const src = urls[gif.src] ?? gif.src;
            const url = urls[gif.url] ?? gif.url;
            if (src === gif.src && url === gif.url) return gif;
            updated = true;
            return { ...gif, src, url };
        });
        if (!updated) return collection;
        changed = true;
        return { ...collection, gifs, lastUpdated: Date.now() };
    });
    if (changed) await saveCollections(collections);
    return changed;
}

export function getItemCollectionNameFromId(id: string): string | undefined {
    return collectionNameByGifId.get(id);
}

export function getGifById(id: string): Gif | undefined {
    return gifById.get(id);
}
