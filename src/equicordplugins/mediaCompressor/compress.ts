/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";

import { compressNative } from "./bridge";
import { encodeMedia } from "./encode";
import { CompressionMode } from "./policy";

export { CompressionMode, compressionModes, targetSize, videoBudget } from "./policy";

export function isMedia(file: File) {
    return /^(image|video)\//.test(file.type) || /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name);
}

export async function compress(file: File, limit: number, signal: AbortSignal, progress: (status: string) => void, mode: CompressionMode = "normal"): Promise<File> {
    signal.throwIfAborted();
    if (!IS_WEB) {
        const result = await compressNative(file, limit, signal, progress, mode);
        if (result) return result;
    }
    const ff = new FFmpeg();
    const abort = () => ff.terminate();
    signal.addEventListener("abort", abort, { once: true });
    try {
        progress(IS_WEB ? "Loading the browser encoder" : "Native encoding is unavailable. Loading the slower browser encoder");
        await loadFFmpeg(ff);
        signal.throwIfAborted();
        await ff.createDir("/input");
        const name = `media${file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".bin"}`;
        if (!await ff.mount("WORKERFS" as Parameters<FFmpeg["mount"]>[0], { files: [new File([file], name, { type: file.type })] }, "/input"))
            throw new Error("The encoder could not open this file.");
        const result = await encodeMedia(ff, `/input/${name}`, file.name, file.type, limit, signal, progress, mode);
        return new File([new Uint8Array(result.data)], file.name.replace(/\.[^.]+$/, "") + result.extension, { type: result.type });
    } finally {
        signal.removeEventListener("abort", abort);
        ff.terminate();
    }
}
