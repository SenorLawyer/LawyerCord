/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { decompressFrames, parseGIF } from "gifuct-js";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function compile(source: string) {
    return transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
}

test("FakeNitro stops download and conversion jobs without late upload or notifications", async () => {
    const source = readFileSync("src/plugins/fakeNitro/index.tsx", "utf8");
    const methods = source.slice(source.indexOf("    async sendAnimatedSticker("), source.indexOf("    canUseEmote("));
    const stop = source.slice(source.lastIndexOf("    stop() {"), source.lastIndexOf("});"));
    for (const phase of ["download", "conversion", "success", "failure"]) {
        let finish: (value: Blob | null) => void = () => {};
        let uploads = 0;
        let toasts = 0;
        let signal: AbortSignal | undefined;
        const timers = new Set<() => void>();
        const plugin = runInNewContext(compile(`const stickerJobs = new Set<AbortController>(); let stopped = false; ({${methods}${stop}});`), {
            AbortController, URL, File, settings: { store: { stickerSize: 160 } },
            UserStore: { getCurrentUser: () => ({ id: "owner" }) },
            ChannelStore: { getChannel: () => ({ id: "channel" }) }, DraftType: {},
            UploadHandler: { promptToUpload: () => uploads++ }, showToast: () => toasts++, Toasts: { Type: {} },
            removeMessagePreSendListener() {}, removeMessagePreEditListener() {},
            setTimeout: (fn: () => void) => { timers.add(fn); return fn; }, clearTimeout: (fn: () => void) => timers.delete(fn),
            fetch: async (_url: URL, options: { signal: AbortSignal; }) => { signal = options.signal; return { ok: true }; },
            readResponseBody: async () => phase === "download" ? new Promise(resolve => finish = resolve) : new Blob(),
            convertApngToGif: async (_blob: Blob, jobSignal: AbortSignal, resolution: number) => {
                assert.equal(resolution, 160);
                if (jobSignal.aborted) return null;
                return new Promise(resolve => finish = resolve);
            }
        });
        const pending = plugin.sendAnimatedSticker("https://media.discordapp.net/stickers/1.png", "1", "channel");
        await new Promise(resolve => setImmediate(resolve));
        if (phase === "download") plugin.stop();
        if (phase === "conversion") plugin.flux.LOGOUT();
        if (phase === "download" || phase === "conversion") assert.equal(signal?.aborted, true);
        finish(phase === "failure" ? null : new Blob(["gif"]));
        await pending;
        assert.equal(uploads, phase === "success" ? 1 : 0);
        assert.equal(toasts, phase === "failure" ? 1 : 0);
        assert.equal(timers.size, 0);
    }
});

function chunk(type: string, data: Buffer) {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
}

function animatedPng() {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    const actl = Buffer.alloc(8); actl.writeUInt32BE(3);
    const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("acTL", actl)];
    let sequence = 0;
    for (let index = 0; index < 3; index++) {
        const control = Buffer.alloc(26);
        control.writeUInt32BE(sequence++); control.writeUInt32BE(index ? 1 : 2, 4); control.writeUInt32BE(1, 8);
        control.writeUInt32BE(index === 2 ? 1 : 0, 12); control.writeUInt16BE(index + 1, 20); control.writeUInt16BE(10, 22);
        control[24] = index === 1 ? 2 : 0;
        parts.push(chunk("fcTL", control));
        const pixels = index === 0 ? [0, 255, 0, 0, 255, 255, 0, 0, 255] : index === 1 ? [0, 0, 0, 255, 255] : [0, 0, 255, 0, 255];
        const data = deflateSync(Buffer.from(pixels));
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(sequence++);
        parts.push(chunk(index === 0 ? "IDAT" : "fdAT", index === 0 ? data : Buffer.concat([prefix, data])));
        if (index === 0) sequence--;
    }
    parts.push(chunk("IEND", Buffer.alloc(0)));
    return new Blob([Buffer.concat(parts)]);
}

test("Real FFmpeg sticker conversion preserves square transparent padding, disposal and frame delays", { skip: !process.env.AUDIT_FFMPEG }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "lawyercord-apng-"));
    let terminated = false;
    class FFmpeg {
        async writeFile(name: string, bytes: Uint8Array) { writeFileSync(join(directory, name), bytes); }
        async exec(args: string[]) {
            const result = spawnSync(process.env.AUDIT_FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { cwd: directory, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            return result.status;
        }
        async readFile(name: string) { return readFileSync(join(directory, name)); }
        terminate() { terminated = true; }
    }
    const modules: Record<string, unknown> = {
        "@ffmpeg/ffmpeg": { FFmpeg }, "@utils/ffmpeg": { loadFFmpeg: async () => {} },
        "@utils/Logger": { Logger: class { error(_message: string, error: unknown) { throw error; } } },
        "@utils/Queue": { Queue: class { push(fn: () => Promise<void>) { void fn(); } } }
    };
    try {
        const { convertApngToGif } = runInNewContext(compile(readFileSync("src/equicordplugins/fileUpload/utils/apngToGif.ts", "utf8")) + ";exports", {
            exports: {}, Blob, Uint8Array, DataView, setTimeout, clearTimeout, require: (name: string) => modules[name]
        });
        const result = await convertApngToGif(animatedPng(), undefined, 16);
        const parsed = parseGIF(await result.arrayBuffer());
        assert.equal(parsed.lsd.width, 16); assert.equal(parsed.lsd.height, 16);
        const frames = decompressFrames(parsed, true);
        assert.equal(frames.length, 3);
        assert.deepEqual(frames.map(frame => frame.delay), [100, 200, 300]);
        const canvas = new Uint8Array(16 * 16 * 4);
        for (let index = 0; index < frames.length; index++) {
            const frame = frames[index];
            for (let y = 0; y < frame.dims.height; y++) for (let x = 0; x < frame.dims.width; x++) {
                const pixel = (y * frame.dims.width + x) * 4;
                if (frame.patch[pixel + 3]) canvas.set(frame.patch.subarray(pixel, pixel + 4), ((y + frame.dims.top) * 16 + x + frame.dims.left) * 4);
            }
            const left = Array.from(canvas.slice((2 * 16 + 1) * 4, (2 * 16 + 1) * 4 + 4));
            const right = Array.from(canvas.slice((2 * 16 + 14) * 4, (2 * 16 + 14) * 4 + 4));
            assert.deepEqual(left, index === 1 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
            assert.deepEqual(right, index === 2 ? [0, 255, 0, 255] : [255, 0, 0, 255]);
            assert.equal(canvas[(15 * 16) * 4 + 3], 0);
        }
        assert.equal(terminated, true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
