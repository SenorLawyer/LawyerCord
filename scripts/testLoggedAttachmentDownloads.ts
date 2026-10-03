/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface DownloadResult { error: string | null; path: string | null; busy?: true; }
interface NativeApi {
    downloadsIdle(): boolean;
    downloadAttachment(event: object, attachment: unknown): Promise<DownloadResult>;
    tryDownloadAttachment(event: object, attachment: unknown): Promise<DownloadResult>;
    waitForAttachmentDownloadCapacity(event: object): Promise<boolean>;
    chooseDir(event: object, key: string): Promise<string>;
    updateAllowedExtensions(event: object, extensions: unknown): Promise<void>;
    cancelNativeAttachmentDownloads(event: object): void;
    init(event: object): Promise<void>;
    initDirs(): Promise<void>;
    getImageNative(event: object, id: string): Promise<Uint8Array | null>;
    deleteFileNative(event: object, id: string): Promise<void>;
}

async function fixture(t: { after(callback: () => Promise<void>): void; }, initialize = true) {
    const event = { sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) };
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "lawyercord-attachment-test-")));
    const releases: (() => void)[] = [];
    t.after(async () => {
        api.cancelNativeAttachmentDownloads(event);
        for (const release of releases) release();
        try {
            await until(api.downloadsIdle);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
    const settings = { imageCacheDir: root, attachmentFileExtensions: "png" };
    const requests: { url: string; options: RequestInit; }[] = [];
    let fullReads = 0;
    let responder: () => Response | Promise<Response> = () => new Response(new Uint8Array([1, 2, 3]));
    let cleanup: Promise<void> | undefined;
    let cleanupStarted = 0;
    let unlinkCleanup: Promise<void> | undefined;
    let unlinkStarted = 0;
    let fileWork = 0;
    let directory = root;
    let rootResolution: Promise<void> | undefined;
    let rootResolutions = 0;
    let settingsRead: Promise<void> | undefined;
    let settingsReads = 0;
    const mocks: Record<string, unknown> = {
        "node:crypto": { randomUUID }, "node:fs/promises": { ...fs,
            realpath: async (name: string) => { if (name === root) { rootResolutions++; await rootResolution; } return fs.realpath(name); },
            open: async (name: string, flags: string) => {
                fileWork++;
                const file = await fs.open(name, flags);
                const close = file.close.bind(file);
                file.close = async () => { cleanupStarted++; await cleanup; await close(); };
                return file;
            },
            unlink: async (name: string) => { unlinkStarted++; await unlinkCleanup; await fs.unlink(name); }
        }, "node:path": path,
        "@main/utils/constants": { DATA_DIR: root }, "@utils/Logger": { Logger: class { warn() {} } },
        "electron": { dialog: { showOpenDialog: async () => ({ filePaths: [directory] }) } }, "./settings": { getSettings: async () => { fileWork++; settingsReads++; await settingsRead; return settings; }, saveSettings: async () => {} },
        "./export": {}, "./import": {}, "../list": { blockedExts: ["exe", "js"] },
        "../utils/constants": { DEFAULT_ATTACHMENT_FILE_EXTENSIONS: "png" },
        "./utils": { ensureDirectoryExists: async (dir: string) => fs.mkdir(dir, { recursive: true }),
            getAttachmentIdFromFilename: (name: string) => path.parse(name).name, sleep: async () => {} }
    };
    const source = readFileSync(process.env.AUDIT_LOGGER_NATIVE_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/native/index.ts", "utf8")
        .replace("500 * 1024 * 1024", "100");
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const api: NativeApi = runInNewContext(`${outputText}\n({ ...exports, downloadsIdle: () => downloads.size === 0 });`, {
        exports: {}, URL, AbortController, AbortSignal, Buffer, console: { error() {} },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        fetch: async (url: URL | string, options: RequestInit = {}) => {
            requests.push({ url: String(url), options });
            const response = await responder();
            const original = response.arrayBuffer.bind(response);
            response.arrayBuffer = () => { fullReads++; return original(); };
            return response;
        }
    });
    if (initialize) await api.initDirs();
    const attachment = { id: "123456789012345678", fileExtension: ".png",
        url: "https://media.discordapp.net/attachments/1/image.png", oldUrl: "https://cdn.discordapp.com/attachments/1/image.png" };
    return { root, api, attachment, settings, requests, event, fullReads: () => fullReads,
        defer<T>(fallback: T) {
            const pending = deferred<T>();
            releases.push(() => pending.resolve(fallback));
            return pending;
        },
        onTeardown: (release: () => void) => releases.push(release),
        respond: (callback: () => Response | Promise<Response>) => { responder = callback; },
        holdCleanup: (promise: Promise<void>) => cleanup = promise, cleanupStarted: () => cleanupStarted, fileWork: () => fileWork,
        holdUnlink: (promise: Promise<void>) => unlinkCleanup = promise, unlinkStarted: () => unlinkStarted,
        chooseDirectory: (dir: string) => directory = dir,
        holdRootResolution: (promise: Promise<void>) => rootResolution = promise, rootResolutions: () => rootResolutions,
        holdSettingsRead: (promise: Promise<void>) => settingsRead = promise, settingsReads: () => settingsReads,
        download: (overrides = {}) => api.downloadAttachment(event, { ...attachment, ...overrides }) };
}

test("native log attachments stream to a contained canonical filename without whole-body buffers", async t => {
    const f = await fixture(t);
    for (const extension of [".PNG", "png"]) {
        const result = await f.download({ id: extension === "png" ? "2" : f.attachment.id, fileExtension: extension });
        assert.equal(result.error, null);
        assert.equal(result.path, path.join(f.root, `${extension === "png" ? "2" : f.attachment.id}.png`));
        assert.ok(result.path);
        assert.deepEqual(await fs.readFile(result.path), Buffer.from([1, 2, 3]));
    }
    assert.equal(f.fullReads(), 0);
    assert.equal(f.requests[0].options.redirect, "error");
    assert.ok(f.requests[0].options.signal instanceof AbortSignal);
    assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("Native attachment requests coalesce and cancellation prevents late publication", async t => {
    const f = await fixture(t);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    f.onTeardown(() => { if (stream) stream.close(); });
    f.respond(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
    const first = f.download();
    const second = f.download();
    assert.equal(first, second);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.api.cancelNativeAttachmentDownloads(f.event);
    assert.ok(stream);
    stream.enqueue(new Uint8Array([1, 2, 3]));
    stream.close();
    stream = undefined;
    assert.ok((await first).error);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
});

test("Native cache rescans replace directory entries and deletion removes cached IDs", async t => {
    const f = await fixture(t);
    const old = path.join(f.root, "old");
    const next = path.join(f.root, "next");
    await fs.mkdir(old);
    await fs.mkdir(next);
    await fs.writeFile(path.join(old, "1.png"), "old");
    await fs.writeFile(path.join(next, "2.png"), "new");
    f.settings.imageCacheDir = old;
    await f.api.initDirs();
    await f.api.init(f.event);
    assert.ok(await f.api.getImageNative(f.event, "1"));
    f.settings.imageCacheDir = next;
    await f.api.initDirs();
    await f.api.init(f.event);
    assert.equal(await f.api.getImageNative(f.event, "1"), null);
    await f.api.deleteFileNative(f.event, "2");
    await f.api.deleteFileNative(f.event, "2");
    assert.equal(await f.api.getImageNative(f.event, "2"), null);
});

test("Native cached attachment reads reject oversized disk files and nonfiles", async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, "1.png"), new Uint8Array(101));
    await fs.mkdir(path.join(f.root, "2.png"));
    await fs.writeFile(path.join(f.root, "3.png"), new Uint8Array([1, 2, 3]));
    await f.api.init(f.event);
    assert.equal(await f.api.getImageNative(f.event, "1"), null);
    assert.equal(await f.api.getImageNative(f.event, "2"), null);
    assert.deepEqual(await f.api.getImageNative(f.event, "3"), Buffer.from([1, 2, 3]));
});

test("Native cached attachment scans reject symbolic links outside the cache", async t => {
    const f = await fixture(t);
    const cache = path.join(f.root, "cache");
    const outside = path.join(f.root, "outside.png");
    await fs.mkdir(cache);
    await fs.writeFile(outside, "outside");
    try {
        await fs.symlink(outside, path.join(cache, "1.png"), "file");
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
            t.skip("Creating file symlinks requires Windows developer mode or administrator privileges.");
            return;
        }
        throw error;
    }
    f.settings.imageCacheDir = cache;
    await f.api.initDirs();
    await f.api.init(f.event);
    assert.equal(await f.api.getImageNative(f.event, "1"), null);
});

test("native log attachments reject path tokens and untrusted destinations before downloading", async t => {
    const f = await fixture(t);
    for (const extension of [".png/../../escape", ".png\\..\\escape", ".png:stream", ".png\0", ".exe"]) {
        f.settings.attachmentFileExtensions = extension.replace(".", "");
        assert.ok((await f.download({ fileExtension: extension })).error);
    }
    f.settings.attachmentFileExtensions = "png";
    for (const url of ["http://cdn.discordapp.com/image", "https://cdn.discordapp.com.evil.example/image", "https://user@cdn.discordapp.com/image",
        "https://cdn.discordapp.com:8080/image", "file:///image", "https://127.0.0.1/image"]) {
        assert.ok((await f.download({ url })).error);
        assert.ok((await f.download({ oldUrl: url })).error);
    }
    for (const id of ["../1", "a:b", "1/2", "1\\2", "", "1".repeat(21)]) assert.ok((await f.download({ id })).error);
    assert.ok((await f.api.downloadAttachment({}, null)).error);
    assert.ok((await f.download({ fileExtension: 123 })).error);
    assert.equal(f.requests.length, 0);
});

test("native log download limits cover declared and streamed bytes without publishing partial files", async t => {
    const f = await fixture(t);
    f.respond(() => new Response(new Uint8Array([1]), { headers: { "content-length": "101" } }));
    assert.ok((await f.download()).error);
    assert.deepEqual(await fs.readdir(f.root), []);
    f.respond(() => new Response(new Uint8Array(101)));
    assert.ok((await f.download()).error);
    assert.deepEqual(await fs.readdir(f.root), []);
    f.respond(() => new Response(new Uint8Array(100)));
    assert.equal((await f.download()).error, null);
    assert.equal((await fs.readFile(path.join(f.root, `${f.attachment.id}.png`))).length, 100);
});

test("failed native log streams release temporary files and return scrubbed errors", async t => {
    const f = await fixture(t);
    f.respond(() => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error(`Failed at ${f.root}`)); }
    })));
    const result = await f.download();
    assert.ok(result.error);
    assert.equal(result.path, null);
    assert.equal(result.error.includes(f.root), false);
    assert.deepEqual(await fs.readdir(f.root), []);
});

