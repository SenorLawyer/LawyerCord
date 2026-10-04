/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";

export const compressionModes = {
    fast: { label: "Fast", description: "Finish sooner, with less detail. Large videos are resized.", preset: "ultrafast", edge: 1280, quality: 75, effort: 1, ratio: 1 },
    normal: { label: "Normal", description: "Balance speed and quality. Use the available upload size.", preset: "veryfast", edge: Infinity, quality: 90, effort: 4, ratio: 1 },
    extreme: { label: "Extreme", description: "Aim for half the available size. Expect less detail and a longer wait.", preset: "fast", edge: 854, quality: 60, effort: 5, ratio: 0.5 }
} as const;
export type CompressionMode = keyof typeof compressionModes;

export function targetSize(limit: number, mode: CompressionMode) {
    return Math.floor(limit * compressionModes[mode].ratio);
}

export function isMedia(file: File) {
    return /^(image|video)\//.test(file.type) || /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name);
}

export function videoBudget(bytes: number, duration: number) {
    const total = Math.floor(bytes * 0.97 * 8 / duration);
    const audio = Math.min(128_000, Math.floor(total * 0.15));
    if (!Number.isFinite(total) || duration <= 0 || total - audio < 32_000)
        throw new Error("This video is too long to fit at a usable quality. Trim it and try again.");
    return { video: total - audio, audio: Math.max(8_000, audio) };
}

export async function compress(file: File, limit: number, signal: AbortSignal, progress: (status: string) => void, mode: CompressionMode = "normal"): Promise<File> {
    signal.throwIfAborted();
    const options = compressionModes[mode];
    limit = targetSize(limit, mode);
    const ff = new FFmpeg();
    const abort = () => ff.terminate();
    signal.addEventListener("abort", abort, { once: true });
    let duration = 0;
    let width = 0;
    let height = 0;
    let animated = false;
    let phase = "Reading media";
    let lastPercent = -1;
    const logs = ({ message }: { message: string; }) => {
        const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
        if (time) duration = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
        const dimensions = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(message);
        if (dimensions && !width) { width = Number(dimensions[1]); height = Number(dimensions[2]); }
        if (/Input #0, apng|unsupported chunk: ANIM/.test(message)) animated = true;
    };
    ff.on("log", logs);
    ff.on("progress", ({ progress: fraction }: { progress: number; }) => {
        const percent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
        if (percent !== lastPercent) { lastPercent = percent; progress(`${phase}, ${percent}%`); }
    });
    try {
        progress("Loading the local encoder");
        await loadFFmpeg(ff);
        signal.throwIfAborted();
        await ff.createDir("/input");
        const name = `media${file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".bin"}`;
        if (!await ff.mount("WORKERFS" as Parameters<FFmpeg["mount"]>[0], { files: [new File([file], name, { type: file.type })] }, "/input"))
            throw new Error("The encoder could not open this file.");
        const input = ["-protocol_whitelist", "file,pipe", "-threads", "1", "-i", `/input/${name}`, "-filter_threads", "1"];
        await ff.exec(input, 30_000);
        signal.throwIfAborted();
        if (!width || !height) throw new Error("This media format could not be read. Your original file is still attached.");
        if (width * height > 100_000_000) throw new Error("This image is too large to process safely. Resize it first.");
        if (animated) throw new Error("This animated image cannot be preserved by the encoder. Your original file is still attached.");
        const still = (/^image\/(jpeg|png|webp|avif|bmp|tiff)$/.test(file.type) || /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i.test(file.name)) && duration === 0;
        const output = still ? "output.webp" : "output.mp4";
        async function encode(args: string[]) {
            signal.throwIfAborted();
            lastPercent = -1;
            if (await ff.exec(["-y", ...input, ...args, output], 30 * 60_000) !== 0)
                throw new Error("This file could not be compressed. Your original file is still attached.");
            signal.throwIfAborted();
            const data = await ff.readFile(output);
            await ff.deleteFile(output);
            if (typeof data === "string" || !data.length) throw new Error("The encoder returned an empty file.");
            return new File([new Uint8Array(data)], file.name.replace(/\.[^.]+$/, "") + (still ? ".webp" : ".mp4"), { type: still ? "image/webp" : "video/mp4" });
        }
        if (still) {
            phase = "Compressing image";
            if (mode === "normal") {
                progress("Trying lossless compression");
                const lossless = await encode(["-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", "-compression_level", "4", "-threads", "1"]);
                if (lossless.size <= limit) return lossless;
            }
            let scale = 1;
            let { quality } = options;
            for (let attempt = 0; attempt < 6; attempt++) {
                progress(`Compressing image, ${Math.round(scale * 100)}% resolution`);
                const result = await encode(["-vf", `scale='max(1,trunc(iw*${scale}))':'max(1,trunc(ih*${scale}))'`, "-frames:v", "1", "-c:v", "libwebp", "-q:v", String(quality), "-compression_level", String(options.effort), "-threads", "1"]);
                if (result.size <= limit) return result;
                if (mode === "normal" && quality > 60) quality -= 15;
                else scale *= Math.min(0.9, Math.sqrt(limit / result.size) * 0.95);
            }
        } else {
            if (!duration) throw new Error("The video duration could not be read. Your original file is still attached.");
            const budget = videoBudget(limit * (mode === "fast" ? 0.85 : mode === "extreme" ? 0.9 : 1), duration);
            let { video } = budget;
            for (let attempt = 0; attempt < 3; attempt++) {
                const edge = video < 300_000 ? 480 : video < 800_000 ? 854 : video < 2_000_000 ? 1280 : Math.max(width, height);
                const bound = Math.min(edge, options.edge, Math.max(width, height));
                const codec = ["-map", "0:v:0", "-vf", `scale=${bound}:${bound}:force_original_aspect_ratio=decrease:force_divisible_by=2`, "-c:v", "libx264", "-preset", options.preset, "-b:v", String(video), "-pix_fmt", "yuv420p", "-threads", "1", "-passlogfile", "encode"];
                if (mode === "extreme") {
                    phase = "Analyzing video";
                    progress(phase);
                    if (await ff.exec(["-y", ...input, ...codec, "-pass", "1", "-an", "-f", "null", "/dev/null"], 30 * 60_000) !== 0)
                        throw new Error("This video could not be analyzed. Your original file is still attached.");
                }
                signal.throwIfAborted();
                phase = "Compressing video";
                progress(phase);
                const result = await encode([...codec, ...mode === "extreme" ? ["-pass", "2"] : [], "-map", "0:a:0?", "-c:a", "aac", "-b:a", String(budget.audio), "-ac", "2", "-movflags", "+faststart"]);
                if (result.size <= limit) return result;
                video = Math.floor(video * Math.min(0.85, limit / result.size * 0.9));
            }
        }
        throw new Error("This file could not fit within the limit. Your original file is still attached.");
    } finally {
        signal.removeEventListener("abort", abort);
        ff.terminate();
    }
}
