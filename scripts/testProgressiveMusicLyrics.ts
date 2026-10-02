/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    let reads = 0;
    let emissions = 0;
    let writes = 0;
    let finishTranslation: (value: unknown) => void = () => {};
    let enabled = true;
    const pending: (() => void)[] = [];
    let paused = false;
    const player = { track: { id: "one" } as { id: string; } | null };
    const api = { lyricsCacheGeneration: 0, async updateLyrics() { writes++; }, providers: ["LRCLIB"], async getLyrics() {
        reads++;
        if (paused) await new Promise<void>(resolve => { pending.push(resolve); });
        return { useLyric: "LRCLIB", lyricsVersions: { LRCLIB: [{ time: 0, text: "Words" }] } };
    } };
    let handlers: Record<string, (event: unknown) => Promise<void>> = {};
    class Store {
        constructor(_dispatcher: unknown, events: typeof handlers) { handlers = events; }
        emitChange() { emissions++; }
    }
    const settings = { lyricsConversion: "None", lyricsProvider: "LRCLIB", fallbackProvider: true, translateTo: "en" };
    const source = readFileSync("src/equicordplugins/musicControls/spotify/lyrics/providers/store.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const store = runInNewContext(code + "\nexports.SpotifyLrcStore;", { exports: {}, require(name: string) {
        if (name === "@webpack") return { proxyLazyWebpack: (factory: () => unknown) => factory() };
        if (name === "@webpack/common") return { Flux: { Store }, FluxDispatcher: { dispatch() {} } };
        if (name === "@api/PluginManager") return { isPluginEnabled: () => enabled };
        if (name.endsWith("/settings")) return { settings: { store: settings } };
        if (name.endsWith("/lyrics/api")) return api;
        if (name.endsWith("/SpotifyStore")) return { SpotifyStore: player };
        if (name === "./translator") return { lyricsAlternativeFetchers: { Translated: () => new Promise(resolve => { finishTranslation = resolve; }) } };
        if (name === "./types") return { Provider: { None: "None", Translated: "Translated", Romanized: "Romanized" } };
        return {};
    } });
    return { store, player, api, settings, writes: () => writes, translate: () => handlers.SPOTIFY_LYRICS_PROVIDER_CHANGE({ provider: "Translated" }), finishTranslation: () => finishTranslation([{ time: 0, text: "Old translation" }]), reads: () => reads, emissions: () => emissions, state: () => handlers.SPOTIFY_PLAYER_STATE({ track: player.track }), pause() { paused = true; }, release() { paused = false; pending.shift()?.(); }, disable() { enabled = false; store.destroy?.(); }, enable() { enabled = true; store.init(); } };
}

test("Settled Spotify state updates do not repeatedly read and deserialize the entire lyric history", async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) await f.state();
    assert.equal(f.reads(), 1);
    assert.equal(f.emissions(), 1);
    f.api.lyricsCacheGeneration++;
    await f.state();
    assert.equal(f.reads(), 2, "Explicit cache invalidation reloads the current song.");
    f.player.track = { id: "two" };
    await f.state();
    assert.equal(f.reads(), 3);
});

test("Stopped Spotify lyrics ignore late completion and further playback events", async () => {
    const f = fixture();
    f.pause();
    const pending = f.state();
    f.disable();
    f.release();
    await pending;
    await f.state();
    assert.equal(f.reads(), 1);
    assert.equal(f.emissions(), 0);
});



test("Old lyric completions cannot clear a restarted session's pending request", async () => {
    const f = fixture();
    f.pause();
    const old = f.state();
    f.disable();
    f.enable();
    const current = f.state();
    f.release();
    await old;
    await f.state();
    assert.equal(f.reads(), 2);
    f.release();
    await current;
    assert.equal(f.emissions(), 1);
});


test("Clearing saved lyrics while translating prevents stale translations being saved", async () => {
    const f = fixture();
    const work = f.translate();
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    f.api.lyricsCacheGeneration++;
    f.finishTranslation();
    await work;
    assert.equal(f.writes(), 0);
    assert.equal(f.emissions(), 0);
});