test("native log retries release rejected bodies and preserve the old URL fallback", async t => {
    const f = await fixture(t);
    let cancelled = 0;
    f.respond(() => f.requests.length < 4 ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 }) : new Response("image"));
    assert.equal((await f.download()).error, null);
    assert.equal(f.requests.length, 4);
    assert.equal(cancelled, 3);
    assert.equal(f.requests[0].url, f.attachment.url);
    assert.ok(f.requests.slice(1).every(request => request.url === f.attachment.oldUrl));
});

test("native extension settings reject path fragments and malformed IPC input", async t => {
    const f = await fixture(t);
    await f.api.updateAllowedExtensions({}, "PNG,../../escape,exe,png:stream,webp");
    assert.equal(f.settings.attachmentFileExtensions, "png,webp");
    await f.api.updateAllowedExtensions({}, 12);
    assert.equal(f.settings.attachmentFileExtensions, "png,webp");
    await f.api.updateAllowedExtensions({}, "");
    assert.equal(f.settings.attachmentFileExtensions, "none");
});

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
}

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await delay(5);
    assert.ok(predicate(), "Native work did not reach the expected boundary within five seconds.");
}

test("Sixteen legacy attachment calls admit only four physical downloads and one listener pair", async t => {
    const f = await fixture(t);
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const work = Array.from({ length: 16 }, (_, index) => f.download({ id: String(index + 1) }));
    try {
        await until(() => f.requests.length >= 4);
        assert.equal(f.requests.length, 4);
        assert.equal(f.event.sender.listenerCount("destroyed"), 1);
        assert.equal(f.event.sender.listenerCount("render-process-gone"), 1);
        const rejected = await Promise.all(work.slice(4));
        assert.ok(rejected.every(result => result.error && result.path === null && result.busy));
        const before = f.fileWork();
        assert.equal((await f.api.tryDownloadAttachment(f.event, { ...f.attachment, id: "99" })).busy, true);
        assert.equal(f.fileWork(), before);
        assert.equal(f.requests.length, 4);
        const invalid = await f.api.tryDownloadAttachment(f.event, { ...f.attachment, url: "https://invalid.example/file" });
        assert.equal(invalid.error, "Invalid attachment URL.");
        assert.equal(invalid.busy, undefined);
    } finally {
        f.api.cancelNativeAttachmentDownloads(f.event);
        response.resolve(new Response());
        await Promise.all(work);
    }
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
    assert.equal(f.event.sender.listenerCount("render-process-gone"), 0);
});

