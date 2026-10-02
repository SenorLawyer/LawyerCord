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
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface DownloadResult { error: string | null; path: string | null; }
interface NativeApi {
    downloadAttachment(event: object, attachment: unknown): Promise<DownloadResult>;
    updateAllowedExtensions(event: object, extensions: unknown): Promise<void>;
    cancelNativeAttachmentDownloads(event: object): void;
    init(event: object): Promise<void>;
    initDirs(): Promise<void>;
    getImageNative(event: object, id: string): Promise<Uint8Array | null>;
    deleteFileNative(event: object, id: string): Promise<void>;
}

async function fixture(t: { after(callback: () => Promise<void>): void; }) {
    const event = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
    const root = await fs.mkdtemp(path.join(tmpdir(), "lawyercord-attachment-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const settings = { imageCacheDir: root, attachmentFileExtensions: "png" };
    const requests: { url: string; options: RequestInit; }[] = [];
    let fullReads = 0;
    let responder = () => new Response(new Uint8Array([1, 2, 3]));
    const mocks: Record<string, unknown> = {
        "node:crypto": { randomUUID }, "node:fs/promises": fs, "node:path": path,
        "@main/utils/constants": { DATA_DIR: root }, "@utils/Logger": { Logger: class { warn() {} } },
        "electron": {}, "./settings": { getSettings: async () => settings, saveSettings: async () => {} },
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
    const api: NativeApi = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, URL, AbortController, AbortSignal, Buffer, console: { error() {} },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        fetch: async (url: URL | string, options: RequestInit = {}) => {
            requests.push({ url: String(url), options });
            const response = responder();
            const original = response.arrayBuffer.bind(response);
            response.arrayBuffer = () => { fullReads++; return original(); };
            return response;
        }
    });
    const attachment = { id: "123456789012345678", fileExtension: ".png",
        url: "https://media.discordapp.net/attachments/1/image.png", oldUrl: "https://cdn.discordapp.com/attachments/1/image.png" };
    return { root, api, attachment, settings, requests, event, fullReads: () => fullReads,
        respond: (callback: () => Response) => { responder = callback; },
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
    f.respond(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
    const first = f.download();
    const second = f.download();
    assert.equal(first, second);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.api.cancelNativeAttachmentDownloads(f.event);
    assert.ok(stream);
    stream.enqueue(new Uint8Array([1, 2, 3]));
    stream.close();
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
