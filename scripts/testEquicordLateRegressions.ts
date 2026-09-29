/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load<T>(path: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = ""): T {
    const exports = {};
    const source = readFileSync(`src/equicordplugins/${path}`, "utf8") + extra;
    const { outputText } = transpileModule(source, { compilerOptions: {
        module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false
    } });
    runInNewContext(outputText, { exports, require: (id: string) => {
        assert.ok(id in modules, `Unexpected import ${id}`);
        return modules[id];
    }, URL, Error, AbortController, ...globals });
    return exports as T;
}

const logger = { Logger: class { warn() {} error() {} } };
const types = { default: (value: unknown) => value, OptionType: {} };

test("Roblox process checks stay on their timer and stop releases it", async () => {
    let checks = 0;
    const timers = new Map<number, () => Promise<void>>();
    const { default: plugin } = load<{ default: {
        start(): void; stop(): void; flux?: { PRESENCE_UPDATE?: (event: unknown) => void };
    } }>("robloxActivity.desktop/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { pollInterval: 60 } }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/discord": {},
        "@utils/Logger": logger, "@utils/types": types,
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "1045011641940574208" }) }, PresenceStore: { getActivities: () => [] } }
    }, {
        VencordNative: { pluginHelpers: { RobloxActivity: { isRobloxRunning: async () => { checks++; return false; } } } },
        setInterval: (callback: () => Promise<void>, delay: number) => { assert.equal(delay, 60_000); timers.set(1, callback); return 1; },
        clearInterval: (id: number) => timers.delete(id)
    });
    plugin.start();
    await setImmediate();
    assert.equal(checks, 1);
    for (let i = 0; i < 100; i++) {
        plugin.flux?.PRESENCE_UPDATE?.({ user: { id: "other" } });
        await setImmediate();
    }
    assert.equal(checks, 1);
    for (const tick of timers.values()) await tick();
    assert.equal(checks, 2);
    plugin.stop();
    assert.equal(timers.size, 0);
});

test("Sticker checks share a parsed blocklist and observe setting changes", () => {
    let allocations = 0;
    class CountingSet<T> extends Set<T> { constructor() { super(); allocations++; } }
    const settings = { store: { blockedStickers: Array.from({ length: 1000 }, (_, i) => String(i)).join(", ") }, use() { return this.store; } };
    const { default: plugin } = load<{ default: { isBlocked(id: string): boolean } }>("stickerBlocker/index.tsx", {
        "@api/ContextMenu": {}, "@api/Settings": { definePluginSettings: () => settings },
        "@components/ErrorBoundary": { default: { wrap: (value: unknown) => value } },
        "@utils/constants": { Devs: {} }, "@utils/misc": {}, "@utils/types": types,
        "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": {}
    }, { Set: CountingSet });
    assert.equal(plugin.isBlocked("999"), true);
    const initial = allocations;
    for (let i = 0; i < 10_000; i++) assert.equal(plugin.isBlocked("999"), true);
    assert.equal(allocations, initial);
    settings.store.blockedStickers = "new";
    assert.equal(plugin.isBlocked("999"), false);
    assert.equal(plugin.isBlocked("new"), true);
    assert.equal(allocations, initial + 1);
});
