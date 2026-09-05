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

interface TestPlugin {
    name: string;
    dependencies?: string[];
    started?: boolean;
    isDependency?: boolean;
    requiresRestart?: boolean;
    commands?: object[];
    chatBarButton?: object;
    chatBarButtonWrapper?: object;
    userProfileBadges?: object[];
    start?(): void;
    onMessageClick?(this: TestPlugin): void;
    flux?: Record<string, (this: TestPlugin, data: unknown) => void | Promise<void>>;
}

function loadManager() {
    const plugins: Record<string, TestPlugin> = {};
    const settings: Record<string, { enabled: boolean; }> = {};
    const errors: unknown[][] = [];
    const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
    const dispatcher = {
        subscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)?.add(handler);
        },
        unsubscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            assert.ok(handlers.get(event)?.delete(handler), "unsubscribe must use the registered function");
        }
    };
    const mocks: Record<string, object> = {
        "~plugins": { __esModule: true, default: plugins },
        "@api/Settings": { Settings: { plugins: settings }, SettingsStore: { addChangeListener() {} } },
        "@webpack/common": { FluxDispatcher: dispatcher },
        "@debug/Tracer": { traceFunction: (_name: string, fn: unknown) => fn },
        "@utils/onlyOnce": { onlyOnce: (fn: unknown) => fn },
        "@utils/Logger": { Logger: class {
            info() {}
            warn() {}
            debug() {}
            error(...args: unknown[]) { errors.push(args); }
        } }
    };
    const source = readFileSync("src/api/PluginManager.ts", "utf8");
    const code = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const manager = runInNewContext(code + "\nexports;", {
        exports: {}, Promise, IS_REPORTER: false, IS_DEV: false,
        require(name: string) {
            if (name in mocks) return mocks[name];
            if (name.startsWith("@api/") || name.startsWith("./")) return {};
            if (name === "@utils/types" || name === "@utils/patches" || name === "@webpack/patcher") return {};
            throw new Error(`Unexpected import ${name}`);
        }
    });
    function add(plugin: TestPlugin) {
        plugins[plugin.name] = plugin;
        settings[plugin.name] = { enabled: false };
        return plugin;
    }
    return { manager, add, plugins, settings, dispatcher, handlers, errors };
}

test("flux subscriptions preserve original handlers and clean up the functions actually registered", async () => {
    const { manager, add, dispatcher, handlers, errors } = loadManager();
    let calls = 0;
    const plugin = add({ name: "Fixture" });
    const original = function (this: TestPlugin, data: unknown) {
        assert.equal(this, plugin);
        assert.equal(data, "payload");
        calls++;
    };
    for (let i = 0; i < 25; i++) {
        plugin.flux = { TEST: original };
        manager.subscribePluginFluxEvents(plugin, dispatcher);
        manager.subscribePluginFluxEvents(plugin, dispatcher);
        assert.equal(plugin.flux.TEST, original);
        assert.equal(handlers.get("TEST")?.size, 1);
        for (const handler of handlers.get("TEST") ?? []) await handler("payload");
        plugin.flux = {};
        manager.unsubscribePluginFluxEvents(plugin, dispatcher);
        manager.unsubscribePluginFluxEvents(plugin, dispatcher);
        assert.equal(handlers.get("TEST")?.size, 0);
    }
    assert.equal(calls, 25);
    assert.equal(errors.length, 0);
});

