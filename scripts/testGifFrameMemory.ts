/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { decompressFrames, parseGIF } from "gifuct-js";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Pixels { width: number; height: number; data: Uint8ClampedArray; }

async function fixture() {
    const path = process.env.AUDIT_GIF_ENCODER_SOURCE ?? "src/equicordplugins/gifMaker/utils/encoder.ts";
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    let canvases = 0;
    let palettePixels: Uint8Array | Uint8ClampedArray | undefined;
    const indexedBuffers: ArrayBufferLike[] = [];
    const encodedPixels: number[][] = [];
    const frames = Array.from({ length: 20 }, (_, i) => ({
        dims: { left: i % 2, top: 0, width: 1, height: 1 }, disposalType: [1, 3, 2, 1][i % 4], delay: (i + 1) * 10,
        patch: new Uint8ClampedArray([i * 10, 255 - i * 10, 50, 255])
    }));
    class Canvas {
        width = 2;
        height = 1;
        pixels = new Uint8ClampedArray(8);
        getContext() {
            const canvas = this;
            return {
                clearRect(x: number, y: number, w: number, h: number) {
                    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) canvas.pixels.fill(0, (row * canvas.width + col) * 4, (row * canvas.width + col + 1) * 4);
                },
                save() {}, restore() {}, translate() {},
                drawImage(source: Canvas, x: number, y: number) {
                    for (let row = 0; row < source.height; row++) for (let col = 0; col < source.width; col++) {
                        const pixel = source.pixels.subarray((row * source.width + col) * 4, (row * source.width + col + 1) * 4);
                        if (pixel[3]) canvas.pixels.set(pixel, ((row + y) * canvas.width + col + x) * 4);
                    }
                },
                getImageData: () => ({ data: new Uint8ClampedArray(canvas.pixels) }),
                putImageData(image: Pixels) { canvas.pixels = new Uint8ClampedArray(image.data); }
            };
        }
    }
    class ImageData {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    }
    const modules: Record<string, unknown> = {
        "@utils/misc": { sleep: async () => {} }, "../captions": { CAPTIONS: [] }, "../captions/caption": {},
        "gifuct-js": { parseGIF: () => ({ lsd: { width: 2, height: 1 } }), decompressFrames: () => frames },
        "gifenc": { GIFEncoder, quantize: (pixels: Uint8Array | Uint8ClampedArray, colors: number) => { palettePixels = pixels; return quantize(pixels, colors); },
            applyPalette: (pixels: Uint8Array | Uint8ClampedArray, palette: number[][]) => { indexedBuffers.push(pixels.buffer); encodedPixels.push(Array.from(pixels)); return applyPalette(pixels, palette); } }
    };
    const exports = {};
    runInNewContext(outputText, {
        exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        Blob, URL, Uint8Array, Uint8ClampedArray, ArrayBuffer, ImageData,
        VencordNative: { pluginHelpers: { gifMaker: { fetchMedia: async () => ({ data: new ArrayBuffer(8) }) } } },
        document: { createElement: (name: string) => { assert.equal(name, "canvas"); canvases++; return new Canvas(); } }
    });
    const encoder = exports as { createGif: (url: string, video: boolean, options: object) => Promise<Blob>; };
    const blob = await encoder.createGif("https://media.tenor.com/test.gif", false, { width: 2, height: 1, captionMode: "none" });
    const decoded = decompressFrames(parseGIF(await blob.arrayBuffer()), true);
    const expected: number[][] = [];
    let pixels = new Uint8ClampedArray(8);
    for (let i = 0; i < frames.length; i++) {
        if (i > 0) {
            const previous = frames[i - 1];
            if (previous.disposalType === 2) pixels.fill(0, previous.dims.left * 4, (previous.dims.left + 1) * 4);
            else if (previous.disposalType === 3 && i > 1) pixels = new Uint8ClampedArray(expected[i - 2]);
        }
        pixels.set(frames[i].patch, frames[i].dims.left * 4);
        expected.push(Array.from(pixels));
    }
    assert.deepEqual(encodedPixels, expected);
    assert.deepEqual(decoded.map(frame => frame.delay), frames.map(frame => frame.delay));
    assert.equal(decoded.length, frames.length);
    assert.deepEqual(Array.from(palettePixels ?? []), expected.flat());
    return { canvases, indexedBuffers, palettePixels };
}

test("GifMaker indexes views into its global palette buffer without retaining a second full set of output pixels", async () => {
    const f = await fixture();
    assert.ok(f.palettePixels);
    assert.ok(f.indexedBuffers.every(buffer => buffer === f.palettePixels?.buffer));
});

test("GifMaker retains a fixed number of source canvases while preserving frame disposal, colors and delays", async () => {
    const f = await fixture();
    assert.ok(f.canvases <= 5, `Created ${f.canvases} canvases for 20 frames.`);
});
