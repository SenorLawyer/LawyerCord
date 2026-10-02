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

import * as limits from "../src/equicordplugins/gifMaker/utils/limits";

function fixture(response: () => Response) {
    const calls: { url: URL; signal: AbortSignal; }[] = [];
    const timers = new Set<() => void>();
    const source = transpileModule(readFileSync("src/equicordplugins/gifMaker/native.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(`${source}\nexports;`, {
        exports: {}, require: () => limits, URL, AbortController,
        setTimeout: (callback: () => void) => { timers.add(callback); return callback; }, clearTimeout: (callback: () => void) => timers.delete(callback),
        fetch: async (url: URL, { signal }: { signal: AbortSignal; }) => { calls.push({ url, signal }); return response(); }
    }) as {
        fetchMedia(event: { senderFrame: object; }, url: unknown, id?: unknown): Promise<{ error?: string; data?: ArrayBuffer; }>;
        cancelMedia(event: { senderFrame: object; }, id: unknown): void;
    };
    return { api, calls, timers, event: { senderFrame: {} } };
}

test("GIF native cancellation owns one request and frame while consuming a stalled body", async () => {
    let cancelled = 0;
    const f = fixture(() => new Response(new ReadableStream({ cancel() { cancelled++; } })));
    const first = f.api.fetchMedia(f.event, "https://media.tenor.com/a.gif", "first");
    const second = f.api.fetchMedia(f.event, "https://media.tenor.com/b.gif", "second");
    await new Promise(resolve => setImmediate(resolve));
    f.api.cancelMedia({ senderFrame: {} }, "first");
    assert.equal(f.calls[0].signal.aborted, false);
    f.api.cancelMedia(f.event, "first");
    assert.ok((await first).error);
    assert.equal(f.calls[1].signal.aborted, false);
    assert.equal(f.timers.size, 1);
    for (const timer of f.timers) timer();
    assert.ok((await second).error);
    assert.equal(cancelled, 2);
    assert.equal(f.timers.size, 0);
});

test("GIF native rejects invalid destinations and cross-host redirects before reading", async () => {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: "https://example.com/media.gif" } }));
    for (const url of [123, "https://user@media.tenor.com/a.gif", "http://media.tenor.com/a.gif", "https://example.com/a.gif"]) assert.ok((await f.api.fetchMedia(f.event, url)).error);
    assert.equal(f.calls.length, 0);
    assert.ok((await f.api.fetchMedia(f.event, "https://media.tenor.com/a.gif")).error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
});

test("GIF media readers reject oversized declared or streamed data and empty media", async () => {
    let cancelled = 0;
    await assert.rejects(limits.readMediaResponse(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-length": String(limits.MAX_MEDIA_BYTES + 1) } })), /50 MB/);
    await assert.rejects(limits.readMediaResponse(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limits.MAX_MEDIA_BYTES + 1)); }, cancel() { cancelled++; } }))), /50 MB/);
    await assert.rejects(limits.readMediaResponse(new Response(new Blob())), /empty/);
    assert.equal(cancelled, 2);
});
