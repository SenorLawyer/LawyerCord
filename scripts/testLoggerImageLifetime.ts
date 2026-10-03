/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>(res => resolve = res);
    return { promise, resolve };
}

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown>) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    return runInNewContext(`${outputText}\nexports;`, {
        exports: {}, AbortController, AbortSignal, TextDecoder, TextEncoder, Uint8Array,
        ...globals,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
}

function imageFixture(web = false) {
    let scans = 0;
    let nativeCalls = 0;
    let paths = Promise.resolve(["images/1.png"]);
    let request = Promise.resolve({ path: "cached", error: null });
    let response = () => new Response(new Uint8Array([1, 2, 3]));
    const saved: { path: string; bytes: Uint8Array; }[] = [];
    const api = load(process.env.AUDIT_IMAGE_MANAGER_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/utils/saveImage/ImageManager.ts", {
        "@api/DataStore": { createStore() {}, keys: () => { scans++; return paths; }, get: async () => "data", del: async () => {},
            set: async (path: string, bytes: Uint8Array) => saved.push({ path, bytes }) },
        "@utils/misc": { sleep: async () => {} }, "../constants": { DEFAULT_IMAGE_CACHE_DIR: "images" },
        "../..": { Flogger: { error() {}, warn() {} }, settings: { store: { attachmentSizeLimitInMegabytes: 4 / 1024 / 1024 } },
            Native: { getImageNative: async () => { nativeCalls++; return "native"; }, tryDownloadAttachment: () => { nativeCalls++; return request; } } }
    }, { IS_WEB: web, fetch: async () => response() }) as {
        getImage(id: string): Promise<unknown>; downloadAttachment(attachment: object): Promise<string | undefined>; stopDownloads(): void;
    };
    return { api, saved, counts: () => ({ scans, nativeCalls }), setPaths: (value: Promise<string[]>) => paths = value,
        setRequest: (value: typeof request) => request = value, respond: (value: typeof response) => response = value };
}

test("Image cache indexing is lazy and concurrent lookups share one scan", async () => {
    const f = imageFixture();
    assert.equal(f.counts().scans, 0);
    assert.deepEqual(await Promise.all([f.api.getImage("1"), f.api.getImage("1")]), ["data", "data"]);
    assert.deepEqual(f.counts(), { scans: 1, nativeCalls: 0 });
});

test("Stopping image work prevents late cache hydration and native publication", async () => {
    const f = imageFixture();
    const keys = deferred<string[]>();
    f.setPaths(keys.promise);
    const lookup = f.api.getImage("1");
    f.api.stopDownloads();
    keys.resolve(["images/1.png"]);
    assert.equal(await lookup, null);
    assert.equal(f.counts().nativeCalls, 0);
    const request = deferred<{ path: string; error: null; }>();
    f.setRequest(request.promise);
    const attachment = { id: "1", url: "https://cdn.discordapp.com/1.png", fileExtension: ".png" };
    const first = f.api.downloadAttachment(attachment);
    assert.equal(f.api.downloadAttachment(attachment), first);
    f.api.stopDownloads();
    request.resolve({ path: "old", error: null });
    await assert.rejects(first, { name: "AbortError" });
});

test("Preparing images records eligible metadata without starting downloads", () => {
    const f = imageFixture();
    const cache = load("src/equicordplugins/messageLoggerEnhanced/utils/saveImage/index.ts", {
        "../..": { settings: { store: { attachmentSizeLimitInMegabytes: 1, attachmentFileExtensions: "png" } } },
        "./ImageManager": f.api
    }, { URL, Blob }) as { prepareMessageImages(message: object): string[]; };
    const attachments = ["1", "2"].map(id => ({ id, size: 3, filename: `${id}.png`, url: `https://cdn.discordapp.com/${id}.png`, proxy_url: `https://cdn.discordapp.com/${id}.png` }));
    assert.deepEqual(Array.from(cache.prepareMessageImages({ attachments })), ["1", "2"]);
    assert.equal(f.counts().nativeCalls, 0);
    assert.ok(attachments.every(attachment => !("path" in attachment)));
});

test("Web image downloads enforce actual streamed bytes before IDB and release readers", async () => {
    const f = imageFixture(true);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
    f.respond(() => new Response(body));
    const attachment = { id: "1", url: "https://cdn.discordapp.com/1.png", fileExtension: ".png" };
    assert.equal(await f.api.downloadAttachment(attachment), undefined);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(f.saved.length, 0);
    f.respond(() => new Response(new Uint8Array([1, 2, 3])));
    assert.equal(await f.api.downloadAttachment(attachment), "images/1.png");
    assert.deepEqual(Array.from(f.saved[0].bytes), [1, 2, 3]);
});