test("Senders share physical downloads and cancelling one leaves the other attached", async t => {
    const f = await fixture(t);
    const other = { sender: Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false }) };
    f.onTeardown(() => f.api.cancelNativeAttachmentDownloads(other));
    const response = f.defer(new Response());
    f.respond(() => response.promise);
    const first = f.download();
    const second = f.api.tryDownloadAttachment(other, f.attachment);
    assert.notEqual(first, second);
    await until(() => f.requests.length === 1);
    f.api.cancelNativeAttachmentDownloads(f.event);
    assert.ok((await first).error);
    assert.equal(f.requests[0].options.signal?.aborted, false);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
    f.respond(() => new Response("new session"));
    assert.equal((await f.download({ id: "2" })).error, null);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].options.signal?.aborted, false);
    response.resolve(new Response("image"));
    assert.equal((await second).error, null);
    assert.equal(other.sender.listenerCount("destroyed"), 0);
    assert.equal(other.sender.listenerCount("render-process-gone"), 0);
});

test("Physical capacity stays occupied through stalled file cleanup and waiters share one promise", async t => {
    const f = await fixture(t);
    const cleanup = f.defer<void>(undefined);
    f.holdCleanup(cleanup.promise);
    const work = Array.from({ length: 4 }, (_, index) => f.download({ id: String(index + 1) }));
    await until(() => f.cleanupStarted() === 4);
    const waiter = f.api.waitForAttachmentDownloadCapacity(f.event);
    assert.equal(f.api.waitForAttachmentDownloadCapacity(f.event), waiter);
    let woke = false;
    void waiter.then(() => woke = true);
    f.api.cancelNativeAttachmentDownloads({ sender: Object.assign(new EventEmitter(), { id: 99 }) });
    await Promise.resolve();
    assert.equal(woke, false);
    assert.equal((await f.api.tryDownloadAttachment(f.event, f.attachment)).busy, true);
    cleanup.resolve();
    assert.equal(await waiter, true);
    await Promise.all(work);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
    assert.equal((await f.api.tryDownloadAttachment(f.event, f.attachment)).error, null);
});

