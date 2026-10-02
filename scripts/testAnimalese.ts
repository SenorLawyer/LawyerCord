/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const { outputText } = transpileModule(readFileSync("src/equicordplugins/animalese/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

function fixture() {
    const requests: { url: string; signal?: AbortSignal; resolve(value: unknown): void; reject(error: Error): void; }[] = [];
    const contexts: AudioContextMock[] = [];
    const errors: unknown[] = [];
    const store = { soundQuality: "high", speed: 1, pitch: 1, volume: 0.5, messageLengthLimit: 50, processOwnMessages: true };
    class AudioContextMock {
        sampleRate = 100;
        plays = 0;
        closed = false;
        constructor() { contexts.push(this); }
        async close() { this.closed = true; }
        async decodeAudioData() { return { length: 10, getChannelData: () => new Float32Array(10) }; }
        createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
        createBufferSource() { return { playbackRate: {}, connect() {}, start: () => { this.plays++; } }; }
        createGain() { return { gain: {}, connect() {} }; }
    }
    const mocks: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: (def: unknown) => ({ store, def }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "channel" }, UserStore: { getCurrentUser: () => ({ id: "user" }) } }
    };
    const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, AudioContext: AudioContextMock, AbortController,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        fetch: (url: string, options?: { signal: AbortSignal }) => new Promise((resolve, reject) => requests.push({ url, signal: options?.signal, resolve, reject })),
        console: { error: (...args: unknown[]) => errors.push(args) }
    });
    const settle = (first: number) => {
        for (const request of requests.slice(first, first + 30)) request.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
    };
    const message = () => plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", channelId: "channel", message: { content: "hello", author: { id: "other" } } });
    return { plugin, requests, contexts, errors, store, settle, message };
}

test("Animalese cancels loads on stop and pending messages cannot recreate playback", async () => {
    const f = fixture();
    const starting = f.plugin.start();
    const message = f.message();
    assert.equal(f.requests.length, 30);
    f.plugin.stop();
    assert.ok(f.requests.every(request => request.signal?.aborted));
    f.settle(0);
    await Promise.all([starting, message]);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].closed, true);
    assert.equal(f.contexts[0].plays, 0);
    assert.equal(f.errors.length, 0);
});

test("Animalese reuses a loaded quality while cancelling a replaced download", async () => {
    const f = fixture();
    f.plugin.start();
    f.settle(0);
    await setImmediate();
    f.store.soundQuality = "low";
    f.plugin.settings.def.soundQuality.onChange();
    assert.equal(f.requests.length, 60);
    f.store.soundQuality = "high";
    f.plugin.settings.def.soundQuality.onChange();
    assert.ok(f.requests.slice(30).every(request => request.signal?.aborted));
    f.settle(30);
    await setImmediate();
    await f.message();
    assert.equal(f.requests.length, 60);
    assert.equal(f.contexts[0].plays, 1);
    f.plugin.stop();
});

test("Animalese reports failed downloads once and permits a fresh attempt", async () => {
    const f = fixture();
    f.plugin.start();
    const failed = f.message();
    f.requests[0].reject(new Error("Network failure"));
    await failed;
    assert.equal(f.errors.length, 1);
    assert.equal(f.contexts[0].plays, 0);
    assert.ok(f.requests.every(request => request.signal?.aborted));
    const retry = f.message();
    assert.equal(f.requests.length, 60);
    f.settle(0);
    f.settle(30);
    await retry;
    assert.equal(f.contexts[0].plays, 1);
    f.plugin.stop();
});

test("Animalese restarts and quality changes load independently of obsolete requests", async () => {
    const f = fixture();
    const first = f.plugin.start();
    f.plugin.stop();
    const second = f.plugin.start();
    assert.equal(f.requests.length, 60);
    f.store.soundQuality = "low";
    f.plugin.settings.def.soundQuality.onChange();
    assert.equal(f.requests.length, 90);
    assert.ok(f.requests.slice(30, 60).every(request => request.signal?.aborted));
    assert.ok(f.requests.slice(60).every(request => request.url.includes("/low/")));
    f.settle(60);
    await setImmediate();
    await f.message();
    assert.equal(f.contexts[1].plays, 1);
    f.settle(0);
    f.settle(30);
    await Promise.all([first, second]);
    await f.message();
    assert.equal(f.requests.length, 90);
    assert.equal(f.contexts[1].plays, 2);
    f.plugin.stop();
    assert.equal(f.errors.length, 0);
});