function ioFixture() {
    let cancelled = false;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"messages":[broken')); },
        cancel() { cancelled = true; }
    });
    const output = new WritableStream<Uint8Array>({ abort() { aborted = true; } });
    const api = load(process.env.AUDIT_LOG_IO_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/utils/settingsUtils.ts", {
        "@streamparser/json/jsonparser.js": createRequire(import.meta.url)("@streamparser/json/jsonparser.js"),
        "@utils/web": { chooseFile: async () => ({ stream: () => body }) },
        "@webpack/common": { Toasts: { genId() {}, show() {}, Type: { FAILURE: "failure", SUCCESS: "success" } } },
        "native-file-system-adapter": { showSaveFilePicker: async () => ({ createWritable: async () => output }) },
        "..": {}, "../db": { importMessagesIDB: async () => 0,
            iterateAllMessagesIDB: async function* () { yield { message: {} }; throw new Error("Database failed"); } }
    }, { IS_WEB: true, console: { error() {} } }) as { importLogs(): Promise<void>; exportLogs(): Promise<void>; };
    return { api, body, output, cancelled: () => cancelled, aborted: () => aborted };
}

test("Malformed web log imports cancel their reader and release its lock", async () => {
    const f = ioFixture();
    await f.api.importLogs();
    assert.equal(f.cancelled(), true);
    assert.equal(f.body.locked, false);
});

test("Database failures abort web log exports and release their writer", async () => {
    const f = ioFixture();
    await f.api.exportLogs();
    assert.equal(f.aborted(), true);
    assert.equal(f.output.locked, false);
});


test("Completing a background attachment invalidates a previous missing image result", async () => {
    let bytes: Uint8Array | null = null;
    let reads = 0;
    const cache = load("src/equicordplugins/messageLoggerEnhanced/utils/saveImage/index.ts", {
        "../..": { settings: { store: {} } },
        "./ImageManager": { getImage: async () => { reads++; return bytes; } }
    }, { URL, Blob }) as { getAttachmentBlobUrl(attachment: object): Promise<string | null>; invalidateAttachmentBlobUrl(id: string): void; clearAttachmentBlobUrlCache(): void; };
    const attachment = { id: "1", fileExtension: ".png" };
    assert.equal(await cache.getAttachmentBlobUrl(attachment), null);
    bytes = new Uint8Array([1]);
    cache.invalidateAttachmentBlobUrl("1");
    assert.match(await cache.getAttachmentBlobUrl(attachment) ?? "", /^blob:/);
    assert.equal(reads, 2);
    cache.clearAttachmentBlobUrlCache();
});

test("Both export targets omit internal attachment work while preserving the log format", async () => {
    for (const web of [false, true]) {
        const chunks: string[] = [];
        const row = { message_id: "1", channel_id: "2", status: "DELETED", message: { id: "1" }, attachmentWork: { ownerId: "private", revision: "internal", pendingIds: ["3"] } };
        const writable = new WritableStream<Uint8Array>({ write(bytes) { chunks.push(new TextDecoder().decode(bytes)); } });
        const api = load("src/equicordplugins/messageLoggerEnhanced/utils/settingsUtils.ts", {
            "@streamparser/json/jsonparser.js": {}, "@utils/web": {},
            "@webpack/common": { Toasts: { genId() {}, show() {}, Type: { SUCCESS: "success" } } },
            "native-file-system-adapter": { showSaveFilePicker: async () => ({ createWritable: async () => writable }) },
            "..": { Native: { startNativeLogExport: async () => "stream", writeNativeLogChunk: async (_id: string, chunk: string) => chunks.push(chunk), finishNativeLogExport: async () => {}, cancelNativeLogExport: async () => {} } },
            "../db": { iterateAllMessagesIDB: async function* () { yield [row]; } }
        }, { IS_WEB: web, console }) as { exportLogs(): Promise<void>; };
        await api.exportLogs();
        const text = chunks.join("");
        assert.ok(!text.includes("attachmentWork"));
        assert.deepEqual(JSON.parse(text).messages, [[{ message_id: "1", channel_id: "2", status: "DELETED", message: { id: "1" } }]]);
    }
});
