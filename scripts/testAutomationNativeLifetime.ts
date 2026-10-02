/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const require = createRequire(import.meta.url);
function fixture() {
    const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kills: number; signals: string[]; kill(signal: string): boolean; })[] = [];
    let networkSignal: AbortSignal | undefined;
    let finishNetwork: (() => void) | undefined;
    const source = readFileSync("src/equicordplugins/automationCore.desktop/native.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, Buffer, process, AbortController, DOMException, setTimeout, clearTimeout,
        fetch: (_url: string, options: { signal: AbortSignal; }) => {
            networkSignal = options.signal;
            return new Promise((_resolve, reject) => { finishNetwork = () => reject(new DOMException("Stopped", "AbortError")); });
        },
        require(name: string) {
            if (name === "@main/utils/constants") return { DATA_DIR: "fixture" };
            if (name.includes("automations/system")) return {};
            if (name === "electron") return { safeStorage: { isEncryptionAvailable: () => true, decryptString: () => "fixture" } };
            if (name === "fs/promises") return { readFile: async () => Buffer.from("fixture") };
            if (name === "child_process") return { spawn: () => {
                const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kills: 0, signals: [] as string[], kill(signal: string) { this.kills++; this.signals.push(signal); return true; } });
                children.push(child);
                return child;
            } };
            return require(name);
        }
    });
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
    return { api, sender, children, signal: () => networkSignal, finish: () => finishNetwork?.() };
}

test("Program cancellation owns only its renderer request and holds admission until close", async () => {
    const { api, sender, children } = fixture();
    const input = { requestId: "run", command: "fixture", args: [], timeoutSeconds: 600 };
    const pending = api.runProgram({ sender }, input);
    try {
        assert.equal(typeof api.cancelProgram, "function");
        api.cancelProgram({ sender: { id: 2 } }, "run");
        assert.equal(children[0].kills, 0);
        api.cancelProgram({ sender }, "run");
        assert.equal(children[0].kills, 1);
        assert.deepEqual(children[0].signals, ["SIGKILL"]);
        assert.equal((await api.runProgram({ sender }, input)).success, false);
        assert.equal(children.length, 1);
        children[0].emit("close", null);
        assert.equal((await pending).success, false);
        assert.equal(sender.listenerCount("destroyed"), 0);
        const next = api.runProgram({ sender }, input);
        sender.emit("render-process-gone");
        assert.equal(children[1].kills, 1);
        children[1].emit("close", null);
        await next;
        assert.equal(sender.listenerCount("render-process-gone"), 0);
    } finally {
        for (const child of children) child.emit("close", null);
        await pending;
    }
});

test("Destroyed renderer cancels AI while reservation survives pending network cleanup", async () => {
    const { api, sender, signal, finish } = fixture();
    const input = { requestId: "ai", model: "vendor/model", prompt: "fixture", systemPrompt: "", messages: [], maxTokens: 16, temperature: 1, json: false, timeoutSeconds: 300 };
    const pending = api.completeOpenRouter({ sender }, input);
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(signal());
        sender.emit("destroyed");
        assert.equal(signal()?.aborted, true);
        assert.equal((await api.completeOpenRouter({ sender }, input)).success, false);
    } finally { finish(); await pending; }
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.equal(sender.listenerCount("render-process-gone"), 0);
});
test("Stopped programs cannot bypass the native capacity while children are still closing", async () => {
    const { api, sender, children } = fixture();
    sender.setMaxListeners(0);
    const pending = Array.from({ length: 32 }, (_, index) => api.runProgram({ sender }, { requestId: String(index), command: "fixture", args: [], timeoutSeconds: 600 }));
    try {
        sender.emit("destroyed");
        assert.ok(children.every(child => child.kills === 1));
        assert.equal((await api.runProgram({ sender }, { requestId: "overflow", command: "fixture", args: [] })).success, false);
        assert.equal(children.length, 32);
    } finally {
        children.forEach(child => child.emit("close", null));
        await Promise.all(pending);
    }
    assert.equal(sender.listenerCount("destroyed"), 0);
});


test("Program timeout hard-stops only its owned child and waits for close", async () => {
    const { api, sender, children } = fixture();
    const pending = api.runProgram({ sender }, { requestId: "deadline", command: "fixture", args: [], timeoutSeconds: 1 });
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.deepEqual(children[0].signals, ["SIGKILL"]);
        assert.equal(settled, false);
        children[0].emit("close", null);
        assert.match((await pending).error, /too long/);
    } finally { children[0].emit("close", null); await pending; }
});
test("OpenRouter renderer cancellation handles an IPC rejection during teardown", async () => {
    let finish: (() => void) | undefined;
    let warnings = 0;
    const code = transpileModule(readFileSync("src/components/settings/tabs/automations/openRouter.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, crypto, IS_DISCORD_DESKTOP: true,
        require: (name: string) => name === "@utils/Logger" ? { Logger: class { warn() { warnings++; } } } : {},
        VencordNative: { pluginHelpers: { AutomationCore: {
            completeOpenRouter: () => new Promise(resolve => { finish = () => resolve({ success: false }); }),
            cancelOpenRouter: async () => { throw new Error("Renderer disconnected"); }
        } } }
    });
    const controller = new AbortController();
    const pending = api.completeOpenRouter({}, controller.signal);
    try {
        controller.abort();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(warnings, 1);
    } finally { finish?.(); await pending; }
});
