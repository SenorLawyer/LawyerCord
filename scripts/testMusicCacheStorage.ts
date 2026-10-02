/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

function fixture() {
    const lyric = { useLyric: "LRCLIB", lyricsVersions: { LRCLIB: [{ time: 0, text: "Original" }], Translated: [{ time: 0, text: "Translation" }] } };
    const legacy = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), lyric]));
    const values = new Map<string, unknown>([["SpotifyLyricsCacheNew", legacy], ["SpotifyLyricsCache", {}]]);
    let legacyReads = 0;
    let migrationBarrier: Promise<void> | undefined;
    const data = {
        get: async (key: string) => { if (key === "SpotifyLyricsCacheNew") legacyReads++; return structuredClone(values.get(key)); },
        set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        getMany: async (keys: string[]) => keys.map(key => structuredClone(values.get(key))),
        setMany: async (entries: [string, unknown][]) => { await migrationBarrier; for (const [key, value] of entries) values.set(key, structuredClone(value)); },
        delMany: async (keys: string[]) => { for (const key of keys) values.delete(key); },
        keys: async () => [...values.keys()],
        update: async (key: string, updater: (value: unknown) => unknown) => { values.set(key, structuredClone(updater(structuredClone(values.get(key))))); }
    };
    const source = readFileSync("src/equicordplugins/musicControls/spotify/lyrics/api.tsx", "utf8");
    const code = transformSync(source, { loader: "tsx", format: "cjs" }).code;
    const load = () => runInNewContext(`${code};module.exports`, { module: { exports: {} }, require: (name: string) => {
        if (name === "@api/index") return { DataStore: data };
        if (name.endsWith("/lyricsRequest")) return { lyricsRequestGeneration: 0 };
        if (name.endsWith("/settings")) return { settings: { store: { lyricsProvider: "LRCLIB", fallbackProvider: false } } };
        if (name.endsWith("/types")) return { Provider: { Lrclib: "LRCLIB", Spotify: "Spotify" } };
        return { getLyricsLrclib: async () => lyric };
    } });
    return { api: load(), load, values, legacy, reads: () => legacyReads, pauseMigration() {
        let release = () => {};
        migrationBarrier = new Promise<void>(resolve => { release = resolve; });
        return release;
    } };
}

test("MusicControls reads individual tracks without cloning saved lyric history", async () => {
    const f = fixture();
    await f.api.migrateOldLyrics();
    const reads = f.reads();
    for (let index = 0; index < 100; index++) {
        const result = await f.api.getLyrics({ id: String(index) });
        assert.equal(result.lyricsVersions.Translated[0].text, "Translation");
    }
    assert.equal(f.reads() - reads, 0, "Playback reread the complete 1,000-track history");
    assert.equal(await f.api.getLyricsCount(), 1000);
    assert.deepEqual(f.values.get("SpotifyLyricsCacheNew"), f.legacy);
    const reloaded = f.load();
    await reloaded.getLyrics({ id: "0" });
    assert.equal(f.reads(), reads, "Restart must use the migration marker");
});

test("MusicControls translation updates and clear preserve per-track history semantics", async () => {
    const f = fixture();
    await f.api.migrateOldLyrics();
    await f.api.updateLyrics("0", [{ time: 0, text: "New translation" }], "Translated");
    assert.equal((await f.api.getLyrics({ id: "0" })).lyricsVersions.Translated[0].text, "New translation");
    await f.api.removeTranslations();
    const result = await f.api.getLyrics({ id: "0" });
    assert.equal(result.lyricsVersions.Translated, undefined);
    assert.equal(result.lyricsVersions.LRCLIB[0].text, "Original");
    assert.equal(await f.api.getLyricsCount(), 1000);
    await f.api.clearLyricsCache();
    assert.equal(await f.api.getLyricsCount(), 0);
    assert.equal(await f.load().getLyricsCount(), 0);
    assert.deepEqual(f.values.get("SpotifyLyricsCacheNew"), {});
    assert.deepEqual(f.values.get("SpotifyLyricsCache"), {});
});

test("MusicControls clear waits for migration and cannot resurrect legacy history", async () => {
    const f = fixture();
    const release = f.pauseMigration();
    const migration = f.api.migrateOldLyrics();
    const clear = f.api.clearLyricsCache();
    release();
    await Promise.all([migration, clear]);
    assert.equal(await f.load().getLyricsCount(), 0);
    assert.deepEqual(f.values.get("SpotifyLyricsCacheNew"), {});
});
