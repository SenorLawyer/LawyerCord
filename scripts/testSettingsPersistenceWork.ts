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
import { SettingsStore } from "../src/shared/SettingsStore";
import { mergeDefaults } from "../src/utils/mergeDefaults";

function fixture(legacy = false) {
    const initial = { plugins: Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`P${i}`, { enabled: false, history: "x".repeat(500) }])), cloud: {} };
    const files = new Map<string, string>([["renderer", JSON.stringify(initial)]]);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const syncHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const sender = {};
    let sessionId = 0;
    const jobs: (() => void)[] = [];
    const listeners = new Map<string, () => void>();
    let sends = 0;
    let writes = 0;
    let fail = false;
    const compile = (source: string) => transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const native = runInNewContext(compile(readFileSync("src/main/settings.ts", "utf8")) + "\nexports;", {
        exports: {}, console: { error() {} }, require(name: string) {
            if (name === "@shared/SettingsStore") return { SettingsStore };
            if (name === "@utils/mergeDefaults") return { mergeDefaults };
            if (name === "@shared/IpcEvents") return { IpcEvents: { GET_SETTINGS_SESSION: "session", SET_SETTINGS: "set", GET_SETTINGS: "get", GET_SETTINGS_DIR: "dir" } };
            if (name === "electron") return { ipcMain: { handle: (key: string, fn: (...args: unknown[]) => unknown) => handlers.set(key, fn), on: (key: string, fn: (...args: unknown[]) => unknown) => syncHandlers.set(key, fn) } };
            if (name === "./utils/constants") return { SETTINGS_DIR: "dir", SETTINGS_FILE: "renderer", NATIVE_SETTINGS_FILE: "native" };
            if (name === "crypto") return { randomUUID: () => String(++sessionId) };
            if (name === "fs") return { mkdirSync() {}, readFileSync: (key: string) => files.get(key) ?? "{}", writeFileSync: (key: string, value: string) => { writes++; if (fail) throw new Error("Failure"); files.set(key, value); }, renameSync: (from: string, to: string) => files.set(to, files.get(from) ?? "") };
            throw new Error(name);
        }
    });
    const sessionEvent = { sender, returnValue: undefined as unknown };
    syncHandlers.get("session")?.(sessionEvent);
    const bridge = {
        get: () => structuredClone(native.RendererSettings.plain),
        set: (...args: unknown[]) => {
            sends++;
            const copy = structuredClone([args[0], args[1], args[2], args[3], sessionEvent.returnValue]);
            return new Promise<void>((resolve, reject) => jobs.push(() => { try { handlers.get("set")?.({ sender }, ...copy); resolve(); } catch (error) { reject(error); } }));
        },
        setSync: (...args: unknown[]) => {
            sends++;
            const event = { sender, returnValue: undefined as unknown };
            syncHandlers.get("set")?.(event, ...structuredClone([args[0], args[1], undefined, args[2], sessionEvent.returnValue]));
            if (typeof event.returnValue === "string") throw new Error(event.returnValue);
        }
    };
    const api = runInNewContext(compile(readFileSync("src/api/Settings.ts", "utf8")) + "\nexports;", {
        exports: {}, IS_REPORTER: false, IS_WEB: false, VencordNative: { settings: legacy ? { get: bridge.get, set: bridge.set } : bridge }, window: { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) },
        require(name: string) {
            if (name === "@shared/SettingsStore") return { SettingsStore };
            if (name === "@utils/mergeDefaults") return { mergeDefaults };
            if (name === "@utils/Logger") return { Logger: class { error() {} } };
            if (name === "~plugins") return { default: {} };
            return {};
        }
    });
    return { api, native, jobs, bridge, listeners, reload() { syncHandlers.get("session")?.(sessionEvent); }, sends: () => sends, writes: () => writes, saved: () => JSON.parse(files.get("renderer") ?? "{}"), fail(value: boolean) { fail = value; }, async drain() {
        for (let index = 0; index < 12; index++) { jobs.splice(0).forEach(job => job()); await Promise.resolve(); }
    } };
}

test("One hundred synchronous settings edits send and persist only first and latest snapshots", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.api.Settings.plugins[`P${i}`].enabled = true;
    await f.drain();
    assert.equal(f.sends(), 2);
    assert.equal(f.writes(), 2);
    assert.equal(Object.values(f.saved().plugins).filter((p: unknown) => (p as { enabled: boolean; }).enabled).length, 100);
});


test("Batched native notifications include every changed path and overflow still notifies subscribers", async () => {
    const f = fixture();
    const volumes: number[] = [];
    f.native.RendererSettings.addChangeListener("plugins.FixSpotifyEmbeds.volume", (value: number) => volumes.push(value));
    f.api.Settings.plugins.P0.enabled = true;
    f.api.Settings.plugins.FixSpotifyEmbeds = { enabled: true, volume: 55 };
    f.api.Settings.plugins.FixSpotifyEmbeds.volume = 60;
    f.api.Settings.plugins.Obsolete = { nested: 1 };
    delete f.api.Settings.plugins.Obsolete;
    for (let i = 0; i < 300; i++) f.api.Settings.plugins.P0[`field${i}`] = i;
    await f.drain();
    assert.deepEqual(volumes, [60]);
    assert.equal(f.writes(), 2);
});