test("Cancelling the final owner holds admission until response and temporary file cleanup settle", async t => {
    const f = await fixture(t);
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const work = Array.from({ length: 4 }, (_, index) => f.download({ id: String(index + 1) }));
    await until(() => f.requests.length === 4);
    const waiter = f.api.waitForAttachmentDownloadCapacity(f.event);
    f.event.sender.emit("render-process-gone");
    assert.equal(await waiter, false);
    assert.ok(f.requests.every(request => request.options.signal?.aborted));
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
    assert.equal(f.event.sender.listenerCount("render-process-gone"), 0);
    assert.equal((await f.api.tryDownloadAttachment(f.event, f.attachment)).busy, true);
    response.resolve(new Response());
    assert.ok((await Promise.all(work)).every(result => result.error));
    assert.deepEqual(await fs.readdir(f.root), []);
});

test("Changing the cache directory separates identical attachment IDs while old work settles", async t => {
    const f = await fixture(t);
    const response = f.defer(new Response());
    f.respond(() => response.promise);
    const old = f.download();
    await until(() => f.requests.length === 1);
    const next = path.join(f.root, "next");
    await fs.mkdir(next);
    f.chooseDirectory(next);
    await f.api.chooseDir(f.event, "imageCacheDir");
    f.respond(() => new Response("new"));
    const current = await f.download();
    assert.equal(current.path, path.join(next, `${f.attachment.id}.png`));
    response.resolve(new Response("old"));
    assert.ok((await old).error);
    assert.equal(await fs.readFile(current.path ?? "", "utf8"), "new");
    assert.deepEqual(await fs.readdir(f.root), ["next"]);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
});


test("Cold initialization keeps admission bounded and canonicalizes in-flight deduplication", async t => {
    const f = await fixture(t, false);
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const work = Array.from({ length: 4 }, (_, index) => f.download({ id: String(index + 1) }));
    assert.equal((await f.download({ id: "5" })).busy, true);
    await until(() => f.requests.length === 4);
    assert.equal(f.download({ id: "1" }), work[0]);
    response.resolve(new Response());
    assert.ok((await Promise.all(work)).every(result => result.error === null));
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
});

