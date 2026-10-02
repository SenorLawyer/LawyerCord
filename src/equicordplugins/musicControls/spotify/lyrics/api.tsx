/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { lyricsRequestGeneration } from "@equicordplugins/musicControls/lyricsRequest";
import { settings } from "@equicordplugins/musicControls/settings";
import { Track } from "@equicordplugins/musicControls/spotify/SpotifyStore";

import { getLyricsLrclib } from "./providers/lrclibAPI";
import { getLyricsSpotify } from "./providers/SpotifyAPI";
import { LyricsData, Provider, SyncedLyric } from "./providers/types";

export let lyricsCacheGeneration = 0;

const LyricsCacheKey = "SpotifyLyricsCacheNew";
const LyricsPrefix = "MusicControls_lyrics_";
const LyricsMigrationKey = "MusicControls_lyricsMigrated";
let cacheReady: Promise<void> | undefined;

function ensureLyricsCache(): Promise<void> {
    if (cacheReady) return cacheReady;
    const pending = (async () => {
        if (await DataStore.get<boolean>(LyricsMigrationKey)) return;
        const [legacy, old] = await Promise.all([
            DataStore.get<Record<string, LyricsData | null>>(LyricsCacheKey),
            DataStore.get<Record<string, SyncedLyric[] | null>>("SpotifyLyricsCache")
        ]);
        const migrated: Record<string, LyricsData | null> = { ...legacy };
        for (const [id, lyrics] of Object.entries(old ?? {})) {
            if (lyrics && !migrated[id]) migrated[id] = { useLyric: Provider.Lrclib, lyricsVersions: { [Provider.Lrclib]: lyrics } };
        }
        const entries: [IDBValidKey, unknown][] = Object.entries(migrated)
            .filter(([, lyrics]) => lyrics !== null)
            .map(([id, lyrics]) => [LyricsPrefix + id, lyrics]);
        entries.push([LyricsMigrationKey, true]);
        await DataStore.setMany(entries);
    })();
    cacheReady = pending;
    void pending.catch(() => { if (cacheReady === pending) cacheReady = undefined; });
    return pending;
}

async function lyricKeys(): Promise<string[]> {
    return (await DataStore.keys()).filter((key): key is string => typeof key === "string" && key.startsWith(LyricsPrefix));
}

interface NullLyricCacheEntry {
    [Provider.Lrclib]?: boolean;
    [Provider.Spotify]?: boolean;
}

const nullLyricCache = new Map<string, NullLyricCacheEntry>();

export const lyricFetchers = {
    [Provider.Spotify]: async (track: Track) => await getLyricsSpotify(track.id, settings.store.spotifyLyricsApiUrl),
    [Provider.Lrclib]: getLyricsLrclib,
};

export const providers = Object.keys(lyricFetchers) as Provider[];

export async function getLyrics(track: Track | null): Promise<LyricsData | null> {
    if (!track || !track.id) return null;

    const generation = lyricsRequestGeneration;
    const cacheGeneration = lyricsCacheGeneration;
    const cacheKey = track.id;
    await ensureLyricsCache();
    const cached = await DataStore.get<LyricsData>(LyricsPrefix + cacheKey);

    if (generation !== lyricsRequestGeneration || cacheGeneration !== lyricsCacheGeneration) return null;
    if (cached) return cached;

    const nullCacheEntry = nullLyricCache.get(cacheKey);

    if (nullCacheEntry) {
        const provider = settings.store.lyricsProvider;
        if (!settings.store.fallbackProvider && nullCacheEntry[provider]) {
            return null;
        }

        if (providers.every(p => nullCacheEntry[p])) {
            return null;
        }
    }

    const providersToTry = settings.store.fallbackProvider
        ? [settings.store.lyricsProvider, ...providers.filter(p => p !== settings.store.lyricsProvider)]
        : [settings.store.lyricsProvider];

    for (const provider of providersToTry) {
        let lyricsInfo: LyricsData | null;
        try {
            lyricsInfo = await lyricFetchers[provider](track);
        } catch {
            if (generation !== lyricsRequestGeneration || cacheGeneration !== lyricsCacheGeneration) return null;
            continue;
        }

        if (generation !== lyricsRequestGeneration || cacheGeneration !== lyricsCacheGeneration) return null;
        if (lyricsInfo) {
            await DataStore.set(LyricsPrefix + cacheKey, lyricsInfo);
            return lyricsInfo;
        }

        const updatedNullCacheEntry = nullLyricCache.get(cacheKey) || {};
        nullLyricCache.set(cacheKey, { ...updatedNullCacheEntry, [provider]: true });
        if (nullLyricCache.size > 500) nullLyricCache.delete(nullLyricCache.keys().next().value ?? cacheKey);
    }

    return null;
}

export async function clearLyricsCache() {
    lyricsCacheGeneration++;
    nullLyricCache.clear();
    const ready = ensureLyricsCache();
    const pending = ready.then(async () => {
        await DataStore.delMany(await lyricKeys());
        await DataStore.setMany([[LyricsCacheKey, {}], ["SpotifyLyricsCache", {}]]);
    });
    cacheReady = pending;
    try {
        await pending;
    } finally {
        if (cacheReady === pending) cacheReady = undefined;
    }
}

export async function getLyricsCount(): Promise<number> {
    await ensureLyricsCache();
    return (await lyricKeys()).length;
}

export async function updateLyrics(trackId: string, newLyrics: SyncedLyric[], provider: Provider) {
    const generation = lyricsCacheGeneration;
    await ensureLyricsCache();
    if (generation !== lyricsCacheGeneration) return;
    await DataStore.update<LyricsData>(LyricsPrefix + trackId, current => ({
        useLyric: provider,
        lyricsVersions: { ...current?.lyricsVersions, [provider]: newLyrics }
    }));
}

export async function removeTranslations() {
    lyricsCacheGeneration++;
    const ready = ensureLyricsCache();
    const pending = ready.then(async () => {
        const keys = await lyricKeys();
        for (let offset = 0; offset < keys.length; offset += 100) {
            const batch = keys.slice(offset, offset + 100);
            const entries = await DataStore.getMany<LyricsData>(batch);
            await DataStore.setMany(entries.map((entry, index) => {
                const { Translated, ...lyricsVersions } = entry.lyricsVersions;
                return [batch[index], { lyricsVersions, useLyric: lyricsVersions[Provider.Spotify] ? Provider.Spotify : Provider.Lrclib }];
            }));
        }
        const legacy = await DataStore.get<Record<string, LyricsData | null>>(LyricsCacheKey);
        const updated: Record<string, LyricsData> = {};
        for (const [id, entry] of Object.entries(legacy ?? {})) {
            if (!entry) continue;
            const { Translated, ...lyricsVersions } = entry.lyricsVersions;
            updated[id] = { lyricsVersions, useLyric: lyricsVersions[Provider.Spotify] ? Provider.Spotify : Provider.Lrclib };
        }
        await DataStore.set(LyricsCacheKey, updated);
    });
    cacheReady = pending;
    try {
        await pending;
    } finally {
        if (cacheReady === pending) cacheReady = undefined;
    }
}

export async function migrateOldLyrics() {
    await ensureLyricsCache();
}
