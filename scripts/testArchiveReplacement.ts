/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
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

async function waitFor(check: () => boolean, label: string, diagnostics: () => string = () => "") {
    const deadline = Date.now() + 90_000;
    while (!check()) {
        if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}. ${diagnostics()}`);
        await sleep(50);
    }
}

async function fixture(runtime = process.execPath, unrelatedOutput = false, failStateWrite = false, pauseCompilation = false, shortPath = false) {
    let directory = await mkdtemp(join(tmpdir(), "lawyercord-archive-é漢字-"));
    if (shortPath) {
        const alias = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:LAWYERCORD_ALIAS_FIXTURE).ShortPath"], { env: { ...process.env, LAWYERCORD_ALIAS_FIXTURE: directory }, encoding: "utf8", windowsHide: true });
        assert.equal(alias.status, 0, alias.stderr);
        assert.notEqual(alias.stdout.trim().toLowerCase(), fs.realpathSync.native(directory).toLowerCase(), "Fixture volume must support 8.3 paths");
        directory = alias.stdout.trim();
    }
    const destination = join(directory, "lawyercord.asar");
    const ready = join(directory, "parent-ready.json");
    const restarted = join(directory, "restarted.json");
    const marker = join(directory, "restart.cjs");
    const parentScript = join(directory, "parent.cjs");
    const children: ChildProcess[] = [];
    const compilationGate = "    [IO.File]::WriteAllText((Join-Path $directory 'compiling'), 'started')\n    while (-not [IO.File]::Exists((Join-Path $directory 'compile-release'))) { if (-not [IO.Directory]::Exists($directory)) { throw 'Compilation fixture was cancelled.' }; Start-Sleep -Milliseconds 50 }\n    Add-Type -TypeDefinition";
    await writeFile(destination, "Old complete archive");
    await writeFile(marker, `require('fs').writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), electron: process.env.ELECTRON_RUN_AS_NODE, nodeOptions: process.env.NODE_OPTIONS }));`);
    await writeFile(parentScript, `
