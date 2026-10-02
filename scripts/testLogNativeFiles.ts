/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

class Sender extends EventEmitter {
    constructor(public id: number) { super(); }
    destroyed = false;
    isDestroyed() { return this.destroyed; }
}
interface Event { sender: Sender; }
interface Api {
    startNativeLogExport(event: Event, filename: string): Promise<string>;
    writeNativeLogChunk(event: Event, id: string, chunk: string): Promise<void>;
    finishNativeLogExport(event: Event, id: string): Promise<void>;
    cancelNativeLogExport(event: Event, id: string): Promise<void>;
    cancelNativeLogExports(event: Event): Promise<void>;
    startNativeLogImport(event: Event): Promise<string>;
    readNativeLogChunk(event: Event, id: string): Promise<string | null>;
    closeNativeLogImport(event: Event, id: string): Promise<void>;
    closeNativeLogImports(event: Event): Promise<void>;
}

async function fixture(t: { after(fn: () => Promise<void>): void; }) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "lawyercord-native-logs-"));
    const target = path.join(root, "logs.json");
    const event = { sender: new Sender(1) };
    const other = { sender: new Sender(2) };
    let failWrite = false;
    let failRename = false;
    let failClose = false;
    let failUnlink = false;
    let pauseRead: Promise<void> | undefined;
    let dialogWork: Promise<void> | undefined;
    const handles: fs.FileHandle[] = [];
    const mocks: Record<string, unknown> = {
        "node:crypto": { randomUUID }, "node:fs": fsSync, "node:path": path,
        "@utils/Logger": { Logger: class { warn() {} } },
        "node:fs/promises": { ...fs,
            open: async (name: string, flags: string) => {
                const file = await fs.open(name, flags);
                handles.push(file);
                const write = file.writeFile.bind(file);
                const read = file.read.bind(file);
                const close = file.close.bind(file);
                file.close = async () => {
                    await close();
                    if (failClose) throw new Error("Injected private close path.");
                };
                file.writeFile = async (...args: Parameters<typeof write>) => {
                    if (failWrite) throw new Error("Injected private disk path.");
                    return write(...args);
                };
                file.read = async (...args: Parameters<typeof read>) => {
                    if (pauseRead) await pauseRead;
                    return read(...args);
                };
                return file;
            },
            rename: async (from: string, to: string) => {
                if (failRename) throw new Error("Injected private rename path.");
                await fs.rename(from, to);
            },
            unlink: async (name: string) => {
                if (failUnlink) throw new Error("Injected private unlink path.");
                await fs.unlink(name);
            }
        },
        electron: { dialog: {
            showSaveDialog: async () => { await dialogWork; return { filePath: target, canceled: false }; },
            showOpenDialog: async () => { await dialogWork; return { filePaths: [target] }; }
        } }
    };
    function load(name: string) {
        const source = process.env.AUDIT_LOG_NATIVE_ROOT ? path.join(process.env.AUDIT_LOG_NATIVE_ROOT, `${name}.ts`) : `src/equicordplugins/messageLoggerEnhanced/native/${name}.ts`;
        const { outputText } = transpileModule(fsSync.readFileSync(source, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        });
        return runInNewContext(`${outputText}\nexports;`, {
            exports: {}, Buffer, TextDecoder, setTimeout, clearTimeout, console: { error() {} },
            require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
        });
    }
    const api = { ...load("export"), ...load("import") } as Api;
    t.after(async () => {
        failClose = false;
        failUnlink = false;
        if (api.cancelNativeLogExports) await api.cancelNativeLogExports(event);
        if (api.closeNativeLogImports) await api.closeNativeLogImports(event);
        for (const handle of handles) await handle.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { api, root, target, event, other, handles,
        writeFailure: () => failWrite = true, renameFailure: () => failRename = true,
        cleanupFailure: () => { failClose = true; failUnlink = true; },
        pauseRead: (promise: Promise<void>) => pauseRead = promise,
        pauseDialog: (promise: Promise<void>) => dialogWork = promise };
}

test("Native log exports preserve the destination until all chunks finish", async t => {
    const f = await fixture(t);
    await fs.writeFile(f.target, "original");
    const id = await f.api.startNativeLogExport(f.event, "logs.json");
    await f.api.writeNativeLogChunk(f.event, id, "replacement");
    assert.equal(await fs.readFile(f.target, "utf8"), "original");
    await f.api.finishNativeLogExport(f.event, id);
    assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
    assert.deepEqual(await fs.readdir(f.root), ["logs.json"]);
    assert.equal(f.handles[0].fd, -1);
});

test("Write and rename failures settle, preserve originals, remove temporary files and scrub errors", async t => {
    for (const failure of ["writeFailure", "renameFailure"] as const) {
        const f = await fixture(t);
        await fs.writeFile(f.target, "original");
        const id = await f.api.startNativeLogExport(f.event, "logs.json");
        f[failure]();
        await assert.rejects(async () => {
            await f.api.writeNativeLogChunk(f.event, id, "replacement");
            await f.api.finishNativeLogExport(f.event, id);
        }, /Could not (write|finish) the log export\./);
        assert.equal(await fs.readFile(f.target, "utf8"), "original");
        assert.deepEqual(await fs.readdir(f.root), ["logs.json"]);
        assert.equal(f.handles[0].fd, -1);
    }
});

test("Export handles reject another sender and a second active export", async t => {
    const f = await fixture(t);
    const id = await f.api.startNativeLogExport(f.event, "logs.json");
    await assert.rejects(f.api.writeNativeLogChunk(f.other, id, "wrong sender"), /unavailable/);
    await assert.rejects(f.api.finishNativeLogExport(f.other, id), /unavailable/);
    await assert.rejects(f.api.startNativeLogExport(f.event, "logs.json"), /already open/);
    await f.api.cancelNativeLogExport(f.other, id);
    await f.api.writeNativeLogChunk(f.event, id, "valid");
    await f.api.cancelNativeLogExport(f.event, id);
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
});

test("Native export cleanup failures never replace the scrubbed write error with a filesystem path", async t => {
    const f = await fixture(t);
    const id = await f.api.startNativeLogExport(f.event, "logs.json");
    f.writeFailure();
    f.cleanupFailure();
    await assert.rejects(f.api.writeNativeLogChunk(f.event, id, "data"), /^Error: Could not write the log export\.$/);
    assert.equal(f.handles[0].fd, -1);
});

test("Cancellation during native file dialogs prevents late handle creation", async t => {
    const f = await fixture(t);
    let release = () => {};
    f.pauseDialog(new Promise<void>(resolve => release = resolve));
    const exporting = assert.rejects(f.api.startNativeLogExport(f.event, "logs.json"));
    const importing = assert.rejects(f.api.startNativeLogImport(f.event));
    await f.api.cancelNativeLogExports(f.event);
    await f.api.closeNativeLogImports(f.event);
    release();
    await Promise.all([exporting, importing]);
    assert.equal(f.handles.length, 0);
});

test("A renderer crash during file dialogs prevents late handle creation", async t => {
    const f = await fixture(t);
    let release = () => {};
    f.pauseDialog(new Promise<void>(resolve => release = resolve));
    const exporting = assert.rejects(f.api.startNativeLogExport(f.event, "logs.json"));
    const importing = assert.rejects(f.api.startNativeLogImport(f.event));
    f.event.sender.emit("render-process-gone");
    release();
    await Promise.all([exporting, importing]);
    assert.equal(f.handles.length, 0);
    assert.equal(f.event.sender.listenerCount("render-process-gone"), 0);
});

test("Native imports preserve split UTF-8, reject concurrent reads and close on EOF", async t => {
    const f = await fixture(t);
    const input = "x".repeat(65535) + "🦊tail";
    await fs.writeFile(f.target, input);
    const id = await f.api.startNativeLogImport(f.event);
    await assert.rejects(f.api.readNativeLogChunk(f.other, id), /unavailable/);
    let release = () => {};
    f.pauseRead(new Promise<void>(resolve => release = resolve));
    const first = f.api.readNativeLogChunk(f.event, id);
    await assert.rejects(f.api.readNativeLogChunk(f.event, id), /unavailable/);
    release();
    let output = await first;
    for (;;) {
        const chunk = await f.api.readNativeLogChunk(f.event, id);
        if (chunk === null) break;
        output += chunk;
    }
    assert.equal(output, input);
    assert.equal(f.handles[0].fd, -1);
    assert.equal(f.event.sender.listenerCount("destroyed"), 0);
});

test("Destroying a renderer closes its import and discards its incomplete export", async t => {
    const f = await fixture(t);
    await fs.writeFile(f.target, "original");
    const imported = await f.api.startNativeLogImport(f.event);
    const exported = await f.api.startNativeLogExport(f.event, "logs.json");
    f.event.sender.destroyed = true;
    f.event.sender.emit("destroyed");
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(f.api.readNativeLogChunk(f.event, imported), /unavailable/);
    await assert.rejects(f.api.writeNativeLogChunk(f.event, exported, "late"));
    assert.equal(await fs.readFile(f.target, "utf8"), "original");
    assert.ok(f.handles.every(handle => handle.fd === -1));
});
