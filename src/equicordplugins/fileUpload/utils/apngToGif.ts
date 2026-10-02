/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";
import { Logger } from "@utils/Logger";
import { Queue } from "@utils/Queue";

const logger = new Logger("FileUpload");
const queue = new Queue();
const MAX_BYTES = 50 * 1024 * 1024;
let pendingJobs = 0;
let pendingBytes = 0;

function validatePng(data: ArrayBuffer) {
    const view = new DataView(data);
    if (view.byteLength < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
        throw new Error("The image is not a valid PNG.");
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    let frames = 1;
    let frameHeaders = 0;
    if (!width || !height || width * height > 4 * 1024 * 1024) throw new Error("The image dimensions are too large.");
    for (let offset = 8; offset < view.byteLength;) {
        if (offset + 12 > view.byteLength) throw new Error("The PNG is incomplete.");
        const length = view.getUint32(offset);
        if (length > view.byteLength - offset - 12) throw new Error("The PNG is incomplete.");
        const type = view.getUint32(offset + 4);
        if (type === 0x6163544c) {
            if (length !== 8) throw new Error("The animation header is invalid.");
            frames = view.getUint32(offset + 8);
            if (!frames || frames > 200 || width * height * frames > 32 * 1024 * 1024)
                throw new Error("The animation is too large to convert.");
        } else if (type === 0x6663544c) {
            if (++frameHeaders > frames) throw new Error("The animation has too many frames.");
            if (length !== 26) throw new Error("The animation frame is invalid.");
            const frameWidth = view.getUint32(offset + 12);
            const frameHeight = view.getUint32(offset + 16);
            if (!frameWidth || !frameHeight || frameWidth + view.getUint32(offset + 20) > width || frameHeight + view.getUint32(offset + 24) > height)
                throw new Error("The animation frame dimensions are invalid.");
        }
        offset += length + 12;
    }
    return frames;
}

async function convert(blob: Blob, signal?: AbortSignal, resolution?: number): Promise<Blob | null> {
    let ff: FFmpeg | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => ff?.terminate();
    try {
        signal?.throwIfAborted();
        if (resolution !== undefined && (!Number.isSafeInteger(resolution) || resolution < 16 || resolution > 512)) throw new Error("The output dimensions are invalid.");
        if (blob.size > MAX_BYTES) throw new Error("The image must be smaller than 50 MB.");
        const data = await blob.arrayBuffer();
        const frames = validatePng(data);
        if (resolution !== undefined && resolution * resolution * frames > 32 * 1024 * 1024) throw new Error("The output animation is too large.");
        signal?.throwIfAborted();
        ff = new FFmpeg();
        signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(abort, 45_000);
        await loadFFmpeg(ff);
        signal?.throwIfAborted();
        await ff.writeFile("input.png", new Uint8Array(data));
        const status = await ff.exec([
            "-max_alloc", "67108864", "-i", "input.png",
            "-filter_complex", (resolution === undefined ? "" : `format=rgba,scale=${resolution}:${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:${resolution}:0:0:color=black@0,`) + "split[s0][s1];[s0]palettegen=stats_mode=single:transparency_color=000000[p];[s1][p]paletteuse=new=1:alpha_threshold=10",
            "-vsync", "0", "-frames:v", String(frames), "-loop", "0", "output.gif"
        ], 30_000);
        if (status !== 0) throw new Error("The animation conversion failed.");
        const result = await ff.readFile("output.gif");
        signal?.throwIfAborted();
        if (typeof result === "string" || result.byteLength > MAX_BYTES) throw new Error("The converted animation is invalid or too large.");
        return new Blob([new Uint8Array(result)], { type: "image/gif" });
    } catch (error) {
        if (!signal?.aborted) logger.error("Could not convert the animation.", error);
        return null;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        ff?.terminate();
    }
}

export function convertApngToGif(blob: Blob, signal?: AbortSignal, resolution?: number): Promise<Blob | null> {
    if (signal?.aborted || blob.size > MAX_BYTES || pendingJobs >= 3 || pendingBytes + blob.size > 2 * MAX_BYTES) return Promise.resolve(null);
    pendingJobs++;
    pendingBytes += blob.size;
    return new Promise(resolve => {
        const abort = () => resolve(null);
        signal?.addEventListener("abort", abort, { once: true });
        queue.push(() => convert(blob, signal, resolution).then(resolve).finally(() => {
            pendingJobs--;
            pendingBytes -= blob.size;
            signal?.removeEventListener("abort", abort);
        }));
    });
}
