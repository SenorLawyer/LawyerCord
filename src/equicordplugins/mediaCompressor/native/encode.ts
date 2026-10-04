/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readdir, readFile, rm, stat } from "fs/promises";
import { availableParallelism } from "os";
import { join } from "path";

import { encodeMedia, Encoder, HardwareEncoder, videoCodec } from "../encode";
import { CompressionMode } from "../policy";
import { run } from "./process";

export async function hardwareCandidates(platform: string): Promise<HardwareEncoder[]> {
    if (platform === "darwin") return [{ codec: "h264_videotoolbox", label: "Apple VideoToolbox", input: [] }];
    const candidates: HardwareEncoder[] = [
        { codec: "h264_nvenc", label: "NVIDIA NVENC", input: [] },
        { codec: "h264_amf", label: "AMD AMF", input: [] },
        { codec: "h264_qsv", label: "Intel Quick Sync", input: [] }
    ];
    if (platform === "linux") {
        const devices = await readdir("/dev/dri").catch(() => [] as string[]);
        for (const device of devices.filter(name => /^renderD\d+$/.test(name)).sort())
            candidates.push({ codec: "h264_vaapi", label: "VAAPI", input: ["-vaapi_device", `/dev/dri/${device}`] });
    }
    return candidates;
}

export async function compressFile(binary: string, directory: string, input: string, name: string, type: string, limit: number, mode: CompressionMode, signal: AbortSignal, status: (text: string) => void, candidates?: HardwareEncoder[]) {
    const threads = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
    let log = (_event: { message: string; }) => {};
    let progress = (_event: { progress: number; }) => {};
    let duration = 0;
    let pending = "";
    const encoder: Encoder = {
        on(event, callback) { if (event === "log") log = callback; else progress = callback; },
        async exec(args, timeout) {
            pending = "";
            const result = await run(binary, ["-hide_banner", "-nostdin", "-max_alloc", "268435456", ...args[0] === "-y" ? [...args.slice(0, -1), "-fs", "1073741825", ...args.slice(-1)] : args], directory, signal, timeout, text => {
                pending = (pending + text).slice(-65_536);
                const lines = pending.split(/[\r\n]/);
                pending = lines.pop() ?? "";
                for (const message of lines) {
                    log({ message });
                    const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
                    if (time) duration = +time[1] * 3600 + +time[2] * 60 + +time[3];
                    const elapsed = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
                    if (elapsed && duration) progress({ progress: (+elapsed[1] * 3600 + +elapsed[2] * 60 + +elapsed[3]) / duration });
                }
            });
            if (pending) log({ message: pending });
            signal.throwIfAborted();
            return result.code;
        },
        async readFile(path) {
            const file = join(directory, path);
            if ((await stat(file)).size > 1024 * 1024 * 1024) throw new Error("The encoder output is too large.");
            return readFile(file);
        },
        deleteFile: path => rm(join(directory, path), { force: true })
    };
    const listed = await run(binary, ["-hide_banner", "-encoders"], directory, signal);
    const still = /^image\/(jpeg|png|webp|avif|bmp|tiff)$/.test(type) || /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i.test(name);
    const hardware = still ? [] : candidates ?? await hardwareCandidates(process.platform);
    for (const candidate of hardware) {
        if (!listed.output.includes(candidate.codec)) continue;
        status(`Checking ${candidate.label}`);
        const probe = await run(binary, ["-hide_banner", "-nostdin", ...candidate.input, "-f", "lavfi", "-i", "color=size=128x128:rate=30", "-frames:v", "3", ...candidate.codec === "h264_vaapi" ? ["-vf", "format=nv12,hwupload"] : [], ...videoCodec(mode, candidate), "-b:v", "500000", "-f", "null", "-"], directory, signal, 8000);
        signal.throwIfAborted();
        if (probe.code !== 0) continue;
        try {
            return await encodeMedia(encoder, input, name, type, limit, signal, text => status(`${candidate.label}: ${text}`), mode, threads, candidate);
        } catch {
            signal.throwIfAborted();
            status(`${candidate.label} could not encode this file. Trying another encoder`);
        }
    }
    return encodeMedia(encoder, input, name, type, limit, signal, text => status(`Native CPU: ${text}`), mode, threads);
}
