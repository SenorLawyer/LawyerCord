/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationAssetUtils } from "@webpack/common";

const MAX_APPLICATION_ASSET_CACHE_SIZE = 150;
const applicationAssetCache = new Map<string, Promise<string>>();

function pruneOldestAsset() {
    const oldestKey = applicationAssetCache.keys().next().value;
    if (oldestKey !== undefined) applicationAssetCache.delete(oldestKey);
}

export function getCachedApplicationAsset(applicationId: string, key: string): Promise<string> {
    const cacheKey = `${applicationId}:${key}`;
    const cachedAsset = applicationAssetCache.get(cacheKey);
    if (cachedAsset) return cachedAsset;

    if (applicationAssetCache.size >= MAX_APPLICATION_ASSET_CACHE_SIZE) pruneOldestAsset();

    const assetPromise = ApplicationAssetUtils.fetchAssetIds(applicationId, [key])
        .then(assetIds => assetIds[0]!)
        .catch(error => {
            if (applicationAssetCache.get(cacheKey) === assetPromise) applicationAssetCache.delete(cacheKey);
            throw error;
        });

    applicationAssetCache.set(cacheKey, assetPromise);
    return assetPromise;
}