const fs = require('fs');
const moduleFixture = { exports: {} };
const proxyProcess = Object.create(process);
Object.defineProperty(proxyProcess, 'execPath', { value: ${JSON.stringify(runtime)} });
Object.defineProperty(proxyProcess, 'argv', { value: [process.execPath, ${JSON.stringify(marker)}, ${JSON.stringify(restarted)}, '--squirrel-firstrun', ...${JSON.stringify(restartArguments)}] });
const fixtureRequire = id => {
    if (id === '@utils/Logger') return { Logger: class { warn() {} } };
    if (id === 'original-fs' && ${failStateWrite}) return { ...fs, writeFileSync: (file, ...args) => {
        if (file === ${JSON.stringify(`${destination}.update.json`)}) {
            const stage = fs.readdirSync(${JSON.stringify(directory)}).find(name => name.startsWith('lawyercord.asar.update-'));
            fs.copyFileSync(require('path').join(${JSON.stringify(directory)}, stage, 'ready.json'), ${JSON.stringify(join(directory, "failed-worker.json"))});
            throw new Error('Injected state persistence failure');
        }
        return fs.writeFileSync(file, ...args);
    } };
    if (id === 'original-fs') return { ...fs, writeFileSync: (file, data, ...args) => {
        if (${pauseCompilation} && String(file).endsWith('apply.ps1')) data = String(data).replace('    Add-Type -TypeDefinition', ${JSON.stringify(compilationGate)});
        if (${shortPath} && String(file).endsWith('apply.ps1')) data = String(data).replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'worker-directory.txt'), $PSScriptRoot)");
        return fs.writeFileSync(file, data, ...args);
    }, promises: { ...fs.promises, rm: async (file, options) => {
        if (String(file).startsWith(${JSON.stringify(`${destination}.update-`)})) {
            for (const name of ['ready.json', 'result.json', 'worker.stdout.log', 'worker.stderr.log']) {
                const diagnostic = require('path').join(file, name);
                if (fs.existsSync(diagnostic)) console.error('Before staging cleanup', name, fs.readFileSync(diagnostic, 'utf8').slice(-4000));
            }
        }
        return fs.promises.rm(file, options);
    } } };
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
    function launch() {
        const child = spawn(process.execPath, [parentScript], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
        children.push(child);
        let stderr = "";
        child.stderr.on("data", bytes => { stderr += String(bytes); });
        return { child, get stderr() { return stderr; } };
    }
    function diagnostics() {
        const snapshots = fs.readdirSync(directory).filter(name => name.startsWith("lawyercord.asar.update-")).map(name => {
            const stage = join(directory, name);
            const files = Object.fromEntries(["ready.json", "result.json", "worker.stdout.log", "worker.stderr.log"].filter(file => fs.existsSync(join(stage, file))).map(file => [file, fs.readFileSync(join(stage, file), "utf8").slice(-4000)]));
            return { name, files, staged: fs.existsSync(join(stage, "archive.asar")), backup: fs.existsSync(join(stage, "previous.asar")) };
        });
        return JSON.stringify(snapshots);
    }
    return {
        directory, destination, ready, restarted, diagnostics,
        async start() {
            const parent = launch();
            const { child } = parent;
            await waitFor(() => {
                assert.equal(child.exitCode, null, `Parent failed: ${parent.stderr}. ${diagnostics()}`);
                return fs.existsSync(ready);
            }, "helper startup handshake", diagnostics);
            const state = JSON.parse(await readFile(`${destination}.update.json`, "utf8")) as { directory: string; workerPid: number; };
            return { child, state };
        },
        async expectFailure(message: RegExp) {
            const parent = launch();
            const [code] = await once(parent.child, "close", { signal: AbortSignal.timeout(90_000) });
            assert.equal(code, 1, `Expected update failure: ${parent.stderr}`);
            assert.match(parent.stderr, message);
            assert.equal(fs.existsSync(ready), false);
        },
        async lock(allowWrites = false) {
            assert.equal(process.platform, "win32");
            const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$handle = [IO.File]::Open($env:LAWYERCORD_LOCK_FIXTURE, 'Open', 'Read', $env:LAWYERCORD_LOCK_SHARING); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $handle.Dispose()"], {
                env: { ...process.env, LAWYERCORD_LOCK_FIXTURE: destination, LAWYERCORD_LOCK_SHARING: allowWrites ? "ReadWrite" : "Read" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
            });
            children.push(child);
            assert.ok(child.stdout);
            const [data] = await once(child.stdout, "data", { signal: AbortSignal.timeout(90_000) });
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
        await waitFor(() => fs.existsSync(f.restarted), "replacement and restart", f.diagnostics);
        assert.equal(await readFile(f.destination, "utf8"), "New complete archive");
        assert.equal(await readFile(join(state.directory, "previous.asar"), "utf8"), "Old complete archive");
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")), { ok: true });
        assert.equal(fs.existsSync(`${f.destination}.update.json`), false);
        assert.deepEqual(JSON.parse(await readFile(f.restarted, "utf8")), { args: restartArguments });
    } finally { await f.cleanup(); }
});

test("Windows helper accepts its own acknowledgement through an 8.3 directory alias", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, false, false, false, true);
    try {
        const { child, state } = await f.start();
        const workerDirectory = await readFile(join(state.directory, "worker-directory.txt"), "utf8");
        assert.notEqual(workerDirectory.toLowerCase(), state.directory.toLowerCase());
        child.stdin.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "8.3 alias promotion", f.diagnostics);
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")), { ok: true }, JSON.stringify({ acknowledgedDirectory: state.directory, workerDirectory }));
        assert.equal(await readFile(f.destination, "utf8"), "New complete archive");
    } finally { await f.cleanup(); }
});

test("Windows helper acknowledges the verified stage before deferred native compilation", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, false, false, true);
    try {
        const { child, state } = await f.start();
        assert.equal(fs.existsSync(join(state.directory, "compiling")), false);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        child.stdin.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "compiling")), "deferred native compilation", f.diagnostics);
        assert.equal(fs.existsSync(join(state.directory, "result.json")), false);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        await writeFile(join(state.directory, "compile-release"), "continue");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "promotion after compilation", f.diagnostics);
        assert.deepEqual(JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")), { ok: true });
        assert.equal(await readFile(f.destination, "utf8"), "New complete archive");
    } finally { await f.cleanup(); }
});