test("Failed first persistence retains its paths in the newer queued commit without retry spinning", async () => {
    const f = fixture();
    const notified: boolean[] = [];
    f.native.RendererSettings.addChangeListener("plugins.P0.enabled", (value: boolean) => notified.push(value));
    f.api.Settings.plugins.P0.enabled = true;
    f.api.Settings.plugins.P1.enabled = true;
    f.fail(true);
    f.jobs.shift()?.();
    await Promise.resolve();
    f.fail(false);
    await f.drain();
    assert.equal(f.saved().plugins.P0.enabled, true);
    assert.equal(f.saved().plugins.P1.enabled, true);
    assert.deepEqual(notified, [true]);
    const g = fixture();
    g.fail(true);
    g.api.Settings.plugins.P0.enabled = true;
    await g.drain();
    assert.equal(g.sends(), 1);
    const flush = g.api.flushSettings();
    const failure = assert.rejects(flush, /Failed to save settings/);
    await g.drain();
    await failure;
    assert.equal(g.sends(), 2);
    assert.equal(g.saved().plugins.P0.enabled, false);
});

test("Before unload persists latest data and old queued IPC cannot overwrite it across reload", async () => {
    const f = fixture();
    f.api.Settings.plugins.P0.enabled = true;
    f.api.Settings.plugins.P1.enabled = true;
    f.listeners.get("beforeunload")?.();
    assert.equal(f.saved().plugins.P1.enabled, true);
    f.reload();
    const next = structuredClone(f.saved());
    next.plugins.P2.enabled = true;
    f.bridge.setSync(next, ["plugins.P2.enabled"], 1);
    await f.drain();
    assert.equal(f.saved().plugins.P2.enabled, true);
    assert.equal(f.saved().plugins.P1.enabled, true);
});

test("Explicit persistence waits for automatic saves and rejects edits during its acknowledgement", async () => {
    const f = fixture();
    f.api.Settings.plugins.P0.enabled = true;
    f.api.Settings.plugins.P1.enabled = true;
    const before = f.api.flushSettings();
    await f.drain();
    await before;
    const expected = JSON.stringify(f.bridge.get());
    const imported = { ...f.bridge.get(), imported: true };
    const explicit = f.api.persistSettings(imported, expected);
    const rejected = assert.rejects(explicit, /Settings changed while saving/);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    assert.equal(f.jobs.length, 1);
    f.api.Settings.plugins.P2.enabled = true;
    await f.drain();
    await rejected;
    assert.equal(f.saved().plugins.P2.enabled, true);
    assert.equal(f.api.PlainSettings.imported, undefined);
    const stale = f.api.persistSettings(imported, expected);
    const cas = assert.rejects(stale, /Settings changed during sync/);
    await f.drain();
    await cas;
});


test("Explicit persistence rejects edits made while acquiring its save slot", async () => {
    const f = fixture();
    const candidate = structuredClone(f.api.PlainSettings);
    const explicit = f.api.persistSettings(candidate);
    const rejected = assert.rejects(explicit, /Settings changed while saving/);
    f.api.Settings.plugins.P0.enabled = true;
    await f.drain();
    await rejected;
    assert.equal(f.saved().plugins.P0.enabled, true);
});

test("Unload without ordinary edits does not overwrite an in-flight explicit candidate", async () => {
    const f = fixture();
    const candidate = { ...structuredClone(f.api.PlainSettings), imported: true };
    const explicit = f.api.persistSettings(candidate);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    f.listeners.get("beforeunload")?.();
    assert.equal(f.sends(), 1);
    await f.drain();
    await explicit;
    assert.equal(f.saved().imported, true);
});


test("Older native hosts without synchronous flush retain immediate persistence", async () => {
    const f = fixture(true);
    for (let i = 0; i < 100; i++) f.api.Settings.plugins[`P${i}`].enabled = true;
    assert.equal(f.sends(), 100);
    assert.equal(f.listeners.has("beforeunload"), false);
    await f.drain();
    assert.equal(f.writes(), 100);
});

test("Explicit saves take the shared slot sequentially", async () => {
    const f = fixture();
    const first = f.api.persistSettings({ ...structuredClone(f.api.PlainSettings), order: 1 });
    const second = f.api.persistSettings({ ...structuredClone(f.api.PlainSettings), order: 2 });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(f.jobs.length, 1);
    f.jobs.shift()?.();
    await first;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(f.jobs.length, 1);
    await f.drain();
    await second;
    assert.equal(f.saved().order, 2);
});

test("Import completion cannot overwrite a local edit queued after native acknowledgement", async () => {
    for (let delay = 0; delay < 8; delay++) {
        const f = fixture();
        const source = readFileSync("src/api/SettingsSync/offline.ts", "utf8");
        const offline = runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText + "\nexports;", {
            exports: {}, structuredClone, VencordNative: { settings: f.bridge }, require(name: string) {
                if (name === "@api/Settings") return f.api;
                if (name === "@utils/Logger") return { Logger: class {} };
                if (name === "@utils/misc") return { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) };
                return {};
            }
        });
        const importing = offline.importSettings(JSON.stringify({ settings: { plugins: { P0: { history: "imported" } } } }), "plugins").catch(() => undefined);
        for (let index = 0; index < 12; index++) await Promise.resolve();
        assert.equal(f.jobs.length, 1);
        f.jobs.shift()?.();
        for (let index = 0; index < delay; index++) await Promise.resolve();
        f.api.Settings.plugins.P0.history = "newer";
        await importing;
        await f.drain();
        assert.equal(f.api.PlainSettings.plugins.P0.history, "newer", `Microtask delay ${delay}`);
        assert.equal(f.saved().plugins.P0.history, "newer");
    }
});
