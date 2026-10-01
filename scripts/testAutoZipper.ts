/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { AsyncZipDeflate, unzipSync, Zip, ZipDeflate } from "fflate";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { Queue } from "../src/utils/Queue";

const { outputText } = transpileModule(readFileSync("src/equicordplugins/autoZipper/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

function fixture() {
    const listeners = new Map<string, (event: unknown) => void>();
    const operations: { name: string; files: Record<string, Uint8Array>; signal: AbortSignal; resolve(file: File): void; reject(error: Error): void; }[] = [];
    const uploads: { files: File[]; channel: { id: string }; }[] = [];
    const toasts: unknown[] = [];
    const errors: unknown[] = [];
    let channelId = "original";
    let userId = "account";
    let synchronousCalls = 0;
    const mocks: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({ store: { extensions: ".exe" } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/misc": { sleep: () => setImmediate() },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": {
            ChannelStore: { getChannel: (id: string) => ({ id }) }, SelectedChannelStore: { getChannelId: () => channelId },
            UserStore: { getCurrentUser: () => ({ id: userId }) }, DraftType: {}, Toasts: { Type: {} }, showToast: (toast: unknown) => toasts.push(toast),
            UploadHandler: { promptToUpload: (files: File[], channel: { id: string }) => uploads.push({ files, channel }) }
        },
        "fflate": { zipSync: () => { synchronousCalls++; return new Uint8Array([1]); } },
        "@utils/zip": { createZipFile: (name: string, files: Record<string, Uint8Array>, signal: AbortSignal) =>
            new Promise<File>((resolve, reject) => operations.push({ name, files, signal, resolve, reject })) }
    };
    const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, File, AbortController, DOMException, Uint8Array, setTimeout,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        document: {
            addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
            removeEventListener: (type: string, listener: (event: unknown) => void) => { if (listeners.has(type)) assert.equal(listeners.get(type), listener); listeners.delete(type); }
        }
    });
    const paste = (file: File) => listeners.get("paste")?.({ clipboardData: { files: [file] }, preventDefault() {}, stopPropagation() {} });
    const drop = (items: object[]) => listeners.get("drop")?.({ dataTransfer: { items }, preventDefault() {}, stopPropagation() {} });
    return { plugin, operations, uploads, toasts, errors, paste, drop, syncCalls: () => synchronousCalls,
        setChannel: (id: string) => { channelId = id; }, setUser: (id: string) => { userId = id; } };
}

test("AutoZipper compresses asynchronously and retains the initiating channel", async () => {
    const f = fixture();
    f.plugin.start();
    f.paste(new File(["payload"], "app.exe"));
    await setImmediate();
    assert.equal(f.syncCalls(), 0);
    assert.equal(f.operations.length, 1);
    assert.equal(f.operations[0].name, "app.zip");
    assert.equal(new TextDecoder().decode(f.operations[0].files["app.exe"]), "payload");
    f.setChannel("other");
    const zipped = new File(["archive"], "app.zip");
    f.operations[0].resolve(zipped);
    await setImmediate();
    await setImmediate();
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].files[0], zipped);
    assert.equal(f.uploads[0].channel.id, "original");
    f.plugin.stop();
});

function directory(name: string, entries: object[]) {
    return { name, isDirectory: true, isFile: false, createReader: () => {
        let read = false;
        return { readEntries: (resolve: (entries: object[]) => void) => {
            queueMicrotask(() => { resolve(read ? [] : entries); read = true; });
        } };
    } };
}

function fileEntry(file: File) {
    return { name: file.name, isDirectory: false, isFile: true, file: (resolve: (file: File) => void) => queueMicrotask(() => resolve(file)) };
}

test("AutoZipper preserves nested folder paths, special names and files without filesystem entries", async () => {
    const f = fixture();
    const original = new File(["image"], "image.png");
    const folder = directory("folder", [fileEntry(new File(["special"], "__proto__")), directory("nested", [fileEntry(new File(["text"], "content.txt"))])]);
    f.plugin.start();
    f.drop([
        { kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => original }
    ]);
    await setImmediate();
    assert.equal(f.operations.length, 1);
    assert.equal(f.operations[0].name, "folder.zip");
    assert.deepEqual(Object.keys(f.operations[0].files), ["__proto__", "nested/content.txt"]);
    assert.equal(new TextDecoder().decode(f.operations[0].files["__proto__"]), "special");
    f.operations[0].resolve(new File(["archive"], "folder.zip"));
    await setImmediate();
    await setImmediate();
    assert.equal(f.uploads[0].files.length, 2);
    assert.equal(f.uploads[0].files[1], original);
    f.plugin.stop();
});

test("AutoZipper retains the 500-file folder limit without dropping accompanying files", async () => {
    const f = fixture();
    const original = new File(["image"], "image.png");
    const folder = directory("large", Array.from({ length: 501 }, (_, index) => fileEntry(new File([], `${index}.txt`))));
    f.plugin.start();
    f.drop([
        { kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => fileEntry(original), getAsFile: () => original }
    ]);
    await setImmediate();
    await setImmediate();
    assert.equal(f.operations.length, 0);
    assert.equal(f.uploads[0].files[0], original);
    assert.equal(f.toasts.length, 1);
    f.plugin.stop();
});