test("a stage changed during deferred compilation is checked again before promotion", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, false, false, true);
    try {
        const { child, state } = await f.start();
        child.stdin.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "compiling")), "deferred native compilation", f.diagnostics);
        await writeFile(join(state.directory, "archive.asar"), "Changed during compilation");
        await writeFile(join(state.directory, "compile-release"), "continue");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "late checksum rejection", f.diagnostics);
        const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
        assert.equal(result.ok, false);
        assert.match(result.error, /changed before installation/);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
    } finally { await f.cleanup(); }
});

test("Tampered staged archive is rejected after parent exits and keeps the installed archive", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture();
    try {
        const { child, state } = await f.start();
        await writeFile(join(state.directory, "archive.asar"), "Tampered archive");
        child.stdin?.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "checksum rejection", f.diagnostics);
        const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
        assert.equal(result.ok, false);
        assert.match(result.error, /changed before installation/);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
        assert.equal(fs.existsSync(f.restarted), false);
    } finally { await f.cleanup(); }
});

test("a cancelled or unacknowledged Windows helper cannot promote its staged archive", { skip: process.platform !== "win32" }, async () => {
    for (const mismatched of [false, true]) {
        const f = await fixture();
        try {
            const { child, state } = await f.start();
            if (mismatched) await writeFile(`${f.destination}.update.json`, JSON.stringify({ ...state, directory: `${state.directory}-other` }));
            else await rm(`${f.destination}.update.json`);
            child.stdin?.write("quit\n");
            await once(child, "exit");
            await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "cancelled update rejection");
            const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
            assert.equal(result.ok, false);
            assert.match(result.error, /cancelled before installation/);
            assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
            assert.equal(fs.existsSync(f.restarted), false);
        } finally { await f.cleanup(); }
    }
});

test("Unrelated child output cannot acknowledge a helper that never started", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, true);
    try {
        await f.expectFailure(/The update helper could not start/);
        assert.equal(fs.existsSync(f.ready), false);
        assert.equal(fs.existsSync(`${f.destination}.update.json`), false);
        assert.equal(await readFile(f.destination, "utf8"), "Old complete archive");
    } finally { await f.cleanup(); }
});

test("Failure saving pending state stops the Windows helper and preserves the installed archive", { skip: process.platform !== "win32" }, async () => {
    const f = await fixture(process.execPath, false, true);
    try {
        await f.expectFailure(/Injected state persistence failure/);
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
        await waitFor(() => fs.existsSync(join(state.directory, "previous.asar")), "helper entering promotion", f.diagnostics);
        await writeFile(f.destination, "Installed by another installer");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "intervening installation detection while locked", f.diagnostics);
        lock.stdin?.write("release\n");
        await once(lock, "exit");
        const result = JSON.parse(await readFile(join(state.directory, "result.json"), "utf8")) as { ok: boolean; error: string; };
        assert.equal(result.ok, false);
        assert.match(result.error, /Another installer/);
        assert.equal(await readFile(f.destination, "utf8"), "Installed by another installer");
    } finally { await f.cleanup(); }
});

