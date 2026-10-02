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

function png(width = 2, height = 2, frames = 2) {
    const data = new Uint8Array(66);
    const view = new DataView(data.buffer);
    data.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, 13); view.setUint32(12, 0x49484452);
    view.setUint32(16, width); view.setUint32(20, height);
    view.setUint32(33, 8); view.setUint32(37, 0x6163544c); view.setUint32(41, frames);
    view.setUint32(53, 1); view.setUint32(57, 0x49444154);
    return new Blob([data]);
}

function fixture() {
    const workers: { terminated: boolean; }[] = [];
    let status = 0;
    let hold = false;
    const releases: (() => void)[] = [];
    class FFmpeg {
        loaded = false;
        terminated = false;
        constructor() { workers.push(this); }
        async writeFile() {}
        async exec() { if (hold) await new Promise<void>(resolve => releases.push(resolve)); return status; }
        async readFile() { return new Uint8Array([71, 73, 70]); }
        async deleteFile() {}
        terminate() { this.terminated = true; }
    }
    const modules: Record<string, unknown> = {
        "@ffmpeg/ffmpeg": { FFmpeg }, "@utils/ffmpeg": { loadFFmpeg: async (ff: FFmpeg) => { ff.loaded = true; } },
        "@utils/Logger": { Logger: class { error() {} } }, "./Logger": { Logger: class { error() {} } }
    };
    const load = (path: string) => {
        const { outputText } = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, console, Blob, Uint8Array, DataView, setTimeout, clearTimeout, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    };
    modules["@utils/Queue"] = load("src/utils/Queue.ts");
    const { convertApngToGif } = load(process.env.AUDIT_APNG_SOURCE ?? "src/equicordplugins/fileUpload/utils/apngToGif.ts") as { convertApngToGif(blob: Blob, signal?: AbortSignal, resolution?: number): Promise<Blob | null>; };
    return { convertApngToGif, workers, releases, hold: () => hold = true, fail: () => status = 1 };
}

test("APNG conversion releases its FFmpeg worker after success", async () => {
    const f = fixture();
    assert.ok(await f.convertApngToGif(png()));
    assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0].terminated, true);
});

test("Failed FFmpeg status is not read as a successful conversion", async () => {
    const f = fixture();
    f.fail();
    assert.equal(await f.convertApngToGif(png()), null);
    assert.equal(f.workers[0].terminated, true);
});

test("Excessive APNG frame dimensions are rejected before starting FFmpeg", async () => {
    const f = fixture();
    assert.equal(await f.convertApngToGif(png(65535, 65535)), null);
    assert.equal(f.workers.length, 0);
});

test("Cancelled APNG conversion never starts FFmpeg", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    assert.equal(await f.convertApngToGif(png(), controller.signal), null);
    assert.equal(f.workers.length, 0);
});


test("APNG output work is bounded before starting a worker", async () => {
    const f = fixture();
    assert.equal(await f.convertApngToGif(png(2, 2, 200), undefined, 512), null);
    assert.equal(await f.convertApngToGif(png(), undefined, 100000), null);
    assert.equal(f.workers.length, 0);
});

test("APNG queue rejects excess jobs and cancelled queued calls settle before the active conversion", async () => {
    const f = fixture();
    f.hold();
    const first = f.convertApngToGif(png());
    await new Promise(resolve => setImmediate(resolve));
    const cancelled = new AbortController();
    const second = f.convertApngToGif(png(), cancelled.signal);
    const third = f.convertApngToGif(png());
    assert.equal(await f.convertApngToGif(png()), null);
    cancelled.abort();
    assert.equal(await second, null);
    assert.equal(f.workers.length, 1);
    f.releases[0]();
    assert.ok(await first);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.workers.length, 2);
    f.releases[1]();
    assert.ok(await third);
    assert.ok(f.workers.every(worker => worker.terminated));
});
