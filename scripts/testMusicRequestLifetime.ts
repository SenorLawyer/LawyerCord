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

import { readResponseText } from "../src/shared/readResponseText";

function requestFixture() {
    const pending: Array<{ resolve(value: Response): void; reject(reason: Error): void; signal: AbortSignal }> = [];
    const timers = new Map<number, () => void>();
    let id = 0;
    const code = transformSync(readFileSync("src/equicordplugins/musicControls/lyricsRequest.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const api = runInNewContext(`${code};module.exports`, { module: { exports: {} }, AbortController,
        require: (name: string) => name === "@shared/readResponseText" ? { readResponseText } : { Logger: class { warn() {} } },
        fetch: (_url: string, options: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject, signal: options.signal })),
        setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; }, clearTimeout: (key: number) => timers.delete(key)
    });
    return { api, pending, timers };
}

test("MusicControls retains bounded request slots until stopped work settles", async () => {
    const f = requestFixture();
    const work = Array.from({ length: 100 }, () => f.api.requestLyrics("https://lrclib.net/api/get").catch(() => null));
    assert.equal(f.pending.length, 8);
    f.api.stopLyricsRequests();
    f.api.startLyricsRequests();
    assert.ok(f.pending.every(request => request.signal.aborted));
    await f.api.requestLyrics("https://lrclib.net/api/get").catch(() => null);
    assert.equal(f.pending.length, 8);
    for (const request of f.pending) request.resolve(new Response("{}"));
    assert.ok((await Promise.all(work)).every(value => value === null));
    assert.equal(f.timers.size, 0);
    const next = f.api.requestLyrics("https://lrclib.net/api/get").catch(() => null);
    f.pending.at(-1)?.resolve(new Response('{"ok":true}'));
    assert.equal((await next).ok, true);
});

test("MusicControls deadlines and response limits release downloads", async () => {
    const f = requestFixture();
    const work = f.api.requestLyrics("https://lrclib.net/api/get").catch(() => null);
    for (const callback of f.timers.values()) callback();
    assert.equal(f.pending[0].signal.aborted, true);
    f.pending[0].resolve(new Response("{}"));
    assert.equal(await work, null);
    let cancelled = 0;
    const oversized = f.api.requestLyrics("https://lrclib.net/api/get").catch(() => null);
    f.pending[1].resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled++; } })));
    assert.equal(await oversized, null);
    assert.equal(cancelled, 1);
    assert.equal(f.timers.size, 0);
});