test("Completed backup retention keeps the newest backup and preserves active, pending, failed and unknown directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lawyercord-retention-"));
    const destination = join(directory, "lawyercord.asar");
    await writeFile(destination, "Installed archive");
    function completed(name: string, modified: number) {
        const backup = `${destination}.update-${name}`;
        fs.mkdirSync(backup);
        fs.writeFileSync(join(backup, "manifest.json"), JSON.stringify({ destination }));
        fs.writeFileSync(join(backup, "result.json"), JSON.stringify({ ok: true }));
        fs.writeFileSync(join(backup, "previous.asar"), name);
        fs.utimesSync(join(backup, "result.json"), modified, modified);
        return backup;
    }
    const oldest = completed("oldest", 1000);
    const undeletable = completed("undeletable", 1500);
    const older = completed("older", 2000);
    fs.writeFileSync(join(older, "ready.json"), JSON.stringify({ pid: 99999999 }));
    const newest = completed("newest", 3000);
    const active = completed("active", 4000);
    fs.writeFileSync(join(active, "ready.json"), JSON.stringify({ pid: process.pid }));
    const pending = completed("pending", 5000);
    fs.writeFileSync(`${destination}.update.json`, JSON.stringify({ directory: pending, workerPid: process.pid }));
    const failed = completed("failed", 6000);
    fs.writeFileSync(join(failed, "result.json"), JSON.stringify({ ok: false, error: "Preserve this failure" }));
    const unknown = completed("unknown", 7000);
    fs.writeFileSync(join(unknown, "result.json"), "Malformed result");
    const staged = completed("staged", 8000);
    fs.writeFileSync(join(staged, "archive.asar"), "Not promoted yet");
    const foreign = completed("foreign", 9000);
    fs.writeFileSync(join(foreign, "manifest.json"), JSON.stringify({ destination: join(directory, "other.asar") }));
    const linked = `${destination}.update-linked`;
    fs.symlinkSync(newest, linked, process.platform === "win32" ? "junction" : "dir");
    const unixProcess = Object.create(process);
    Object.defineProperty(unixProcess, "platform", { value: "linux" });
    const warnings: unknown[][] = [];
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { warn(...values: unknown[]) { warnings.push(values); } } },
        "original-fs": { ...fs, promises: { ...fs.promises, rm: async (file: fs.PathLike, options: fs.RmOptions) => {
            if (file === undeletable) throw new Error("Injected backup permission failure");
            await fs.promises.rm(file, options);
        } } },
        "child_process": { spawn: () => assert.fail("Retention fixture must not start a helper") },
        "electron": { app: {} },
        "../settings": { NativeSettings: { plain: {} }, RendererSettings: { plain: {} } }
    };
    const moduleFixture = { exports: {} };
    runInNewContext(compiled, { module: moduleFixture, exports: moduleFixture.exports, require: (id: string) => modules[id] ?? nativeRequire(id), process: unixProcess, Buffer, setTimeout });
    const api = moduleFixture.exports as { replaceVerifiedArchive(destination: string, data: Buffer): Promise<{ staged: boolean; }>; };
    try {
        assert.equal((await api.replaceVerifiedArchive(destination, Buffer.from("New archive"))).staged, false);
        assert.equal(fs.existsSync(oldest), false);
        assert.equal(fs.existsSync(older), false);
        for (const preserved of [newest, active, pending, failed, unknown, staged, foreign, linked, undeletable]) assert.equal(fs.existsSync(preserved), true, preserved);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][0], "Could not remove an older update backup.");
        assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
        const previousArchives = fs.readdirSync(directory).filter(name => name.startsWith("lawyercord.asar.update-") && name !== "lawyercord.asar.update-linked");
        assert.equal(previousArchives.length, 9);
        assert.equal(await readFile(destination, "utf8"), "New archive");
        modules["original-fs"] = { ...fs, readdirSync: () => { throw new Error("Injected backup listing failure"); } };
        const retryModule = { exports: {} };
        runInNewContext(compiled, { module: retryModule, exports: retryModule.exports, require: (id: string) => modules[id] ?? nativeRequire(id), process: unixProcess, Buffer, setTimeout });
        const retry = retryModule.exports as typeof api;
        assert.equal((await retry.replaceVerifiedArchive(destination, Buffer.from("Update after denied listing"))).staged, false);
        assert.equal(await readFile(destination, "utf8"), "Update after denied listing");
        for (const backup of previousArchives) assert.equal(fs.existsSync(join(directory, backup)), true);
        assert.equal(warnings.length, 2);
        assert.equal(warnings[1][0], "Could not check older update backups.");
    } finally { await rm(directory, { recursive: true, force: true }); }
});

const electronRuntime = process.env.LAWYERCORD_TEST_ELECTRON;
test("Windows helper applies an update for the actual Discord executable without launching Discord", { skip: !electronRuntime || process.platform !== "win32" }, async () => {
    assert.ok(electronRuntime);
    const f = await fixture(resolve(electronRuntime));
    try {
        const { child, state } = await f.start();
        child.stdin?.write("quit\n");
        await once(child, "exit");
        await waitFor(() => fs.existsSync(join(state.directory, "result.json")), "Electron helper promotion", f.diagnostics);
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
        "@utils/Logger": { Logger: class { warn() {} } },
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
