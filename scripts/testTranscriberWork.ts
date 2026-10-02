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

function fixture() {
    let active = 0;
    let maxActive = 0;
    let decodedDuration = 1;
    let closes = 0;
    let reads = 0;
    const workers: Worker[] = [];
    const timers = new Set<() => void>();
    class Worker {
        onmessage = (_event: object) => {};
        onerror = () => {};
        messages: { audio: Float32Array; }[] = [];
        constructor() { workers.push(this); active++; maxActive = Math.max(active, maxActive); }
        postMessage(data: { audio: Float32Array; }, transfer: ArrayBuffer[]) { this.messages.push(structuredClone(data, { transfer })); }
        terminate() { active--; }
    }
    const modules: Record<string, unknown> = {
        "@equicordplugins/fileUpload/request": {},
        "@api/index": {}, "@utils/css": { classNameFactory: () => () => "" }, "@webpack/common": {}, "./Logger": { Logger: class { error() {} } }
    };
    const load = (path: string) => {
        const code = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        return runInNewContext(`${code}\nexports;`, {
            exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
            Blob, AbortController, Float32Array, Worker,
            URL: { createObjectURL: () => "blob:worker", revokeObjectURL() {} },
            setTimeout: (callback: () => void) => { timers.add(callback); return callback; }, clearTimeout: (callback: () => void) => timers.delete(callback),
            AudioContext: class {
                async decodeAudioData() { reads++; return { duration: decodedDuration, numberOfChannels: 1, getChannelData: () => new Float32Array([1, 2]) }; }
                async close() { closes++; }
            }
        });
    };
    modules["@utils/Queue"] = load("src/utils/Queue.ts");
    return { ...load("src/equicordplugins/voiceMessageTranscriber.desktop/utils.ts"), workers, timers, active: () => active, maxActive: () => maxActive,
        duration: (value: number) => decodedDuration = value, closes: () => closes, reads: () => reads };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("Transcription creates one heavyweight worker and skips cancelled queued jobs without copying cached samples", async () => {
    const f = fixture();
    const samples = new Float32Array([1, 2, 3]);
    const jobs = Array.from({ length: 3 }, () => new f.TranscriptionWorker(() => {}, () => {}, () => {}, () => {}));
    assert.equal(f.workers.length, 0);
    for (const job of jobs) job.run(samples, "model");
    await flush();
    assert.equal(f.workers.length, 1);
    assert.deepEqual(Array.from(samples), [1, 2, 3]);
    jobs[1].terminate();
    f.workers[0].onmessage({ data: { type: "complete", output: {} } });
    await flush();
    assert.equal(f.workers.length, 2);
    assert.equal(f.maxActive(), 1);
    assert.deepEqual(Array.from(f.workers[1].messages[0].audio), [1, 2, 3]);
    jobs[2].terminate();
    await flush();
    assert.equal(f.active(), 0);
    assert.equal(f.timers.size, 0);
});

test("Transcription deadlines release the queue and completed jobs ignore late worker messages", async () => {
    const f = fixture();
    let errors = 0;
    let statuses = 0;
    const job = new f.TranscriptionWorker(() => statuses++, () => {}, () => errors++, () => {});
    job.run(new Float32Array([1]), "model");
    await flush();
    for (const timeout of f.timers) timeout();
    await flush();
    f.workers[0].onmessage({ data: { type: "status", status: "loading" } });
    assert.equal(errors, 1);
    assert.equal(statuses, 0);
    assert.equal(f.active(), 0);
});

test("Queued transcription defers audio downloading and decoding until its worker slot is available", async () => {
    const f = fixture();
    let preparations = 0;
    const jobs = Array.from({ length: 3 }, () => new f.TranscriptionWorker(() => {}, () => {}, () => {}, () => {}));
    for (const job of jobs) job.run(async () => { preparations++; return new Float32Array([1]); }, "model");
    await flush();
    assert.equal(preparations, 1);
    jobs[1].terminate();
    jobs[0].terminate();
    await flush();
    assert.equal(preparations, 2);
    assert.equal(f.maxActive(), 1);
    jobs[2].terminate();
});

test("Transcription rejects large compressed inputs before reading and excessive decoded duration before mixing", async () => {
    const f = fixture();
    let byteReads = 0;
    await assert.rejects(f.decodeAudio({ size: 26 * 1024 * 1024, arrayBuffer: () => { byteReads++; return new ArrayBuffer(0); } }));
    assert.equal(byteReads, 0);
    f.duration(601);
    await assert.rejects(f.decodeAudio(new Blob(["audio"])), /10 minutes/);
    assert.equal(f.closes(), 1);
    f.duration(1);
    assert.deepEqual(Array.from(await f.decodeAudio(new Blob(["audio"]))), [1, 2]);
    assert.equal(f.closes(), 2);
});

test("Cancelled audio preparation releases the queue and its late completion cannot launch a worker", async () => {
    const f = fixture();
    let finish: (samples: Float32Array) => void = () => {};
    const first = new f.TranscriptionWorker(() => {}, () => {}, () => {}, () => {});
    const second = new f.TranscriptionWorker(() => {}, () => {}, () => {}, () => {});
    first.run(() => new Promise(resolve => finish = resolve), "model");
    second.run(new Float32Array([2]), "model");
    await flush();
    assert.equal(f.workers.length, 0);
    first.terminate();
    await flush();
    assert.equal(f.workers.length, 1);
    finish(new Float32Array([1]));
    await flush();
    assert.equal(f.workers.length, 1);
    second.terminate();
});

function preparationFixture() {
    let active = 0;
    let maximum = 0;
    let decodes = 0;
    const responses: Array<() => void> = [];
    const source = readFileSync("src/equicordplugins/voiceMessageTranscriber.desktop/index.tsx", "utf8");
    const queue = transpileModule(readFileSync("src/utils/Queue.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const queueExports = runInNewContext(queue + "\nexports;", { exports: {}, require: () => ({ Logger: class { error() {} } }) });
    const start = source.indexOf("const MAX_RESULT_CACHE_ENTRIES");
    const end = source.indexOf("function cacheResult");
    const code = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    return runInNewContext(code + "\n({ prepareAudio, stop: () => { cacheGeneration++; cancelQueuedPreparations(); preparedAudioCache.clear(); }, maximum: () => maximum(), decodes: () => decodes(), pendingSize: () => pendingPreparations.size, responses });", {
        Queue: queueExports.Queue, Blob,
        maximum: () => maximum, decodes: () => decodes, responses,
        Native: { fetchAudio: () => { active++; maximum = Math.max(maximum, active); return new Promise<Uint8Array>(resolve => responses.push(() => { active--; resolve(new Uint8Array([1])); })); } },
        detectAudioMimeType: () => "audio/ogg", decodeAudio: async () => { decodes++; return new Float32Array([1]); }, generateWaveform: () => "AQ=="
    });
}

test("Playback fallback preparation serializes native downloads and skips stale queued work after stop", async () => {
    const f = preparationFixture();
    const pending = Array.from({ length: 20 }, (_, i) => f.prepareAudio(String(i)));
    const settled = Promise.allSettled(pending);
    assert.equal(f.prepareAudio("0"), pending[0]);
    assert.equal(f.pendingSize(), 3);
    const rejected = await Promise.allSettled(pending.slice(3));
    assert.ok(rejected.every(result => result.status === "rejected"));
    await flush();
    assert.equal(f.maximum(), 1);
    assert.equal(f.responses.length, 1);
    f.stop();
    const cancelled = await Promise.allSettled(pending.slice(1, 3));
    assert.ok(cancelled.every(result => result.status === "rejected"));
    assert.equal(f.responses.length, 1);
    f.responses[0]();
    await settled;
    assert.equal(f.decodes(), 0);
    assert.equal(f.responses.length, 1);
    const next = f.prepareAudio("new");
    await flush();
    f.responses[1]();
    await next;
    assert.equal(f.decodes(), 1);
    assert.equal(f.maximum(), 1);
});
test("Same-tick playback stop cannot delete replacement preparation ownership", async () => {
    const f = preparationFixture();
    const stale = f.prepareAudio("same");
    const oldResult = Promise.allSettled([stale]);
    f.stop();
    const replacement = f.prepareAudio("same");
    await flush();
    assert.equal(f.pendingSize(), 1);
    assert.equal(f.prepareAudio("same"), replacement);
    assert.equal(f.responses.length, 1);
    f.responses.shift()();
    await replacement;
    await oldResult;
    assert.equal(f.pendingSize(), 0);
});