test("Failed downloads retain all slots until partial files have been removed", async t => {
    const f = await fixture(t);
    const cleanup = f.defer<void>(undefined);
    f.holdUnlink(cleanup.promise);
    f.respond(() => new Response(new Uint8Array(101)));
    const work = Array.from({ length: 4 }, (_, index) => f.download({ id: String(index + 1) }));
    await until(() => f.unlinkStarted() === 4);
    const waiter = f.api.waitForAttachmentDownloadCapacity(f.event);
    let ready = false;
    void waiter.then(() => ready = true);
    assert.equal((await f.download({ id: "5" })).busy, true);
    assert.equal(ready, false);
    assert.equal((await fs.readdir(f.root)).length, 4);
    cleanup.resolve();
    assert.equal(await waiter, true);
    assert.ok((await Promise.all(work)).every(result => result.error));
    assert.deepEqual(await fs.readdir(f.root), []);
});

test("Different attachment extensions cannot reuse a pending or cached path", async t => {
    const f = await fixture(t);
    f.settings.attachmentFileExtensions = "png,webp";
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const png = f.download();
    const webp = f.download({ fileExtension: ".webp" });
    assert.notEqual(png, webp);
    await until(() => f.requests.length === 2);
    response.resolve(new Response());
    assert.ok((await png).path?.endsWith(".png"));
    assert.ok((await webp).path?.endsWith(".webp"));
    assert.equal((await fs.readdir(f.root)).length, 2);
});


test("A renderer waiting only for capacity detaches on destruction without cancelling other owners", async t => {
    const f = await fixture(t);
    const other = { sender: Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false }) };
    f.onTeardown(() => f.api.cancelNativeAttachmentDownloads(other));
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const work = Array.from({ length: 4 }, (_, index) => f.download({ id: String(index + 1) }));
    await until(() => f.requests.length === 4);
    const waiter = f.api.waitForAttachmentDownloadCapacity(other);
    assert.equal(f.api.waitForAttachmentDownloadCapacity(other), waiter);
    assert.equal(other.sender.listenerCount("destroyed"), 1);
    other.sender.emit("destroyed");
    assert.equal(await waiter, false);
    assert.equal(other.sender.listenerCount("destroyed"), 0);
    assert.equal(other.sender.listenerCount("render-process-gone"), 0);
    assert.ok(f.requests.every(request => !request.options.signal?.aborted));
    response.resolve(new Response());
    await Promise.all(work);
});


test("A directory selection supersedes cold initialization without losing active slot ownership", async t => {
    const f = await fixture(t, false);
    const rootResolution = f.defer<void>(undefined);
    f.holdRootResolution(rootResolution.promise);
    const old = f.download();
    await until(() => f.rootResolutions() === 1);
    const next = path.join(f.root, "next");
    await fs.mkdir(next);
    f.chooseDirectory(next);
    await f.api.chooseDir(f.event, "imageCacheDir");
    const response = f.defer(new Response());
    f.respond(() => response.promise.then(() => new Response("image")));
    const current = f.download();
    await until(() => f.requests.length === 1);
    rootResolution.resolve();
    await f.api.waitForAttachmentDownloadCapacity(f.event);
    assert.ok((await old).error);
    assert.equal(f.download(), current);
    const remaining = ["2", "3", "4"].map(id => f.download({ id }));
    assert.equal((await f.download({ id: "5" })).busy, true);
    response.resolve(new Response());
    const results = await Promise.all([current, ...remaining]);
    assert.ok(results.every(result => result.path?.startsWith(next)));
    assert.equal(f.requests.length, 4);
});

test("Destroying a sender during cold initialization cannot start its download", async t => {
    const f = await fixture(t, false);
    const rootResolution = f.defer<void>(undefined);
    f.holdRootResolution(rootResolution.promise);
    const work = f.download();
    await until(() => f.rootResolutions() === 1);
    f.event.sender.emit("destroyed");
    assert.equal(f.event.sender.listenerCount("render-process-gone"), 0);
    rootResolution.resolve();
    await f.api.waitForAttachmentDownloadCapacity(f.event);
    assert.ok((await work).error);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await fs.readdir(f.root), []);
});

