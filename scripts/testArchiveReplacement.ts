/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

const source = fs.readFileSync(resolve("src/main/updater/archiveReplacement.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;
const restartArguments = ["argument with spaces", 'embedded"quote', "C:\\trailing\\", "", "Français 漢字"];
const nativeRequire = createRequire(import.meta.url);

async function waitFor(check: () => boolean, label: string) {
    const deadline = Date.now() + 15_000;
    while (!check()) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await sleep(50);
    }
}

async function fixture(runtime = process.execPath, unrelatedOutput = false, failStateWrite = false) {
    const directory = await mkdtemp(join(tmpdir(), "lawyercord-archive-é漢字-"));
    const destination = join(directory, "lawyercord.asar");
    const ready = join(directory, "parent-ready.json");
    const restarted = join(directory, "restarted.json");
    const marker = join(directory, "restart.cjs");
    const parentScript = join(directory, "parent.cjs");
    const children: ChildProcess[] = [];
    await writeFile(destination, "Old complete archive");
    await writeFile(marker, `require('fs').writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), electron: process.env.ELECTRON_RUN_AS_NODE, nodeOptions: process.env.NODE_OPTIONS }));`);
    await writeFile(parentScript, `
const fs = require('fs');
const moduleFixture = { exports: {} };
const proxyProcess = Object.create(process);
Object.defineProperty(proxyProcess, 'execPath', { value: ${JSON.stringify(runtime)} });
Object.defineProperty(proxyProcess, 'argv', { value: [process.execPath, ${JSON.stringify(marker)}, ${JSON.stringify(restarted)}, '--squirrel-firstrun', ...${JSON.stringify(restartArguments)}] });
const fixtureRequire = id => {
    if (id === 'original-fs' && ${failStateWrite}) return { ...fs, writeFileSync: (file, ...args) => {
        if (file === ${JSON.stringify(`${destination}.update.json`)}) {
            const stage = fs.readdirSync(${JSON.stringify(directory)}).find(name => name.startsWith('lawyercord.asar.update-'));
            fs.copyFileSync(require('path').join(${JSON.stringify(directory)}, stage, 'ready.json'), ${JSON.stringify(join(directory, "failed-worker.json"))});
            throw new Error('Injected state persistence failure');
        }
        return fs.writeFileSync(file, ...args);
    } };
    if (id === 'original-fs') return fs;
    if (id === 'electron') return { app: { quit: () => process.exit(0) } };
    if (id === '../settings') return { NativeSettings: { plain: { native: true } }, RendererSettings: { plain: { autoUpdate: false } } };
    if (id === 'child_process' && ${unrelatedOutput}) return { spawn: (_executable, _args, options) => require('child_process').spawn(process.execPath, ['-e', "console.log('Starting app'); setTimeout(() => process.exit(0), 200)"], options) };
    if (id === 'child_process') return { ...require('child_process'), spawn: (executable, args, options) => {
        const child = require('child_process').spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.on('data', data => process.stderr.write(data));
        child.once('exit', () => {
            const staged = fs.readdirSync(${JSON.stringify(directory)}).find(name => name.startsWith('lawyercord.asar.update-'));
            if (!staged) return;
            const result = require('path').join(${JSON.stringify(directory)}, staged, 'result.json');
            if (fs.existsSync(result)) process.stderr.write(fs.readFileSync(result));
        });
        return child;
    } };
    return require(id);
};
new Function('require', 'module', 'exports', 'process', ${JSON.stringify(compiled)})(fixtureRequire, moduleFixture, moduleFixture.exports, proxyProcess);
const api = moduleFixture.exports;
api.replaceVerifiedArchive(${JSON.stringify(destination)}, Buffer.from('New complete archive')).then(result => {
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(result));
    process.stdin.on('data', command => {
        if (String(command).trim() === 'restart') api.restartStagedUpdate().catch(error => { console.error(error); process.exit(1); });
        else process.exit(0);
    });
}).catch(error => { console.error(error); process.exit(1); });
`);
    return {
        directory, destination, ready, restarted,
        async start() {
            const child = spawn(process.execPath, [parentScript], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
            children.push(child);
            let stderr = "";
            child.stderr?.on("data", bytes => { stderr += String(bytes); });
            await waitFor(() => {
                assert.equal(child.exitCode, null, `Parent failed: ${stderr}`);
                return fs.existsSync(ready);
            }, "helper startup handshake");
            const state = JSON.parse(await readFile(`${destination}.update.json`, "utf8")) as { directory: string; workerPid: number; };
            return { child, state };
        },
        async lock(allowWrites = false) {
            assert.equal(process.platform, "win32");
            const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$handle = [IO.File]::Open($env:LAWYERCORD_LOCK_FIXTURE, 'Open', 'Read', $env:LAWYERCORD_LOCK_SHARING); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $handle.Dispose()"], {
                env: { ...process.env, LAWYERCORD_LOCK_FIXTURE: destination, LAWYERCORD_LOCK_SHARING: allowWrites ? "ReadWrite" : "Read" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
            });
            children.push(child);
            assert.ok(child.stdout);
            const [data] = await once(child.stdout, "data");
            assert.match(String(data), /locked/);
            return child;
        },
        async cleanup() {
            for (const child of children) if (child.exitCode === null) child.kill();
            if (fs.existsSync(`${destination}.update.json`)) {
                const state = JSON.parse(await readFile(`${destination}.update.json`, "utf8")) as { workerPid: number; };
                try { process.kill(state.workerPid); } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
                }
            }
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    };
}

test("Windows locked archive stages, survives parent exit, promotes safely and restarts with chosen arguments", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture();
    try {
        const lock = await f.lock();
        const baseline = join(f.directory, "baseline.asar");
        await writeFile(baseline, "New complete archive");
        assert.throws(() => fs.renameSync(baseline, f.destination), { code: "EPERM" });
        const { child, state } = await f.start();
        assert.deepEqual(JSON.parse(await readFile(f.ready, "utf8")), { staged: true });
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "settings-backup.json"), "utf8")), { renderer: { autoUpdate: false }, native: { native: true } });
        child.stdin?.write("restart\n");
        await once(child, "exit");
        await sleep(400);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        process.kill(state.workerPid, 0);
        assert.equal(fs.existsSync(join(state.directory, "result.json")), false);
        lock.stdin?.write("release\n");
        await once(lock, "exit");
        await waitFor(() => fs.existsSync(f.restarted), "replacement and restart");
        assert.equal(await readFile(f.destination, "utf8"), "New complete archive");
        assert.equal(await readFile(join(state.directory, "previous.asar"), "utf8"), "Old complete archive");
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")), { ok: true });
        assert.equal(fs.existsSync(`${f.destination}.update.json`), false);
        assert.deepEqual(JSON.parse(await readFile(f.restarted, "utf8")), { args: restartArguments });
    } finally { await f.cleanup(); }
});

