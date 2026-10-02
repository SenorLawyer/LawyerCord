/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { applyPalette, GIFEncoder, quantize } from "gifenc";

interface EncodeRequest {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    delays: number[];
}

self.onmessage = ({ data }: MessageEvent<EncodeRequest>) => {
    const { pixels, width, height, delays } = data;
    const frameLength = width * height * 4;
    const palette = quantize(pixels, 255);
    const gif = GIFEncoder();
    for (let i = 0; i < delays.length; i++) {
        const index = applyPalette(pixels.subarray(i * frameLength, (i + 1) * frameLength), palette);
        gif.writeFrame(index, width, height, { delay: delays[i], palette: i === 0 ? palette : undefined });
    }
    gif.finish();
    const bytes = new Uint8Array(gif.bytesView());
    self.postMessage(bytes, { transfer: [bytes.buffer] });
};
