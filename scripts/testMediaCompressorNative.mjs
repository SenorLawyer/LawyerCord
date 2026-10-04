/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "lawyercord-media-test-"));
const real = process.argv.includes("--real");
try {
    const output = join(root, "test.cjs");
    await build({
        stdin: {
            contents: 'export * as native from "./src/equicordplugins/mediaCompressor/native"; export {getBinary} from "./src/equicordplugins/mediaCompressor/native/binary"; export {compressFile,hardwareCandidates} from "./src/equicordplugins/mediaCompressor/native/encode"; export {run} from "./src/equicordplugins/mediaCompressor/native/process";',
            resolveDir: process.cwd(), loader: "ts"
        },
        bundle: true, platform: "node", format: "cjs", outfile: output,
        plugins: [{ name: "isolated-native-data", setup(build) {
            build.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "test" }));
            build.onResolve({ filter: /^\.\/binary$/ }, args => args.importer.endsWith("native/index.ts") ? { path: "binary", namespace: "test" } : undefined);
            build.onLoad({ filter: /.*/, namespace: "test" }, args => ({ contents: args.path === "constants" ? `export const DATA_DIR = ${JSON.stringify(root)};` : 'export async function getBinary() { return process.env.MEDIA_TEST_FFMPEG || process.execPath; }' }));
        } }]
    });
    const { native, getBinary, compressFile, hardwareCandidates, run } = createRequire(import.meta.url)(output);
    const event = { senderFrame: {}, sender: new EventEmitter() };
    const other = { senderFrame: {}, sender: new EventEmitter() };
    const id = randomUUID();
    const begin = (key = id, overrides = {}) => native.begin(event, key, overrides.name ?? "recording.mp4", "video/mp4", overrides.size ?? 10, overrides.limit ?? 4096, overrides.mode ?? "fast");
    for (const bad of [{ size: -1 }, { size: Infinity }, { size: 2 ** 32 }, { limit: NaN }, { limit: 10 }, { mode: "__proto__" }, { name: "" }])
        assert.ok((await begin(randomUUID(), bad)).error);
    assert.ok((await begin("../escape")).error);
    assert.equal((await begin()).available, true);
    assert.ok((await begin(randomUUID())).error);
    assert.equal(await native.status(other, id), null);
    assert.equal(await native.append(other, id, new Uint8Array(10)), false);
    await native.release(other, id);
    assert.equal(await native.append(event, id, new Uint8Array(11)), false);
    assert.equal(await native.append(event, id, new Uint8Array(5)), true);
    assert.ok((await native.finish(event, id)).error);
    assert.equal(await native.read(other, id, 0), null);
    await native.release(event, id);
    assert.equal(await native.status(event, id), null);
    assert.equal((await readdir(join(root, "mediaCompressor", "jobs"))).length, 0);
    const racing = randomUUID();
    const starting = begin(racing);
    const stopping = native.release(event, racing);
    await Promise.all([starting, stopping]);
    assert.equal(await native.status(event, racing), null);
    assert.equal((await readdir(join(root, "mediaCompressor", "jobs"))).length, 0);
    assert.equal(event.sender.listenerCount("destroyed"), 0);
    assert.equal(event.sender.listenerCount("render-process-gone"), 0);
    const navigationId = randomUUID();
    assert.equal((await begin(navigationId, { name: "clipboard" })).available, true);
    const navigate = event.sender.listeners("did-start-navigation")[0];
    await navigate({}, "https://discord.com/channels/@me", true, true);
    assert.ok(await native.status(event, navigationId));
    await navigate({}, "https://discord.com/channels/@me", false, true);
    assert.equal(await native.status(event, navigationId), null);
    assert.equal(event.sender.listenerCount("did-start-navigation"), 0);
    assert.equal((await readdir(join(root, "mediaCompressor", "jobs"))).length, 0);
    assert.deepEqual((await hardwareCandidates("darwin")).map(c => c.codec), ["h264_videotoolbox"]);
    assert.deepEqual((await hardwareCandidates("win32")).map(c => c.codec), ["h264_nvenc", "h264_amf", "h264_qsv"]);
    const controller = new AbortController();
    const started = performance.now();
    const processResult = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, controller.signal);
    controller.abort();
    await processResult;
    assert.ok(performance.now() - started < 3000);
    console.log("Native ownership, input limits, setup cancellation, cleanup, platform selection and subprocess cancellation passed.");
    if (real) {
        const signal = new AbortController().signal;
        let last = "";
        const binary = await getBinary(signal, text => { if (!text.startsWith("Downloading") && text !== last) console.log(last = text); }, false);
        assert.ok(binary);
        process.env.MEDIA_TEST_FFMPEG = binary;
        assert.equal(await getBinary(signal, () => {}, false), binary);
        const input = join(root, "source.mp4");
        const generate = await run(binary, ["-hide_banner", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", input], root, signal);
        assert.equal(generate.code, 0, generate.output);
        for (const mode of ["fast", "normal", "extreme"]) {
            const start = performance.now();
            const result = await compressFile(binary, root, input, "source.mp4", "video/mp4", 150000, mode, signal, () => {}, []);
            assert.ok(result.size > 0 && result.size <= (mode === "extreme" ? 75000 : 150000));
            const target = join(root, `${mode}.mp4`);
            await writeFile(target, result.data);
            const decoded = await run(binary, ["-i", target, "-f", "null", "-"], root, signal);
            assert.equal(decoded.code, 0, decoded.output);
            assert.match(decoded.output, /Audio: aac/);
            assert.match(decoded.output, /Duration: 00:00:03/);
            console.log(`${mode}: ${result.size} bytes, ${Math.round(performance.now() - start)} ms, audio and full duration preserved.`);
        }
        const data = await readFile(input);
        const jobId = randomUUID();
        assert.equal((await begin(jobId, { size: data.length, limit: 150000 })).available, true);
        for (let offset = 0; offset < data.length; offset += 32768) assert.equal(await native.append(event, jobId, data.subarray(offset, offset + 32768)), true);
        const result = await native.finish(event, jobId);
        assert.ok(!result.error && result.size > 0 && result.size <= 150000, JSON.stringify(result));
        assert.equal(await native.read(other, jobId, 0), null);
        assert.equal(await native.read(event, jobId, -1), null);
        const bytes = await native.read(event, jobId, 0);
        assert.equal(bytes.length, result.size);
        await native.release(event, jobId);
        assert.equal((await readdir(join(root, "mediaCompressor", "jobs"))).length, 0);
        const cancelId = randomUUID();
        await begin(cancelId, { size: data.length, limit: 150000 });
        await native.append(event, cancelId, data);
        const active = native.finish(event, cancelId);
        await native.release(event, cancelId);
        assert.ok((await active).error);
        assert.equal((await readdir(join(root, "mediaCompressor", "jobs"))).length, 0);
        const image = join(root, "image.png");
        assert.equal((await run(binary, ["-f", "lavfi", "-i", "testsrc2=size=512x512", "-frames:v", "1", image], root, signal)).code, 0);
        const compressedImage = await compressFile(binary, root, image, "image.png", "image/png", 12000, "normal", signal, () => {}, []);
        assert.ok(compressedImage.size > 0 && compressedImage.size <= 12000);
        await writeFile(join(root, "image.webp"), compressedImage.data);
        assert.equal((await run(binary, ["-i", join(root, "image.webp"), "-f", "null", "-"], root, signal)).code, 0);
        console.log("Pinned encoder download, extraction, cache reuse, all modes, decode and full native IPC round trip passed.");
    }
} finally {
    delete process.env.MEDIA_TEST_FFMPEG;
    await rm(root, { force: true, recursive: true });
}
