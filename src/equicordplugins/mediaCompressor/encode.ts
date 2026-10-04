/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CompressionMode, compressionModes, targetSize, videoBudget } from "./policy";

export interface HardwareEncoder {
    codec: "h264_nvenc" | "h264_amf" | "h264_qsv" | "h264_videotoolbox" | "h264_vaapi";
    label: string;
    input: string[];
}

export function videoCodec(mode: CompressionMode, hardware?: HardwareEncoder): string[] {
    if (!hardware) return ["-c:v", "libx264", "-preset", compressionModes[mode].preset];
    const fast = mode === "fast";
    const quality = mode === "extreme";
    const args = {
        h264_nvenc: ["-preset", fast ? "p1" : quality ? "p5" : "p4", "-rc", "vbr"],
        h264_amf: ["-quality", fast ? "speed" : quality ? "quality" : "balanced", "-rc", "vbr_peak"],
        h264_qsv: ["-preset", fast ? "veryfast" : quality ? "slow" : "medium"],
        h264_videotoolbox: ["-allow_sw", "0", "-realtime", fast ? "1" : "0"],
        h264_vaapi: []
    }[hardware.codec];
    return ["-c:v", hardware.codec, ...args];
}

export interface Encoder {
    on(event: "log", callback: (event: { message: string; }) => void): void;
    on(event: "progress", callback: (event: { progress: number; }) => void): void;
    exec(args: string[], timeout: number): Promise<number>;
    readFile(path: string): Promise<Uint8Array | string>;
    deleteFile(path: string): Promise<unknown>;
}

export async function encodeMedia(ff: Encoder, inputPath: string, name: string, type: string, limit: number, signal: AbortSignal, progress: (status: string) => void, mode: CompressionMode, threads = 1, hardware?: HardwareEncoder) {
    const options = compressionModes[mode];
    limit = targetSize(limit, mode);
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
    const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpeg,mpegts,gif,apng,png_pipe,jpeg_pipe,webp_pipe,avif,bmp_pipe,tiff_pipe", "-threads", String(threads), "-i", inputPath, "-filter_threads", String(Math.min(threads, 2))];
    await ff.exec(input, 30_000);
    signal.throwIfAborted();
    if (!width || !height) throw new Error("This media format could not be read. Your original file is still attached.");
    if (width * height > 100_000_000) throw new Error("This image is too large to process safely. Resize it first.");
    if (animated) throw new Error("This animated image cannot be preserved by the encoder. Your original file is still attached.");
    const still = (/^image\/(jpeg|png|webp|avif|bmp|tiff)$/.test(type) || /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i.test(name)) && duration === 0;
    const output = still ? "output.webp" : "output.mp4";
    async function encode(args: string[]) {
        signal.throwIfAborted();
        lastPercent = -1;
        if (await ff.exec(["-y", ...hardware?.input ?? [], ...input, ...args, output], 30 * 60_000) !== 0)
            throw new Error("This file could not be compressed. Your original file is still attached.");
        signal.throwIfAborted();
        const data = await ff.readFile(output);
        await ff.deleteFile(output);
        if (typeof data === "string" || !data.length) throw new Error("The encoder returned an empty file.");
        return { data, extension: still ? ".webp" : ".mp4", type: still ? "image/webp" : "video/mp4", size: data.length };
    }
    if (still) {
        phase = "Compressing image";
        if (mode === "normal") {
            progress("Trying lossless compression");
            const lossless = await encode(["-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", "-compression_level", "4", "-threads", String(threads)]);
            if (lossless.size <= limit) return lossless;
        }
        let scale = 1;
        let { quality } = options;
        for (let attempt = 0; attempt < 6; attempt++) {
            progress(`Compressing image, ${Math.round(scale * 100)}% resolution`);
            const result = await encode(["-vf", `scale='max(1,trunc(iw*${scale}))':'max(1,trunc(ih*${scale}))'`, "-frames:v", "1", "-c:v", "libwebp", "-q:v", String(quality), "-compression_level", String(options.effort), "-threads", String(threads)]);
            if (result.size <= limit) return result;
            if (mode === "normal" && quality > 60) quality -= 15;
            else scale *= Math.min(0.9, Math.sqrt(limit / result.size) * 0.95);
        }
    } else {
        if (!duration) throw new Error("The video duration could not be read. Your original file is still attached.");
        const budget = videoBudget(limit * (mode === "fast" ? 0.85 : mode === "extreme" || hardware ? 0.9 : 1), duration);
        let { video } = budget;
        for (let attempt = 0; attempt < 3; attempt++) {
            const edge = video < 300_000 ? 480 : video < 800_000 ? 854 : video < 2_000_000 ? 1280 : Math.max(width, height);
            const bound = Math.min(edge, options.edge, Math.max(width, height));
            const codec = ["-map", "0:v:0", "-vf", `scale=${bound}:${bound}:force_original_aspect_ratio=decrease:force_divisible_by=2${hardware?.codec === "h264_vaapi" ? ",format=nv12,hwupload" : ""}`, "-fps_mode", "passthrough", ...videoCodec(mode, hardware), "-b:v", String(video), ...hardware ? ["-maxrate", String(video), "-bufsize", String(video * 2)] : [], "-pix_fmt", hardware?.codec === "h264_vaapi" ? "vaapi" : "yuv420p", "-threads", String(threads), "-passlogfile", "encode"];
            if (mode === "extreme" && !hardware) {
                phase = "Analyzing video";
                progress(phase);
                if (await ff.exec(["-y", ...input, ...codec, "-pass", "1", "-an", "-f", "null", "-"], 30 * 60_000) !== 0)
                    throw new Error("This video could not be analyzed. Your original file is still attached.");
            }
            signal.throwIfAborted();
            phase = "Compressing video";
            progress(phase);
            const result = await encode([...codec, ...mode === "extreme" && !hardware ? ["-pass", "2"] : [], "-map", "0:a:0?", "-c:a", "aac", "-b:a", String(budget.audio), "-ac", "2", "-movflags", "+faststart"]);
            if (result.size <= limit) return result;
            video = Math.floor(video * Math.min(0.85, limit / result.size * 0.9));
        }
    }
    throw new Error("This file could not fit within the limit. Your original file is still attached.");
}
