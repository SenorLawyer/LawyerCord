/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { unzip, unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as nativePath from "node:path";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const sources = Object.fromEntries(["extensions", "http", "crxToZip"].map(name => [name,
    transpileModule(readFileSync(`src/main/utils/${name}.ts`, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
]));

function archive(files: Record<string, Uint8Array> = { "manifest.json": Buffer.from("{}") }, level: 0 | 6 = 6) {
    return Buffer.from(zipSync(files, { level }));
}

function centralEntries(data: Buffer) {
    let cursor = data.readUInt32LE(data.length - 6);
    const entries: number[] = [];
    const count = data.readUInt16LE(data.length - 12);
    for (let index = 0; index < count; index++) {
        entries.push(cursor);
        cursor += 46 + data.readUInt16LE(cursor + 28) + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    }
    return entries;
}

function setSize(data: Buffer, entry: number, size: number, compressed = false) {
    const local = data.readUInt32LE(entry + 42);
    data.writeUInt32LE(size, entry + (compressed ? 20 : 24));
    data.writeUInt32LE(size, local + (compressed ? 18 : 22));
}

function streamed(chunks: Uint8Array[], headers: HeadersInit = {}, status = 200) {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (reads < chunks.length) controller.enqueue(chunks[reads++]);
            else controller.close();
        },
        cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    return { response: new Response(body, { headers, status }), get reads() { return reads; }, get cancelled() { return cancelled; } };
}

interface FixtureOptions {
    path?: typeof posix;
    root?: string;
    data?: Buffer;
    response?: Response;
    forbidInflation?: boolean;
    realFilesystem?: boolean;
    cached?: boolean;
    legacy?: boolean;
    writeError?: boolean;
    renameError?: boolean;
    load?: () => Promise<string>;
    request?: typeof globalThis.fetch;
    timeoutMs?: number;
}

function fixture(options: FixtureOptions = {}) {
    const path = options.path ?? posix;
    const root = options.root ?? path.resolve("extension-fixture");
    const writes: { path: string; content: Buffer; }[] = [];
    const removals: string[] = [];
    const renames: { from: string; to: string; }[] = [];
    let inflations = 0;
    let loads = 0;
    let downloads = 0;
    let signal: AbortSignal | null | undefined;
    const loadExtension = async () => { loads++; return options.load ? options.load() : "loaded"; };
    const fetch = async (_url: string, init?: RequestInit) => {
        downloads++;
        signal = init?.signal;
        if (options.request) return options.request(_url, init);
        return options.response ?? new Response(Uint8Array.from(options.data ?? archive()));
    };
    const modules: Record<string, unknown> = {
        electron: { session: { defaultSession: options.legacy ? { loadExtension } : { extensions: { loadExtension } } } },
        fflate: { unzipSync, unzip(data: Uint8Array, callback: Parameters<typeof unzip>[1]) {
            inflations++;
            if (options.forbidInflation) throw new Error("Decompression started before validation.");
            return unzip(data, callback);
        } },
        fs: { constants: { F_OK: 0 } },
        "fs/promises": options.realFilesystem ? fs : {
            access: async () => { if (!options.cached) throw Object.assign(new Error("Not installed."), { code: "ENOENT" }); },
            mkdir: async () => { },
            rm: async (file: string) => { removals.push(file); },
            rename: async (from: string, to: string) => {
                renames.push({ from, to });
                if (options.renameError) throw new Error("Rename failed.");
            },
            writeFile: async (file: string, content: Uint8Array) => {
                writes.push({ path: file, content: Buffer.from(content) });
                if (options.writeError) throw new Error("Disk full.");
            }
        },
        path, util: { promisify },
        "./constants": { DATA_DIR: root }
    };
    const globals = {
        require: (name: string) => modules[name], Buffer, process, console, fetch, AbortController, AbortSignal, clearTimeout,
        setTimeout: (callback: () => void, milliseconds: number) => {
            assert.equal(milliseconds, 30_000);
            return setTimeout(callback, options.timeoutMs ?? milliseconds);
        }
    };
    for (const name of ["http", "crxToZip"]) {
        const exports = {};
        runInNewContext(sources[name], { ...globals, exports });
        modules[`./${name}`] = exports;
    }
    const installer: { extract: (data: Buffer, outDir: string) => Promise<void>; installExt: (id: string) => Promise<string>; } = runInNewContext(
        `${sources.extensions}\n({ extract, installExt: exports.installExt });`, { ...globals, exports: {} }
    );
    return { ...installer, root, writes, removals, renames, get inflations() { return inflations; }, get loads() { return loads; }, get downloads() { return downloads; }, get signal() { return signal; } };
}

test("real ZIP extraction preserves files and directories and skips signatures on both path platforms", async () => {
    for (const path of [posix, win32]) {
        const target = path.resolve("extension-fixture", "extension");
        for (const level of [0, 6] as const) {
            const installer = fixture({ path });
            await installer.extract(archive({ "nested/file.js": Buffer.from("extension"), "empty/": Buffer.alloc(0), "_metadata/signature": Buffer.from("signature") }, level), target);
            assert.deepEqual(installer.writes, [{ path: path.join(target, "nested/file.js"), content: Buffer.from("extension") }]);
        }
    }
});

test("all paths are checked before decompression or file writes", async () => {
    for (const path of [posix, win32]) {
        for (const name of ["../escape.js", "../../extension-other/file.js", ...(path === win32 ? ["..\\escape.js", "C:\\escape.js"] : ["/escape.js"])]) {
            const installer = fixture({ path, forbidInflation: true });
            await assert.rejects(installer.extract(archive({ "first.js": Buffer.from("safe"), [name]: Buffer.from("unsafe") }), path.join(installer.root, "extension")));
            assert.equal(installer.inflations, 0);
            assert.deepEqual(installer.writes, []);
        }
    }
});

test("oversized Content-Length is rejected without reading or loading", async () => {
    const stream = streamed([archive()], { "Content-Length": String(MAX_ARCHIVE_BYTES + 1) });
    const installer = fixture({ response: stream.response });
    await assert.rejects(installer.installExt("extension"));
    assert.equal(stream.reads, 0);
    assert.equal(installer.signal?.aborted, true);
    assert.equal(installer.inflations, 0);
    assert.equal(installer.loads, 0);
});

for (const length of [undefined, "1", "not-a-number"]) {
    test(`streaming download stops at the byte limit with Content-Length ${length}`, async () => {
        const chunk = Buffer.alloc(8 * 1024 * 1024);
        const stream = streamed(Array.from({ length: 7 }, () => chunk), length === undefined ? {} : { "Content-Length": length });
        const installer = fixture({ response: stream.response });
        await assert.rejects(installer.installExt("extension"));
        assert.equal(stream.reads, 5, "the overflowing chunk must stop further reads");
        assert.equal(stream.cancelled, true);
        assert.equal(installer.signal?.aborted, true);
        assert.equal(installer.inflations, 0);
        assert.equal(installer.loads, 0);
    });
}

test("unsuccessful HTTP responses are rejected without buffering the error body", async () => {
    const stream = streamed([Buffer.alloc(1024)], {}, 503);
    const installer = fixture({ response: stream.response });
    await assert.rejects(installer.installExt("extension"));
    assert.equal(stream.reads, 0);
    assert.equal(installer.signal?.aborted, true);
    assert.equal(installer.loads, 0);
});

test("fragmented download and both Electron APIs preserve the awaited load result", async () => {
    for (const legacy of [false, true]) {
        const data = archive();
        const stream = streamed(Array.from(data, byte => Uint8Array.of(byte)));
        const entered = Promise.withResolvers<void>();
        const load = Promise.withResolvers<string>();
        const installer = fixture({ response: stream.response, legacy, load: () => { entered.resolve(); return load.promise; } });
        let settled = false;
        const pending = installer.installExt("extension").then(value => { settled = true; return value; });
        await entered.promise;
        assert.equal(installer.loads, 1);
        assert.equal(settled, false);
        load.resolve("loaded extension");
        assert.equal(await pending, "loaded extension");
        assert.equal(installer.downloads, 1);
    }
});

test("real fetch cancels oversized and stalled bodies and preserves HTTP errors", { timeout: 10_000 }, async () => {
    const server = createServer((request, response) => {
        response.writeHead(request.url === "/error" ? 503 : 200);
        response.flushHeaders();
        if (request.url === "/oversize") response.end(Buffer.alloc(MAX_ARCHIVE_BYTES + 1024 * 1024));
        else if (request.url === "/success") response.end(archive());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        for (const route of ["success", "oversize", "error", "stall"]) {
            const installer = fixture({
                request: (_url, init) => globalThis.fetch(`http://127.0.0.1:${address.port}/${route}`, init),
                timeoutMs: route === "stall" ? 100 : 5000
            });
            if (route === "success") {
                assert.equal(await installer.installExt("extension"), "loaded");
            } else {
                await assert.rejects(installer.installExt("extension"), route === "error" ? /status 503/ : route === "oversize" ? /download size limit/ : /abort/i);
                assert.equal(installer.signal?.aborted, true);
                assert.equal(installer.inflations, 0);
                assert.equal(installer.loads, 0);
                assert.deepEqual(installer.writes, []);
            }
        }
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
    }
});

test("cached extensions are loaded without another download", async () => {
    const installer = fixture({ cached: true });
    assert.equal(await installer.installExt("extension"), "loaded");
    assert.equal(installer.downloads, 0);
});

const malformed: [string, (data: Buffer) => Buffer][] = [
    ["expanded entry limit", data => { setSize(data, centralEntries(data)[1], MAX_EXPANDED_BYTES + 1); return data; }],
    ["cumulative expansion limit", data => { for (const entry of centralEntries(data)) setSize(data, entry, MAX_EXPANDED_BYTES / 2 + 1); return data; }],
    ["out of bounds central directory", data => { data.writeUInt32LE(data.length, data.length - 6); return data; }],
    ["entry count limit", () => archive(Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => [`${index}.js`, Buffer.alloc(0)])))],
    ["truncated directory", data => data.subarray(0, data.length - 10)]
];

for (const [label, corrupt] of malformed) {
    test(`ZIP preflight rejects ${label} before any decompression or loading`, async () => {
        const data = corrupt(archive({ "first.js": Buffer.from("first"), "manifest.json": Buffer.from("{}") }));
        const installer = fixture({ data, forbidInflation: true });
        await assert.rejects(installer.installExt("extension"));
        assert.equal(installer.inflations, 0);
        assert.equal(installer.loads, 0);
        assert.deepEqual(installer.writes, []);
    });
}

for (const declaredSize of [128 * 1024]) {
    test(`actual inflated output must match declared size ${declaredSize}`, async () => {
        const data = archive({ "manifest.json": Buffer.alloc(64 * 1024, 65) });
        setSize(data, centralEntries(data)[0], declaredSize);
        const installer = fixture({ data });
        await assert.rejects(installer.installExt("extension"));
        assert.equal(installer.loads, 0);
        assert.deepEqual(installer.writes, []);
        assert.equal(installer.removals.length, 2);
        assert.ok(installer.removals.every(path => path.endsWith("extension.tmp")));
    });
}

test("write failures clean extraction output and never load the extension", async () => {
    const installer = fixture({ writeError: true });
    await assert.rejects(installer.installExt("extension"), /Disk full/);
    assert.equal(installer.removals.length, 2);
    assert.ok(installer.removals.every(path => path.endsWith("extension.tmp")));
    assert.equal(installer.loads, 0);
});

test("extensions are staged before becoming cached and failed promotion is cleaned", async () => {
    const installer = fixture();
    assert.equal(await installer.installExt("extension"), "loaded");
    assert.ok(installer.writes.every(write => write.path.includes("extension.tmp")));
    assert.deepEqual(installer.renames, [{
        from: posix.resolve("extension-fixture", "ExtensionCache/extension.tmp"),
        to: posix.resolve("extension-fixture", "ExtensionCache/extension")
    }]);

    const failed = fixture({ renameError: true });
    await assert.rejects(failed.installExt("extension"), /Rename failed/);
    assert.equal(failed.loads, 0);
    assert.ok(failed.removals.some(path => path.endsWith("extension.tmp")));
});

test("real filesystem extraction and malformed output cleanup stay within a temporary directory", async () => {
    const root = await fs.mkdtemp(nativePath.join(tmpdir(), "lawyercord-extension-test-"));
    try {
        const installer = fixture({ root, path: nativePath, realFilesystem: true, data: archive({ "manifest.json": Buffer.from("{}"), "nested/file.js": Buffer.from("valid") }) });
        assert.equal(await installer.installExt("extension"), "loaded");
        assert.equal(await fs.readFile(nativePath.join(root, "ExtensionCache/extension/nested/file.js"), "utf8"), "valid");
        const broken = archive({ "first.js": Buffer.from("valid"), "broken.js": Buffer.alloc(1024, 65) });
        setSize(broken, centralEntries(broken)[1], 2 * 1024);
        const failed = fixture({ root, path: nativePath, realFilesystem: true, data: broken });
        await assert.rejects(failed.installExt("broken"));
        await assert.rejects(fs.access(nativePath.join(root, "ExtensionCache/broken")));
        assert.equal(failed.loads, 0);
        assert.equal(await fs.readFile(nativePath.join(root, "ExtensionCache/extension/nested/file.js"), "utf8"), "valid");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
