/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

type Result = { success: boolean; data?: ArrayBuffer; error?: string; };
function fixture(response: () => Promise<Response> = async () => new Response("https://example.com/file")) {
    const calls: { url: string; options?: RequestInit; }[] = [];
    const timers = new Set<() => void>();
    const source = readFileSync(process.env.AUDIT_UPLOAD_NATIVE_SOURCE ?? "src/equicordplugins/fileUpload/native.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const shared = transpileModule(readFileSync("src/equicordplugins/fileUpload/request.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const request = runInNewContext(shared + "\nexports;", { exports: {}, URL, Blob, Uint8Array });
    const api = runInNewContext(outputText + "\nexports;", { exports: {}, require: () => request, URL, ArrayBuffer, Uint8Array, Blob, FormData, Headers, Response, AbortController, Buffer, TextDecoder,
        setTimeout: (fn: () => void) => { timers.add(fn); return fn; }, clearTimeout: (fn: () => void) => timers.delete(fn),
        fetch: async (url: string, options?: RequestInit) => { calls.push({ url, options }); return response(); }
    }) as {
        fetchFile(event: object, url: unknown): Promise<Result>;
        uploadToS3(event: object, data: unknown, url: unknown, headers: unknown): Promise<Result>;
        uploadToCatbox(event: object, data: unknown, filename: unknown): Promise<Result>;
        cancelUploads(event: object): void;
    };
    return { api, calls, timers, event: { sender: Object.assign(new EventEmitter(), { id: 1 }) } };
}

test("Native downloads reject non-HTTPS URLs and credentials before fetching", async () => {
    const f = fixture();
    for (const url of ["file:///C:/secret.txt", "http://example.com/a", "https://user:pass@example.com/a", 123]) assert.equal((await f.api.fetchFile(f.event, url)).success, false);
    assert.equal(f.calls.length, 0);
});

test("Native upload IPC rejects malformed buffers, filenames, URLs and headers", async () => {
    const f = fixture();
    assert.equal((await f.api.uploadToCatbox(f.event, "not bytes", "a.png")).success, false);
    assert.equal((await f.api.uploadToCatbox(f.event, new ArrayBuffer(1), "bad\r\nname")).success, false);
    assert.equal((await f.api.uploadToS3(f.event, new ArrayBuffer(1), "http://example.com", {})).success, false);
    assert.equal((await f.api.uploadToS3(f.event, new ArrayBuffer(1), "https://example.com", { Authorization: 123 })).success, false);
    assert.equal(f.calls.length, 0);
});

test("Native downloads reject excessive declared content length and cancel the response", async () => {
    let cancelled = false;
    const f = fixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), { headers: { "content-length": String(3 * 1024 ** 3) } }));
    const result = f.api.fetchFile(f.event, "https://example.com/file");
    await Promise.resolve();
    if (!f.calls[0]?.options?.signal) return assert.fail("Download must carry a cancellation signal.");
    assert.equal((await result).success, false);
    assert.equal(cancelled, true);
    assert.equal(f.timers.size, 0);
});

test("Native requests retain a deadline while consuming bodies and cancellation is sender scoped", async () => {
    const f = fixture(async () => new Response(new ReadableStream({ start() {} })));
    const pending = f.api.fetchFile(f.event, "https://example.com/file");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.timers.size, 1);
    const signal = f.calls[0].options?.signal;
    assert.ok(signal);
    f.api.cancelUploads({ sender: { id: 2 } });
    assert.equal(signal.aborted, false);
    f.api.cancelUploads(f.event);
    assert.equal(signal.aborted, true);
    assert.equal((await pending).success, false);
    assert.equal(f.timers.size, 0);
});

test("Native upload redirects cannot carry credentials to another origin after switching to GET", async () => {
    let redirects = 0;
    const f = fixture(async () => new Response(null, { status: 303, headers: { location: ++redirects === 1 ? "/done" : "https://other.example/file" } }));
    assert.equal((await f.api.uploadToS3(f.event, new ArrayBuffer(1), "https://example.com/upload", { Authorization: "secret" })).success, false);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.url.startsWith("https://example.com/")));
});

test("Native uploads cancel stalled bodies when their renderer exits and remove sender listeners", async () => {
    for (const event of ["destroyed", "render-process-gone"]) {
        const f = fixture(async () => new Response(new ReadableStream({ cancel() { throw new Error("Cancellation failed"); } })));
        const pending = f.api.fetchFile(f.event, "https://example.com/file");
        await new Promise(resolve => setImmediate(resolve));
        f.event.sender.emit(event);
        assert.equal((await pending).success, false);
        assert.equal(f.event.sender.listenerCount("destroyed"), 0);
        assert.equal(f.event.sender.listenerCount("render-process-gone"), 0);
        assert.equal(f.timers.size, 0);
        await new Promise(resolve => setImmediate(resolve));
    }
});
