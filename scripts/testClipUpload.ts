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

function pending<T>() {
    let resolve: (value: T) => void = () => assert.fail("Promise not initialized");
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const slot = { ok: true, body: { attachments: [{ upload_url: "https://uploads.example/clip", upload_filename: "clip" }] } };
const options = { fileName: "clip.mp4", participants: [], title: "clip", spoiler: false, remix: false, thumbnail: false, createdAt: "2026-01-01T00:00:00Z", message: "", channelId: "channel" };
const file = () => new File(["clip"], "clip.mp4", { type: "video/mp4" });

function harness(stage: "reservation" | "put" | "convert" | "metadata" = "reservation") {
    const deferred = pending<unknown>();
    let userId = "first";
    const posts: string[] = [];
    let puts = 0;
    let conversions = 0;
    let tempFiles = 0;
    let released = 0;
    const native = {
        chooseVideoFile: async () => ({ token: "picked", name: "clip.mp4", type: "video/mp4" }),
        parseClipFileMetadata: () => deferred.promise,
        releaseVideoFile: async () => { released++; },
        createTempVideoFile: async () => { tempFiles++; return "temp"; },
        createTempVideoFileFromBytes: async () => { tempFiles++; return "temp"; },
        getTempVideoFilePath: async () => "temp.mp4", readVideoFile: async () => new Uint8Array([1]),
        deleteTempVideoFile: async () => {}
    };
    const mocks: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" },
        "./ffmpeg": { convertClipToMp4: async () => { conversions++; await deferred.promise; return file(); } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            MediaEngineStore: { getMediaEngine: () => ({ updateClipMetadata: async () => {} }) },
            Constants: { Endpoints: { MESSAGE_CREATE_ATTACHMENT_UPLOAD: () => "reserve", MESSAGES: () => "send" } },
            SnowflakeUtils: { fromTimestamp: () => "nonce" }, showToast: () => {}, Toasts: { Type: {} },
            RestAPI: { post: async ({ url }: { url: string; }) => {
                posts.push(url);
                if (url === "reserve") return stage === "reservation" ? deferred.promise : slot;
                if (stage === "convert" && conversions === 0) throw { body: { code: 50174 } };
                return { ok: true };
            } }
        }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/clipUpload.desktop/upload.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        VencordNative: { pluginHelpers: { ClipUpload: native } }, AbortController, DOMException, Error, File,
        fetch: async () => { puts++; if (stage === "put") await deferred.promise; return { ok: true }; }
    });
    return { api, deferred, posts, account: (id: string) => { userId = id; }, puts: () => puts, tempFiles: () => tempFiles, released: () => released };
}

test("stopping during reservation prevents uploading and sending", async () => {
    const h = harness();
    const upload = h.api.uploadClipFile(file(), options);
    await flush();
    h.api.abortActiveClipUploads();
    h.deferred.resolve(slot);
    assert.equal(await upload, false);
    assert.equal(h.puts(), 0);
    assert.deepEqual(h.posts, ["reserve"]);
});

test("account changes during upload prevent sending from the new account", async () => {
    for (const stage of ["reservation", "put"] as const) {
        const h = harness(stage);
        const upload = h.api.uploadClipFile(file(), options);
        await flush();
        h.account("second");
        h.deferred.resolve(slot);
        assert.equal(await upload, false);
        assert.deepEqual(h.posts, ["reserve"]);
    }
});

test("stopping a conversion prevents stamping and reserving a second upload", async () => {
    const h = harness("convert");
    const upload = h.api.uploadClipFile(file(), options);
    await flush();
    h.api.abortActiveClipUploads();
    h.deferred.resolve(undefined);
    assert.equal(await upload, false);
    assert.equal(h.tempFiles(), 0);
    assert.deepEqual(h.posts, ["reserve", "send"]);
});

test("cancelled metadata picking releases its token without preparing a temp file", async () => {
    const h = harness("metadata");
    const controller = new AbortController();
    const picking = h.api.pickClipFile(true, controller.signal);
    const rejected = assert.rejects(picking, { name: "AbortError" });
    await flush();
    controller.abort();
    h.deferred.resolve(null);
    await rejected;
    assert.equal(h.tempFiles(), 0);
    assert.equal(h.released(), 1);
});

test("closing one modal cancels only its upload", async () => {
    const h = harness();
    const first = new AbortController();
    const second = new AbortController();
    const closeFirst = h.api.trackClipUpload(first);
    const closeSecond = h.api.trackClipUpload(second);
    const firstUpload = h.api.uploadClipFile(file(), options, first.signal);
    const secondUpload = h.api.uploadClipFile(file(), options, second.signal);
    await flush();
    closeFirst();
    h.deferred.resolve(slot);
    assert.equal(await firstUpload, false);
    assert.equal(await secondUpload, true);
    assert.equal(second.signal.aborted, false);
    assert.equal(h.puts(), 1);
    closeSecond();
});

function loadSource(path: string, mocks: Record<string, unknown>) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    return runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        File, Uint8Array, DOMException
    });
}

test("clip conversions run one worker and release it on cancellation, failure and success", async () => {
    let active = 0;
    let peak = 0;
    const workers: FakeFFmpeg[] = [];
    const logs = { Logger: class { info() {} error() {} } };
    const { Queue } = loadSource("src/utils/Queue.ts", { "./Logger": logs });
    class FakeFFmpeg {
        running = true;
        exit = pending<number>();
        reject: (reason: Error) => void = () => {};
        constructor() { active++; peak = Math.max(peak, active); workers.push(this); }
        async writeFile() {}
        exec() { return Promise.race([this.exit.promise, new Promise<number>((_resolve, reject) => { this.reject = reject; })]); }
        async readFile() { return new Uint8Array([7]); }
        terminate() {
            if (!this.running) return;
            this.running = false;
            active--;
            this.reject(new Error("Worker terminated"));
        }
    }
    const { convertClipToMp4 } = loadSource("src/equicordplugins/clipUpload.desktop/ffmpeg.ts", {
        "@ffmpeg/ffmpeg": { FFmpeg: FakeFFmpeg }, "@utils/ffmpeg": { loadFFmpeg: async () => {} },
        "@utils/Logger": logs, "@utils/Queue": { Queue }
    });
    const cancelled = new AbortController();
    const skipped = new AbortController();
    const current = new AbortController();
    const first = convertClipToMp4(file(), "first.mp4", cancelled.signal);
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    const second = convertClipToMp4(file(), "skipped.mp4", skipped.signal);
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    const third = convertClipToMp4(file(), "success.mp4", current.signal);
    await flush();
    assert.equal(workers.length, 1);
    skipped.abort();
    await secondRejected;
    assert.equal(workers.length, 1);
    cancelled.abort();
    await firstRejected;
    await flush();
    assert.equal(workers.length, 2);
    workers[1].exit.resolve(0);
    const converted = await third;
    assert.equal(converted.name, "success.mp4");
    assert.equal(converted.type, "video/mp4");
    assert.deepEqual(Array.from(new Uint8Array(await converted.arrayBuffer())), [7]);
    assert.equal(active, 0);
    const failed = convertClipToMp4(file(), "failed.mp4", current.signal);
    const failure = assert.rejects(failed, /Couldn't convert/);
    await flush();
    workers[2].exit.resolve(1);
    await failure;
    assert.equal(active, 0);
    assert.equal(peak, 1);
});
