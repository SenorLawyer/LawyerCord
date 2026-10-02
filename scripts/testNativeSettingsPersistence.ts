/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";
import { mergeDefaults } from "../src/utils/mergeDefaults";

function fixture(renderer = "{}", native = "{}") {
    const directory = fs.mkdtempSync(join(tmpdir(), "lawyercord-settings-"));
    const rendererFile = join(directory, "settings.json");
    const nativeFile = join(directory, "native.json");
    fs.writeFileSync(rendererFile, renderer);
    fs.writeFileSync(nativeFile, native);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const exports: { RendererSettings?: SettingsStore<Record<string, unknown>>; NativeSettings?: SettingsStore<Record<string, unknown>>; } = {};
    let failure: "write" | "rename" | undefined;
    const source = fs.readFileSync(process.env.AUDIT_NATIVE_SETTINGS_SOURCE ?? "src/main/settings.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    try {
        runInNewContext(code, { exports, console: { error() { } }, require(name: string) {
            if (name === "@shared/IpcEvents") return { IpcEvents: { GET_SETTINGS_DIR: "directory", GET_SETTINGS: "get", SET_SETTINGS: "set" } };
            if (name === "@shared/SettingsStore") return { SettingsStore };
            if (name === "@utils/mergeDefaults") return { mergeDefaults };
            if (name === "electron") return { ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), on() { } } };
            if (name === "./utils/constants") return { SETTINGS_DIR: directory, SETTINGS_FILE: rendererFile, NATIVE_SETTINGS_FILE: nativeFile };
            if (name === "crypto") return { randomUUID };
            if (name === "fs") return {
                ...fs,
                writeFileSync(path: string, data: string) {
                    if (failure === "write") { fs.writeFileSync(path, "partial"); throw new Error("Private write failure"); }
                    fs.writeFileSync(path, data);
                },
                renameSync(from: string, to: string) {
                    if (failure === "rename") throw new Error("Private rename failure");
                    fs.renameSync(from, to);
                }
            };
            throw new Error(`Unexpected module ${name}`);
        } });
    } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
    assert.ok(exports.RendererSettings);
    assert.ok(exports.NativeSettings);
    return {
        renderer: exports.RendererSettings, native: exports.NativeSettings,
        fail(value?: typeof failure) { failure = value; },
        readRenderer: () => fs.readFileSync(rendererFile, "utf8"),
        readNative: () => fs.readFileSync(nativeFile, "utf8"),
        save(...args: unknown[]) { return handlers.get("set")?.({}, ...args); },
        close() { fs.rmSync(directory, { recursive: true, force: true }); }
    };
}

test("Settings files with primitive or array roots recover without breaking startup", () => {
    for (const value of ["null", "[]", "1", '"text"', "false", "invalid"]) {
        const f = fixture(value, value);
        try {
            assert.deepEqual(Object.keys(f.renderer.plain), []);
            assert.deepEqual(Object.keys(f.native.plain).sort(), ["customCspRules", "plugins"]);
            assert.equal(f.readRenderer(), value);
            assert.equal(f.readNative(), value);
        } finally { f.close(); }
    }
});

test("Malformed renderer settings IPC cannot replace memory or disk", () => {
    const f = fixture('{"saved":true}');
    try {
        for (const args of [[null], [[]], [1], ["text"], [{ changed: true }, 3], [{ changed: true }, undefined, false]]) {
            assert.throws(() => f.save(...args), /Invalid settings data/);
            assert.equal(f.readRenderer(), '{"saved":true}');
            assert.equal(f.renderer.plain.saved, true);
        }
    } finally { f.close(); }
});

test("Native write failures retain the complete previous file and can retry", () => {
    const original = '{"plugins":{},"customCspRules":{"saved.test":["img-src"]}}';
    const f = fixture("{}", original);
    try {
        for (const failure of ["write", "rename"] as const) {
            f.fail(failure);
            f.native.store.customCspRules = { "new.test": ["font-src"] };
            assert.equal(f.readNative(), original);
        }
        f.fail();
        f.native.markAsChanged();
        assert.deepEqual(JSON.parse(f.readNative()).customCspRules, { "new.test": ["font-src"] });
    } finally { f.close(); }
});

test("Renderer persistence retains conflict checks, notifications and scrubbed failures", () => {
    const f = fixture('{"saved":true}');
    try {
        const changes: unknown[] = [];
        f.renderer.addChangeListener("saved", value => changes.push(value));
        assert.throws(() => f.save({ saved: false }, "saved", "{}"), /Settings changed during sync/);
        for (const failure of ["write", "rename"] as const) {
            f.fail(failure);
            assert.throws(() => f.save({ saved: false }), /Failed to save settings\./);
            assert.equal(f.readRenderer(), '{"saved":true}');
            assert.equal(f.renderer.plain.saved, true);
        }
        f.fail();
        f.save({ saved: false }, "saved", JSON.stringify(f.renderer.plain));
        assert.equal(f.renderer.plain.saved, false);
        assert.deepEqual(changes, [false]);
        assert.deepEqual(JSON.parse(f.readRenderer()), { saved: false });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        assert.throws(() => f.save(cyclic), /Failed to save settings\./);
        assert.deepEqual(JSON.parse(f.readRenderer()), { saved: false });
    } finally { f.close(); }
});
