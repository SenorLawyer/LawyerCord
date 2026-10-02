/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Worker as NodeWorker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const workerSource = buildSync({ entryPoints: ["src/equicordplugins/gifMaker/utils/encode.worker.ts"], bundle: true, write: false, minify: true }).outputFiles[0].text;
const source = transpileModule(readFileSync("src/equicordplugins/gifMaker/utils/encode.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

function fixture(mode: "normal" | "startup" | "crash" = "normal") {
    let active = 0;
    let created = 0;
    let revoked = 0;
    const timers = new Set<() => void>();
    class Worker {
        onmessage = (_event: { data: Uint8Array; }) => {};
        onerror = () => {};
        worker: NodeWorker;
        terminated = false;
        constructor() {
            if (mode === "startup") throw new Error("Worker creation failed.");
            active++;
            this.worker = new NodeWorker(`const { parentPort } = require("node:worker_threads");
                globalThis.self = { postMessage(data, options) { parentPort.postMessage(data, options.transfer); } };
                parentPort.on("message", data => self.onmessage({ data }));
                ${mode === "crash" ? "throw Error('worker failed')" : workerSource}`, { eval: true });
            this.worker.on("message", data => this.onmessage({ data }));
            this.worker.on("error", () => this.onerror());
        }
        postMessage(data: object, transfer: ArrayBuffer[]) { this.worker.postMessage(data, transfer); }
        terminate() {
            if (this.terminated) return;
            this.terminated = true;
            active--;
            void this.worker.terminate();
        }
    }
    const api = runInNewContext(`${source}\nexports;`, {
        exports: {}, require: () => ({ default: workerSource }), Worker, Blob,
        URL: { createObjectURL: () => `blob:${++created}`, revokeObjectURL: () => revoked++ },
        setTimeout: (callback: () => void) => { timers.add(callback); return callback; }, clearTimeout: (callback: () => void) => timers.delete(callback)
    }) as { encodeGif(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, delays: number[], signal?: AbortSignal): Promise<Blob>; };
    return { ...api, timers, active: () => active, urls: () => ({ created, revoked }) };
}

test("GIF worker preserves byte-exact global palette output and transfers the sole RGBA buffer", async () => {
    const pixels = Uint8ClampedArray.from({ length: 16 * 16 * 4 * 3 }, (_, i) => i % 4 === 3 ? 255 : i * 37 % 256);
    const delays = [30, 100, 210];
    const palette = quantize(pixels, 255);
    const expected = GIFEncoder();
    for (let i = 0; i < delays.length; i++) expected.writeFrame(applyPalette(pixels.subarray(i * 1024, (i + 1) * 1024), palette), 16, 16, { delay: delays[i], palette: i === 0 ? palette : undefined });
    expected.finish();
    const f = fixture();
    const pending = f.encodeGif(pixels, 16, 16, delays);
    assert.equal(pixels.byteLength, 0);
    const blob = await pending;
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected.bytesView());
    assert.equal(f.active(), 0);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.urls(), { created: 1, revoked: 1 });
});

test("GIF worker leaves the calling event loop responsive during real quantization", async () => {
    const pixels = new Uint8ClampedArray(512 * 512 * 4 * 30);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 255 : (i * 37 + (i >>> 16)) % 256;
    const f = fixture();
    let ticks = 0;
    const interval = setInterval(() => ticks++, 5);
    try {
        await f.encodeGif(pixels, 512, 512, new Array(30).fill(30));
        assert.ok(ticks > 2, `Only ${ticks} event-loop callbacks ran while encoding.`);
    } finally {
        clearInterval(interval);
    }
});

test("GIF worker cancellation, deadline, startup failure and worker errors release workers and URLs", async () => {
    for (const mode of ["cancel", "deadline", "startup", "crash"] as const) {
        const f = fixture(mode === "startup" || mode === "crash" ? mode : "normal");
        const controller = new AbortController();
        const pending = f.encodeGif(new Uint8ClampedArray(1024 * 1024 * 4), 1024, 1024, [30], controller.signal);
        if (mode === "cancel") controller.abort();
        if (mode === "deadline") for (const timer of f.timers) timer();
        await assert.rejects(pending);
        assert.equal(f.active(), 0);
        assert.equal(f.timers.size, 0);
        assert.deepEqual(f.urls(), { created: 1, revoked: 1 });
    }
});