function compressionFixture() {
    let active = 0;
    let peak = 0;
    class CountingStream extends AsyncZipDeflate {
        constructor(path: string) {
            super(path);
            active++;
            peak = Math.max(peak, active);
            const terminate = this.terminate;
            let alive = true;
            this.terminate = () => {
                if (alive) { active--; alive = false; }
                terminate();
            };
        }
    }
    const code = transpileModule(readFileSync("src/utils/zip.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const mocks: Record<string, unknown> = {
        "fflate": { AsyncZipDeflate: CountingStream, Zip, ZipDeflate },
        "@utils/Queue": { Queue },
        "@utils/misc": { sleep: () => setImmediate() }
    };
    const api: { createZipFile(name: string, files: Record<string, Uint8Array>, signal: AbortSignal): Promise<File> } = runInNewContext(`${code}\nexports;`, {
        exports: {}, File, DOMException, performance,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api, workers: () => ({ active, peak }) };
}

test("ZIP compression yields to the event loop, roundtrips files and uses one worker across archives", async () => {
    const f = compressionFixture();
    const data = randomFillSync(new Uint8Array(2 * 1024 * 1024));
    const files = { "large.bin": data, "文件/é.txt": new TextEncoder().encode("Nested content"), "empty.txt": new Uint8Array() };
    let finished = false;
    const first = f.api.createZipFile("first.zip", files, new AbortController().signal);
    first.then(() => { finished = true; });
    const second = f.api.createZipFile("second.zip", { "second.txt": new Uint8Array([1, 2, 3]) }, new AbortController().signal);
    await setImmediate();
    assert.equal(finished, false);
    const [firstZip, secondZip] = await Promise.all([first, second]);
    assert.deepEqual(unzipSync(new Uint8Array(await firstZip.arrayBuffer())), files);
    assert.equal(data.byteLength, 2 * 1024 * 1024, "worker transfer must not detach caller data");
    assert.deepEqual(unzipSync(new Uint8Array(await secondZip.arrayBuffer()))["second.txt"], new Uint8Array([1, 2, 3]));
    assert.deepEqual(f.workers(), { active: 0, peak: 1 });
});

test("ZIP cancellation terminates the active worker and queued cancellation leaves the queue usable", async () => {
    const f = compressionFixture();
    const active = new AbortController();
    const queued = new AbortController();
    const first = f.api.createZipFile("first.zip", { "large.bin": new Uint8Array(4 * 1024 * 1024) }, active.signal);
    const second = f.api.createZipFile("second.zip", {}, queued.signal);
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    await setImmediate();
    assert.equal(f.workers().active, 1);
    queued.abort();
    active.abort();
    await Promise.all([firstRejected, secondRejected]);
    assert.equal(f.workers().active, 0);
    const result = await f.api.createZipFile("empty.zip", {}, new AbortController().signal);
    assert.deepEqual(unzipSync(new Uint8Array(await result.arrayBuffer())), {});
});

test("small folder entries avoid worker startup and still yield during a batch", async () => {
    const f = compressionFixture();
    const data = randomFillSync(new Uint8Array(32 * 1024));
    const files = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`${index}.bin`, data]));
    let finished = false;
    const pending = f.api.createZipFile("small.zip", files, new AbortController().signal);
    pending.then(() => { finished = true; });
    await setImmediate();
    assert.equal(finished, false);
    const result = unzipSync(new Uint8Array(await (await pending).arrayBuffer()));
    assert.equal(Object.keys(result).length, 128);
    assert.deepEqual(result["127.bin"], data);
    assert.deepEqual(f.workers(), { active: 0, peak: 0 });
});

test("AutoZipper suppresses obsolete uploads after stop, restart or account change", async () => {
    for (const interruption of ["stop", "restart", "account"]) {
        const f = fixture();
        f.plugin.start();
        f.paste(new File(["payload"], "app.exe"));
        await setImmediate();
        assert.equal(f.operations.length, 1);
        if (interruption === "account") f.setUser("other");
        else {
            f.plugin.stop();
            assert.equal(f.operations[0].signal.aborted, true);
            if (interruption === "restart") f.plugin.start();
        }
        f.operations[0].resolve(new File(["archive"], "app.zip"));
        await setImmediate();
        await setImmediate();
        assert.equal(f.uploads.length, 0);
        assert.equal(f.toasts.length, 0);
        f.plugin.stop();
    }
});

test("AutoZipper retains file fallback on compression failure and the size limit", async () => {
    const f = fixture();
    f.plugin.start();
    const original = new File(["payload"], "app.exe");
    f.paste(original);
    await setImmediate();
    assert.equal(f.operations.length, 1);
    f.operations[0].reject(new Error("Compression failed"));
    await setImmediate();
    await setImmediate();
    assert.equal(f.uploads[0].files[0], original);
    assert.equal(f.toasts.length, 1);
    const oversized = new File([], "large.exe");
    Object.defineProperty(oversized, "size", { value: 101 * 1024 * 1024 });
    f.paste(oversized);
    await setImmediate();
    await setImmediate();
    assert.equal(f.operations.length, 1);
    assert.equal(f.uploads[1].files[0], oversized);
    f.plugin.stop();
});
