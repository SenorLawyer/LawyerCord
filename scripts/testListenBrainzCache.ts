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
    const timers = new Map<number, () => void>();
    let timerId = 0;
    function load(path: string, globals: Record<string, unknown>) {
        return runInNewContext(transpileModule(readFileSync(path, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText + "\nexports;", { exports: {}, ...globals });
    }
    const ttl = load("src/utils/TTLMap.ts", {
        setTimeout(callback: () => void, delay: number) {
            assert.equal(delay, 900_000);
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout: (id: number) => timers.delete(id)
    });
    const calls: string[] = [];
    const state = { tagged: false, empty: false, failed: false, artist: "Artist", pending: undefined as Promise<Response> | undefined };
    const api = load("src/plugins/musicRichPresence/listenbrainz.ts", {
        URLSearchParams,
        require(name: string) {
            if (name === "@utils/TTLMap") return ttl;
            if (name === "@utils/Logger") return { Logger: class { error() {} } };
            if (name === "@shared/vencordUserAgent") return { VENCORD_USER_AGENT: "fixture" };
            throw new Error(name);
        },
        async fetch(url: string) {
            calls.push(url);
            if (url.startsWith("https://api.listenbrainz.org"))
                return Response.json({ payload: { listens: [{ playing_now: true, track_metadata: { track_name: "Track", artist_name: state.artist, release_name: "Album", additional_info: state.tagged ? { recording_mbid: "track", release_group_mbid: "group" } : undefined } }] } });
            if (state.pending) return state.pending;
            if (state.failed) return new Response("failure", { status: 503 });
            if (url.startsWith("https://coverartarchive.org")) return Response.json({ images: [{ thumbnails: { large: "https://image.invalid/cover.png" } }] });
            return Response.json({ recordings: state.empty ? [] : [{ id: "track", releases: [{ id: "release", "release-group": { id: "group" } }] }] });
        }
    });
    return { api, state, timers, calls, read: () => api.ListenBrainzScrobbler.fetchTrackData("listener") };
}

test("ListenBrainz reuses metadata and art while fetching current playback every time", async () => {
    const f = fixture();
    const first = await f.read();
    assert.equal(first.imageURL, "https://image.invalid/cover.png");
    await f.read();
    assert.equal(f.calls.filter(url => url.includes("/playing-now")).length, 2);
    assert.equal(f.calls.filter(url => url.includes("musicbrainz.org/ws")).length, 1);
    assert.equal(f.calls.filter(url => url.includes("coverartarchive.org")).length, 1);
    f.state.tagged = true;
    await f.read();
    assert.equal(f.calls.filter(url => url.includes("coverartarchive.org")).length, 1);
    for (const expire of [...f.timers.values()]) expire();
    assert.equal(f.timers.size, 0);
    await f.read();
    assert.equal(f.calls.filter(url => url.includes("coverartarchive.org")).length, 2);
    f.api.clearListenBrainzCache();
    assert.equal(f.timers.size, 0);
});

test("ListenBrainz caches missing metadata, distinguishes tracks, and retries failures", async () => {
    const f = fixture();
    f.state.empty = true;
    await f.read(); await f.read();
    assert.equal(f.calls.filter(url => url.includes("musicbrainz.org/ws")).length, 1);
    f.state.artist = "Other artist";
    f.state.failed = true;
    assert.equal(await f.read(), null);
    f.state.failed = false;
    await f.read();
    assert.equal(f.calls.filter(url => url.includes("musicbrainz.org/ws")).length, 3);
    f.api.clearListenBrainzCache();
});

test("Clearing ListenBrainz caches prevents pending responses from creating new timers", async () => {
    const f = fixture();
    const response = Promise.withResolvers<Response>();
    f.state.pending = response.promise;
    const pending = f.read();
    await new Promise(resolve => setImmediate(resolve));
    f.api.clearListenBrainzCache();
    response.resolve(Response.json({ recordings: [] }));
    await pending;
    assert.equal(f.timers.size, 0);
});
