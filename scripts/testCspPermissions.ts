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

function fixture() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pending: ((value: { response: number; checkboxChecked: boolean; }) => void)[] = [];
    const rules: Record<string, string[]> = {};
    const source = readFileSync(process.env.AUDIT_CSP_SOURCE ?? "src/main/csp/manager.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const exports: { registerCspIpcHandlers?: () => void; } = {};
    runInNewContext(code, { exports, URL, IS_DISCORD_DESKTOP: true, require(name: string) {
        if (name === "@main/settings") return { NativeSettings: { store: { customCspRules: rules } } };
        if (name === "@shared/IpcEvents") return { IpcEvents: { CSP_REMOVE_OVERRIDE: "remove", CSP_REQUEST_ADD_OVERRIDE: "add", CSP_IS_DOMAIN_ALLOWED: "allowed" } };
        if (name === "electron") return {
            ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
            dialog: { showMessageBox: () => new Promise(resolve => pending.push(resolve)) }
        };
        if (name === ".") return { CspPolicies: { "trusted.test": ["connect-src", "img-src"] }, ImageAndCssSrc: ["connect-src", "img-src", "style-src", "font-src"] };
        throw new Error(`Unexpected module ${name}`);
    } });
    exports.registerCspIpcHandlers?.();
    return { rules, pending, call(name: string, ...args: unknown[]) { return handlers.get(name)?.({}, ...args); } };
}

test("CSP IPC rejects malformed permission requests before showing a dialog", async () => {
    const f = fixture();
    for (const args of [
        ["https://example.test", null, "Plugin"], ["https://example.test", "img-src", "Plugin"],
        ["https://example.test", ["script-src"], "Plugin"], ["https://example.test", [], "Plugin"],
        ["file:///tmp/example", ["img-src"], "Plugin"], ["data:text/plain,example", ["img-src"], "Plugin"],
        ["https://__proto__", ["img-src"], "Plugin"],
        ["https://example.test", ["img-src"], {}], ["https://example.test", ["img-src"], "x".repeat(129)],
        ["https://example.test/" + "x".repeat(2048), ["img-src"], "Plugin"]
    ]) assert.equal(await f.call("add", ...args), "invalid");
    assert.equal(f.pending.length, 0);
    assert.deepEqual(f.rules, {});
    assert.equal(f.call("allowed", "file:///tmp/example", []), false);
    assert.equal(f.call("allowed", "https://trusted.test", []), false);
    assert.equal(f.call("remove", {}), false);
});

test("Concurrent CSP dialogs cannot overwrite an approved permission set", async () => {
    const f = fixture();
    const first = f.call("add", "https://example.test", ["img-src"], "Plugin");
    const second = f.call("add", "https://example.test", ["font-src"], "Plugin");
    f.pending[0]({ response: 1, checkboxChecked: true });
    assert.equal(await first, "ok");
    f.pending[1]({ response: 1, checkboxChecked: true });
    assert.equal(await second, "conflict");
    assert.deepEqual(Array.from(f.rules["example.test"]), ["img-src"]);
});

test("CSP permission grants require confirmation and retain lookup/removal behavior", async () => {
    const f = fixture();
    for (const [response, checkboxChecked, result] of [[0, true, "cancelled"], [1, false, "unchecked"], [1, true, "ok"]] as const) {
        const request = f.call("add", "https://example.test/path", ["img-src"], "Plugin");
        f.pending.pop()?.({ response, checkboxChecked });
        assert.equal(await request, result);
    }
    assert.equal(f.call("allowed", "https://example.test", ["img-src"]), true);
    assert.equal(f.call("allowed", "https://example.test", ["font-src"]), false);
    assert.equal(f.call("allowed", "https://trusted.test", ["connect-src"]), true);
    assert.equal(f.call("remove", "example.test"), true);
    assert.equal(f.call("remove", "example.test"), false);
});