test("MusicControls does not resume queued lyric lines after stop and restart", async () => {
    const f = requestFixture();
    const code = transformSync(readFileSync("src/equicordplugins/musicControls/spotify/lyrics/providers/translator/index.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const api = runInNewContext(`${code};module.exports.lyricsAlternativeFetchers`, { module: { exports: {} }, URLSearchParams, require: (name: string) => name.endsWith("/settings") ? { settings: { store: { translateTo: "en" } } } : name.endsWith("/types") ? { Provider: { Translated: "Translated", Romanized: "Romanized" } } : f.api });
    const work = api.Translated(Array.from({ length: 100 }, (_, time) => ({ time, text: String(time) })));
    assert.equal(f.pending.length, 4);
    f.api.stopLyricsRequests();
    f.api.startLyricsRequests();
    for (const request of f.pending) request.resolve(new Response('{"sentences":[{"trans":"Old"}]}'));
    assert.equal(await work, null);
    assert.equal(f.pending.length, 4);
});

test("MusicControls translates long songs with at most four simultaneous requests", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const fetch = () => new Promise<Response>(resolve => {
        maximum = Math.max(maximum, ++active);
        pending.push(() => { active--; resolve(new Response(JSON.stringify({ sentences: [{ trans: "translated" }] }))); });
    });
    const code = transformSync(readFileSync("src/equicordplugins/musicControls/spotify/lyrics/providers/translator/index.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const api = runInNewContext(`${code};module.exports.lyricsAlternativeFetchers`, { module: { exports: {} }, URLSearchParams, fetch, require: (name: string) => name.endsWith("/settings") ? { settings: { store: { translateTo: "en" } } } : name.endsWith("/types") ? { Provider: { Translated: "Translated", Romanized: "Romanized" } } : { lyricsRequestGeneration: 0, requestLyrics: async (url: string) => (await fetch()).json() } });
    const task = api.Translated(Array.from({ length: 100 }, (_, time) => ({ time, text: String(time) })));
    assert.ok(maximum <= 4, `Started ${maximum} simultaneous requests`);
    for (let round = 0; round < 120; round++) {
        for (const resolve of pending.splice(0)) resolve();
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    }
    const result = await task;
    assert.equal(result.length, 100);
    assert.equal(result[99].text, "translated");
    assert.ok(maximum <= 4);
});

test("MusicControls preserves concurrent lyric cache writes and rejects cleared requests", async () => {
    const cache: Record<string, unknown> = { MusicControls_lyricsMigrated: true };
    const pending: Array<(value: object) => void> = [];
    const requests = { lyricsRequestGeneration: 0 };
    const code = transformSync(readFileSync("src/equicordplugins/musicControls/spotify/lyrics/api.tsx", "utf8"), { loader: "tsx", format: "cjs" }).code;
    const api = runInNewContext(`${code};module.exports`, { module: { exports: {} }, require: (name: string) => {
        if (name === "@api/index") return { DataStore: {
            get: async (key: string) => cache[key],
            set: async (key: string, value: unknown) => { cache[key] = value; },
            keys: async () => Object.keys(cache),
            delMany: async (keys: string[]) => { for (const key of keys) delete cache[key]; },
            setMany: async (entries: [string, unknown][]) => { for (const [key, value] of entries) cache[key] = value; }
        } };
        if (name.endsWith("/lyricsRequest")) return requests;
        if (name.endsWith("/settings")) return { settings: { store: { lyricsProvider: "LRCLIB", fallbackProvider: false } } };
        if (name.endsWith("/types")) return { Provider: { Lrclib: "LRCLIB", Spotify: "Spotify" } };
        return { getLyricsLrclib: () => new Promise(resolve => pending.push(resolve)) };
    } });
    const first = api.getLyrics({ id: "first" });
    const second = api.getLyrics({ id: "second" });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    pending[0]({ lyricsVersions: {} });
    pending[1]({ lyricsVersions: {} });
    await Promise.all([first, second]);
    assert.deepEqual(Object.keys(cache).filter(key => key.startsWith("MusicControls_lyrics_")).sort(), ["MusicControls_lyrics_first", "MusicControls_lyrics_second"]);
    const stale = api.getLyrics({ id: "stale" });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    await api.clearLyricsCache();
    pending[2]({ lyricsVersions: {} });
    assert.equal(await stale, null);
    assert.equal(Object.keys(cache).filter(key => key.startsWith("MusicControls_lyrics_")).length, 0);
});

test("MusicControls keeps provider fallback after HTTP or network errors", async () => {
    for (const [lyricsProvider, failure, fallbackProvider] of [["Spotify", "http", true], ["LRCLIB", "http", true], ["Spotify", "network", true], ["LRCLIB", "network", true], ["Spotify", "network", false], ["Spotify", "stop", true], ["Spotify", "429", false], ["Spotify", "500", false], ["Spotify", "http", false]] as const) {
        const f = requestFixture();
        const load = (path: string): Record<string, (...args: object[]) => Promise<unknown>> => {
            const code = transformSync(readFileSync(path, "utf8"), { loader: "tsx", format: "cjs" }).code;
            return runInNewContext(`${code};module.exports`, { module: { exports: {} }, URL, URLSearchParams, require: (name: string) => {
                if (name.endsWith("/lyricsRequest")) return f.api;
                if (name.endsWith("/settings")) return { settings: { store: { lyricsProvider, fallbackProvider } } };
                if (name.endsWith("/types")) return { Provider: { Lrclib: "LRCLIB", Spotify: "Spotify" } };
                if (name === "@api/index") return { DataStore: { get: async (key: string) => key === "MusicControls_lyricsMigrated" ? true : undefined, set: async () => {} } };
                if (name === "./providers/SpotifyAPI") return load("src/equicordplugins/musicControls/spotify/lyrics/providers/SpotifyAPI/index.ts");
                if (name === "./providers/lrclibAPI") return load("src/equicordplugins/musicControls/spotify/lyrics/providers/lrclibAPI/index.ts");
                throw new Error(name);
            } });
        };
        const api = load("src/equicordplugins/musicControls/spotify/lyrics/api.tsx");
        const work = api.getLyrics({ id: "track", name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration: 1000 });
        for (let tick = 0; tick < 20; tick++) await Promise.resolve();
        if (failure === "stop") f.api.stopLyricsRequests();
        if (failure === "http" || failure === "429" || failure === "500") f.pending[0].resolve(new Response("", { status: failure === "http" ? 404 : Number(failure) }));
        else f.pending[0].reject(new Error("Network failed"));
        for (let tick = 0; tick < 20; tick++) await Promise.resolve();
        if (!fallbackProvider || failure === "stop") {
            assert.equal(f.pending.length, 1);
            assert.equal(await work, null);
            if (failure === "429" || failure === "500" || failure === "http") {
                const retry = api.getLyrics({ id: "track", name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration: 1000 });
                for (let tick = 0; tick < 20; tick++) await Promise.resolve();
                assert.equal(f.pending.length, failure === "http" ? 1 : 2, "Transient HTTP errors must remain retryable");
                if (failure !== "http") f.pending[1].resolve(new Response("", { status: 404 }));
                assert.equal(await retry, null);
            }
            continue;
        }
        assert.equal(f.pending.length, 2);
        f.pending[1].resolve(new Response(JSON.stringify({ syncedLyrics: "[00:01]Words", lines: [{ startTimeMs: "1000", words: "Words" }, { startTimeMs: "2000", words: "Next" }] })));
        assert.ok(await work);
    }
});