test("Tampered staged archive is rejected after parent exits and keeps the installed archive", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture();
    try {
        const { child, state } = await f.start();
        await writeFile(join(state.directory, "archive.asar"), "Tampered archive");
        child.stdin?.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "checksum rejection");
        const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
        assert.equal(result.ok, false);
        assert.match(result.error, /changed before installation/);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        assert.equal(fs.existsSync(f.restarted), false);
    } finally { await f.cleanup(); }
});

test("Unrelated child output cannot acknowledge a helper that never started", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, true);
    try {
        await assert.rejects(f.start(), /Parent failed/);
        assert.equal(fs.existsSync(f.ready), false);
        assert.equal(fs.existsSync(`${f.destination}.update.json`), false);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
    } finally { await f.cleanup(); }
});

test("Failure saving pending state stops the Windows helper and preserves the installed archive", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, false, true);
    try {
        await assert.rejects(f.start(), /Injected state persistence failure/);
        const worker = JSON.parse(await readFile(join(f.directory, "failed-worker.json"), "utf8")) as { pid: number; };
        await waitFor(() => {
            try { process.kill(worker.pid, 0); return false; }
            catch (error) {
                assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
                return true;
            }
        }, "failed update helper exit");
        assert.equal(fs.existsSync(`${f.destination}.update.json`), false);
        assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith("lawyercord.asar.update-")), false);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
    } finally { await f.cleanup(); }
});

