/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture(fetch: (url: string, options?: RequestInit) => Promise<Response>) {
    const code = transpileModule(readFileSync("src/equicordplugins/betterAudioPlayer/index.tsx", "utf8") + "\nexport { getAudioBlob };", { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, fetch, Blob, AbortController, DOMException, setTimeout, clearTimeout,
        require(name: string) {
            if (name === "@api/Settings") return { definePluginSettings: () => ({ store: {} }) };
            if (name === "@utils/css") return { classNameFactory: () => () => "" };
            if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value, OptionType: {} };
            if (name === "@utils/Logger") return { Logger: class { error() {} warn() {} } };
            return { EquicordDevs: {} };
        }
    });
}

test("Oversized audio without Content-Length stops streaming before the whole body", async () => {
    let pulls = 0;
    let cancelled = false;
    const api = fixture(async () => new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(7e6)); if (pulls === 20) controller.close(); },
        cancel() { cancelled = true; }
    })));
    assert.equal(await api.getAudioBlob("large", new AbortController().signal), null);
    assert.ok(pulls <= 3, `Consumed ${pulls} chunks`);
    assert.equal(cancelled, true);
});

test("Canceled audio requests keep admission slots until the underlying fetch settles", async () => {
    const releases: (() => void)[] = [];
    const api = fixture(() => new Promise<Response>(resolve => {
        releases.push(() => resolve(new Response("audio")));
    }));
    for (let i = 0; i < 50; i++) {
        const owner = new AbortController();
        const pending = api.getAudioBlob(String(i), owner.signal);
        owner.abort();
        await pending;
    }
    assert.equal(releases.length, 4);
    api.default.stop();
    assert.equal(await api.getAudioBlob("0", new AbortController().signal), null);
    assert.equal(await api.getAudioBlob("next", new AbortController().signal), null);
    assert.equal(releases.length, 4);
    for (const release of releases) release();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const retried = api.getAudioBlob("next", new AbortController().signal);
    assert.equal(releases.length, 5);
    releases[4]();
    assert.equal((await retried).size, 5);
});

test("Audio downloads share consumers, cancel when unused and bound active requests", async () => {
    const signals: AbortSignal[] = [];
    const api = fixture((_url, options) => new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    }));
    const first = new AbortController();
    const second = new AbortController();
    const a = api.getAudioBlob("same", first.signal);
    const b = api.getAudioBlob("same", second.signal);
    first.abort();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    second.abort();
    assert.equal(signals[0].aborted, true);
    await Promise.all([a, b]);
    const owner = new AbortController();
    const jobs = Array.from({ length: 50 }, (_, i) => api.getAudioBlob(String(i), owner.signal));
    assert.ok(signals.length <= 5);
    owner.abort();
    await Promise.all(jobs);
});
