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
    let allocations = 0;
    let fetches = 0;
    let decoded = 0;
    let batchDecoded = 0;
    const parsed = { lsd: { width: 2, height: 2 }, gct: [], frames: Array.from({ length: 2 }, () => ({ image: { descriptor: { width: 2, height: 2, left: 0, top: 0 } }, gce: { delay: 1, extras: { disposal: 1 } } })) };
    const modules: Record<string, unknown> = {
        "./encode": { encodeGif: async () => new Blob([new Uint8Array(1)]) },
        "@utils/misc": { sleep: async () => {} }, "../captions": { CAPTIONS: [] }, "../captions/caption": {},
        "gifenc": { GIFEncoder: () => ({ writeFrame() {}, finish() {}, bytesView: () => new Uint8Array(1) }), quantize: () => [[0, 0, 0]], applyPalette: () => new Uint8Array(4) },
        "gifuct-js": { parseGIF: () => parsed, decompressFrame: () => { decoded++; return { dims: { width: 2, height: 2, left: 0, top: 0 }, patch: new Uint8ClampedArray(16) }; }, decompressFrames: () => { batchDecoded++; return parsed.frames.map(() => ({ dims: { width: 2, height: 2, left: 0, top: 0 }, patch: new Uint8ClampedArray(16) })); } }
    };
    const load = (path: string) => {
        const { outputText } = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
        return runInNewContext(`${outputText}\nexports;`, {
            exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, Blob, URL, AbortController, setTimeout, clearTimeout, Uint8Array, Uint8ClampedArray,
            ImageData: class { constructor(public data: Uint8ClampedArray) {} },
            VencordNative: { pluginHelpers: { GifMaker: { fetchMedia: async () => { fetches++; return { data: new ArrayBuffer(8), type: "image/gif" }; } } } },
            document: { createElement: () => { allocations++; return { width: 2, height: 2, getContext: () => ({ clearRect() {}, save() {}, restore() {}, translate() {}, drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(16) }) }) }; } }
        });
    };
    const limits = "src/equicordplugins/gifMaker/utils/limits.ts";
    try { modules["./limits"] = load(limits); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    const { createGif } = load(process.env.AUDIT_GIF_BOUNDS_SOURCE ?? "src/equicordplugins/gifMaker/utils/encoder.ts") as { createGif(url: string, video: boolean, options: object, signal?: AbortSignal): Promise<Blob>; };
    return { parsed, run: (options: object = {}, signal?: AbortSignal) => createGif("https://media.tenor.com/test.gif", false, { width: 2, height: 2, captionMode: "none", ...options }, signal), allocations: () => allocations, fetches: () => fetches, decoded: () => decoded, batchDecoded: () => batchDecoded };
}

test("GifMaker rejects invalid output dimensions before fetching or allocating", async () => {
    const f = fixture();
    await assert.rejects(f.run({ width: Number.POSITIVE_INFINITY }));
    assert.equal(f.allocations(), 0);
    assert.equal(f.fetches(), 0);
});

test("GifMaker validates source dimensions before decompressing", async () => {
    const f = fixture();
    f.parsed.lsd.width = 65535;
    f.parsed.lsd.height = 65535;
    await assert.rejects(f.run());
    assert.equal(f.batchDecoded(), 0);
    assert.equal(f.decoded(), 0);
});

test("GifMaker validates every frame rectangle before decompressing", async () => {
    const f = fixture();
    f.parsed.frames[0].image.descriptor.width = 65535;
    await assert.rejects(f.run());
    assert.equal(f.batchDecoded(), 0);
    assert.equal(f.decoded(), 0);
});

test("GifMaker decodes only the current source frame", async () => {
    const f = fixture();
    await f.run();
    assert.equal(f.batchDecoded(), 0);
    assert.equal(f.decoded(), 2);
});

test("Cancelled GIF work never starts fetching", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.run({}, controller.signal));
    assert.equal(f.fetches(), 0);
});

test("GifMaker bounds source decoding work even when the output is tiny", async () => {
    const f = fixture();
    f.parsed.lsd = { width: 2048, height: 2048 };
    f.parsed.frames = Array.from({ length: 9 }, () => ({ image: { descriptor: { width: 2048, height: 2048, left: 0, top: 0 } }, gce: { delay: 1, extras: { disposal: 1 } } }));
    await assert.rejects(f.run());
    assert.equal(f.decoded(), 0);
    assert.equal(f.allocations(), 0);
});