test("An archive installed while the helper waits for a Windows lock is preserved", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture();
    try {
        const lock = await f.lock(true);
        const { child, state } = await f.start();
        child.stdin?.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "previous.asar")), "helper entering promotion");
        await writeFile(f.destination, "Installed by another installer");
        lock.stdin?.write("release\n");
        await once(lock, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "intervening installation detection");
        const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
        assert.equal(result.ok, false);
        assert.match(result.error, /Another installer/);
        assert.equal(await readFile(f.destination, "utf8"), "Installed by another installer");
    } finally { await f.cleanup(); }
});

const electronRuntime = process.env.LAWYERCORD_TEST_ELECTRON;
test("Windows helper applies an update for the actual Discord executable without launching Discord", { skip: !electronRuntime || process.platform !== "win32" }, async () => {
    assert.ok(electronRuntime);
    const f = await fixture(resolve(electronRuntime));
    try {
        const { child, state } = await f.start();
        child.stdin?.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "Electron helper promotion");
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")), { ok: true });
        assert.equal(await readFile(f.destination, "utf8"), "New complete archive");
    } finally { await f.cleanup(); }
});

test("Unix replacement keeps the old open inode, backs up files and restarts without a helper", { skip: process.platform === "win32" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "lawyercord-unix-archive-"));
    const destination = join(directory, "lawyercord.asar");
    await writeFile(destination, "Old complete archive");
    const handle = fs.openSync(destination, "r");
    let relaunched = false;
    let quit = false;
    const modules: Record<string, unknown> = {
        "original-fs": fs,
        "child_process": { spawn: () => assert.fail("Unix replacement must not launch a helper") },
        "electron": { app: { relaunch: () => { relaunched = true; }, quit: () => { quit = true; } } },
        "../settings": { NativeSettings: { plain: { native: true } }, RendererSettings: { plain: { autoUpdate: false } } }
    };
    const moduleFixture = { exports: {} };
    runInNewContext(compiled, { module: moduleFixture, exports: moduleFixture.exports, require: (id: string) => modules[id] ?? nativeRequire(id), process, Buffer, setTimeout });
    const api = moduleFixture.exports as {
        replaceVerifiedArchive(destination: string, data: Buffer): Promise<{ staged: boolean; }>;
        restartStagedUpdate(): Promise<boolean>;
    };
    try {
        assert.equal(await api.restartStagedUpdate(), false);
        assert.equal((await api.replaceVerifiedArchive(destination, Buffer.from("New complete archive"))).staged, false);
        assert.equal(fs.readFileSync(handle, "utf8"), "Old complete archive");
        assert.equal(await readFile(destination, "utf8"), "New complete archive");
        const backup = fs.readdirSync(directory).find(name => name.startsWith("lawyercord.asar.update-"));
        assert.ok(backup);
        assert.equal(await readFile(join(directory, backup, "previous.asar"), "utf8"), "Old complete archive");
        assert.deepEqual(JSON.parse(await readFile(join(directory, backup, "settings-backup.json"), "utf8")), { renderer: { autoUpdate: false }, native: { native: true } });
        assert.equal(fs.existsSync(`${destination}.update.json`), false);
        await assert.rejects(api.replaceVerifiedArchive(destination, Buffer.from("Another archive")), /already downloaded/);
        assert.equal(await api.restartStagedUpdate(), true);
        assert.equal(relaunched, true);
        await waitFor(() => quit, "application quit");
    } finally {
        fs.closeSync(handle);
        await rm(directory, { recursive: true, force: true });
    }
});