test("Cancellation during a settings read cannot publish a cached success", async t => {
    const f = await fixture(t);
    assert.equal((await f.download()).error, null);
    const settingsRead = f.defer<void>(undefined);
    f.holdSettingsRead(settingsRead.promise);
    const before = f.settingsReads();
    const work = f.download();
    await until(() => f.settingsReads() > before);
    f.api.cancelNativeAttachmentDownloads(f.event);
    settingsRead.resolve();
    assert.ok((await work).error);
    assert.equal(f.requests.length, 1);
});


async function rendererJob(f: Awaited<ReturnType<typeof fixture>>) {
    const message = { id: "1", attachments: [{ id: f.attachment.id, filename: "image.png", size: 3,
        url: f.attachment.oldUrl, proxy_url: f.attachment.url, content_type: "image/png" }] };
    const settings = { store: { attachmentSizeLimitInMegabytes: 1, attachmentFileExtensions: "png" } };
    const errors: unknown[] = [];
    const mocks: Record<string, unknown> = {
        "../..": { settings, Flogger: { error: (...values: unknown[]) => errors.push(values) }, Native: {
            tryDownloadAttachment: (attachment: unknown) => f.api.tryDownloadAttachment(f.event, attachment),
            waitForAttachmentDownloadCapacity: () => f.api.waitForAttachmentDownloadCapacity(f.event)
        } },
        "./ImageManager": {}, "@api/DataStore": { createStore() {} }, "@utils/misc": { sleep: async () => {} },
        "../constants": { DEFAULT_IMAGE_CACHE_DIR: "images" }, "@webpack/common": {}, "./utils": {},
        "./utils/cleanUp": {}, "./utils/constants": { DB_VERSION: 1 }, "./utils/LimitedMap": { LimitedMap: Map }, "./utils/saveImage": {}
    };
    function load(file: string) {
        const { outputText } = transpileModule(readFileSync(`src/equicordplugins/messageLoggerEnhanced/${file}`, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, URL, AbortController, AbortSignal, DOMException, IS_WEB: false,
            require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
    }
    const images = load("utils/saveImage/index.ts") as { prepareMessageImages(message: object): string[]; };
    const row = { message_id: message.id, message,
        attachmentWork: { ownerId: "owner", revision: "revision", pendingIds: images.prepareMessageImages(message) } };
    mocks.idb = { openDB: async () => ({ transaction: () => ({ done: Promise.resolve(), store: {
        openCursor: async () => ({ value: structuredClone(row), continue: async () => null })
    } }) }) };
    const db = load("db.ts") as { getAttachmentWorkPage(owner: string): Promise<{ job?: { attachment: object; }; }>; };
    const { job } = await db.getAttachmentWorkPage("owner");
    assert.ok(job);
    const manager = load("utils/saveImage/ImageManager.ts") as { downloadAttachment(attachment: object): Promise<string | undefined>; };
    return { job, row, errors, download: () => manager.downloadAttachment(job.attachment) };
}

test("Real renderer preparation and database projection preserve the native fallback URL", async t => {
    const f = await fixture(t);
    const renderer = await rendererJob(f);
    f.respond(() => f.requests.length === 1 ? new Response(null, { status: 403 }) : new Response("image"));
    assert.equal(await renderer.download(), path.join(f.root, `${f.attachment.id}.png`));
    assert.deepEqual(renderer.errors, []);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].url, f.attachment.url);
    assert.equal(f.requests[1].url, f.attachment.oldUrl);
});

test("A directory interruption retries the actual queued renderer payload under the new cache root", async t => {
    const f = await fixture(t);
    const renderer = await rendererJob(f);
    const response = f.defer(new Response());
    f.respond(() => response.promise);
    const download = renderer.download();
    await until(() => f.requests.length === 1);
    const next = path.join(f.root, "next");
    await fs.mkdir(next);
    f.chooseDirectory(next);
    await f.api.chooseDir(f.event, "imageCacheDir");
    assert.equal(renderer.row.attachmentWork.pendingIds.length, 1);
    assert.equal(f.requests.length, 1);
    f.respond(() => new Response("new"));
    response.resolve(new Response("old"));
    assert.equal(await download, path.join(next, `${f.attachment.id}.png`));
    assert.equal(f.requests.length, 2);
    assert.deepEqual(renderer.errors, []);
    assert.deepEqual(await fs.readdir(f.root), ["next"]);
});
