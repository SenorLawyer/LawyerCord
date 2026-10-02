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
    renderMessageAccessory?: () => unknown;
    onBeforeMessageSend?: () => void;
    start?(): void | Promise<void>;
    stop?(): void | Promise<void>;
    onMessageClick?(this: TestPlugin): void;
    flux?: Record<string, (this: TestPlugin, data: unknown) => void | Promise<void>>;
}

function loadManager() {
    const plugins: Record<string, TestPlugin> = {};
    const settings: Record<string, { enabled: boolean; }> = {};
    const errors: unknown[][] = [];
    const registeredCommands = new Map<string, object>();
    const commandRegistry: Record<string, object> = {};
    let commandRegistrations = 0;
    const sendListeners = new Set<() => void>();
    const accessories = new Map<string, () => unknown>();
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
        "@api/Commands": {
            commands: commandRegistry,
            registerCommand: (command: { name: string; }) => {
                if (registeredCommands.has(command.name)) throw new Error("Duplicate command.");
                commandRegistrations++;
                registeredCommands.set(command.name, command);
                commandRegistry[command.name] = command;
            },
            unregisterCommand: (name: string) => { delete commandRegistry[name]; return registeredCommands.delete(name); }
        },
        "@api/MessageEvents": {
            addMessagePreSendListener: (listener: () => void) => sendListeners.add(listener),
            removeMessagePreSendListener: (listener: () => void) => sendListeners.delete(listener),
        },
        "@api/MessageAccessories": {
            addMessageAccessory: (name: string, render: () => unknown) => accessories.set(name, render),
            removeMessageAccessory: (name: string) => accessories.delete(name),
        },
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
    return { manager, add, plugins, settings, dispatcher, handlers, errors, accessories, sendListeners, registeredCommands, commandRegistry, get commandRegistrations() { return commandRegistrations; } };
}

test("plugins without start callbacks register their commands only once", () => {
    const fixture = loadManager();
    const plugin = fixture.add({ name: "Fixture", commands: [{ name: "fixture" }] });
    assert.equal(fixture.manager.startPlugin(plugin), true);
    assert.equal(fixture.manager.startPlugin(plugin), false);
    assert.equal(fixture.commandRegistrations, 1);
    assert.equal(fixture.manager.stopPlugin(plugin), true);
    assert.equal(fixture.registeredCommands.size, 0);
    assert.equal(fixture.manager.startPlugin(plugin), true);
    assert.equal(fixture.commandRegistrations, 2);
});

test("failed stop callbacks still release declarative commands, hooks and flux handlers", () => {
    const fixture = loadManager();
    const plugin = fixture.add({
        name: "Fixture",
        commands: [{ name: "fixture" }],
        onBeforeMessageSend() {},
        renderMessageAccessory: () => null,
        flux: { TEST() {} },
        stop() { throw new Error("Stop failed"); }
    });
    fixture.manager.subscribeAllPluginsFluxEvents(fixture.dispatcher);
    fixture.manager.startPlugin(plugin);
    assert.equal(fixture.handlers.get("TEST")?.size, 1);
    assert.equal(fixture.manager.stopPlugin(plugin), false);
    assert.equal(plugin.started, false);
    assert.equal(fixture.registeredCommands.size, 0);
    assert.equal(fixture.sendListeners.size, 0);
    assert.equal(fixture.accessories.size, 0);
    assert.equal(fixture.handlers.get("TEST")?.size, 0);
    assert.equal(fixture.errors.length, 1);
});

test("declarative message accessories enable their API and follow plugin lifecycle", () => {
    const { manager, add, settings, accessories } = loadManager();
    add({ name: "MessageAccessoriesAPI" });
    const renderMessageAccessory = () => "conversion";
    const plugin = add({ name: "Fixture", renderMessageAccessory });
    settings.Fixture.enabled = true;
    manager.initPluginManager();
    assert.equal(settings.MessageAccessoriesAPI.enabled, true);
    manager.startPlugin(plugin);
    assert.equal(accessories.get("Fixture")?.(), "conversion");
    manager.stopPlugin(plugin);
    assert.equal(accessories.size, 0);
    manager.startPlugin(plugin);
    assert.equal(accessories.size, 1);
    assert.equal(accessories.get("Fixture")?.(), "conversion");
});

test("declarative profile badges enable their API dependency", () => {
    const { manager, add, settings } = loadManager();
    const api = add({ name: "BadgeAPI" });
    add({ name: "Fixture", userProfileBadges: [{ id: "fixture" }] });
    settings.Fixture.enabled = true;
    manager.initPluginManager();
    assert.equal(settings.BadgeAPI.enabled, true);
    assert.equal(api.isDependency, true);
});

test("nested dependency restart requirements and failures reach the caller", () => {
    for (const fails of [false, true]) {
        const { manager, add, settings } = loadManager();
        let parentStarts = 0;
        add({ name: "Leaf", requiresRestart: !fails, start() { throw new Error("Cannot start"); } });
        add({ name: "Parent", dependencies: ["Leaf"], start() { parentStarts++; } });
        const plugin = add({ name: "Fixture", dependencies: ["Parent"] });
        const result = manager.startDependenciesRecursive(plugin);
        assert.equal(result.restartNeeded, !fails);
        assert.deepEqual(Array.from(result.failures), fails ? ["Leaf"] : []);
        assert.equal(parentStarts, 0);
        assert.equal(settings.Leaf.enabled, !fails);
        assert.equal(settings.Parent.enabled, !fails);
        const repeated = manager.startDependenciesRecursive(plugin);
        assert.equal(repeated.restartNeeded, !fails);
        assert.deepEqual(Array.from(repeated.failures), fails ? ["Leaf"] : []);
        assert.equal(parentStarts, 0);
    }
});

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


test("declarative send hooks enable their API and clean up on stop", () => {
    const { manager, add, settings, sendListeners } = loadManager();
    add({ name: "MessageEventsAPI" });
    let calls = 0;
    const plugin = add({ name: "Fixture", onBeforeMessageSend: () => { calls++; } });
    settings.Fixture.enabled = true;
    manager.initPluginManager();
    assert.equal(settings.MessageEventsAPI.enabled, true);
    for (let i = 0; i < 2; i++) {
        manager.startPlugin(plugin);
        assert.equal(sendListeners.size, 1);
        for (const listener of sendListeners) listener();
        manager.stopPlugin(plugin);
        assert.equal(sendListeners.size, 0);
    }
    assert.equal(calls, 2);
});


test("async lifecycle rejections are logged and stop still releases registrations", async () => {
    const fixture = loadManager();
    const plugin = fixture.add({
        name: "AsyncFixture", commands: [{ name: "async" }],
        async start() { throw new Error("Start rejected"); },
        async stop() { throw new Error("Stop rejected"); }
    });
    assert.equal(fixture.manager.startPlugin(plugin), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(String(fixture.errors[0][0]), /Failed to start AsyncFixture/);
    assert.equal(fixture.manager.stopPlugin(plugin), true);
    assert.equal(plugin.started, false);
    assert.equal(fixture.registeredCommands.size, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(String(fixture.errors[1][0]), /Failed to stop AsyncFixture/);
});

test("failed command registration rolls back the plugin without removing another owner's command", () => {
    const fixture = loadManager();
    const other = fixture.add({ name: "Other", commands: [{ name: "shared" }] });
    let stops = 0;
    const plugin = fixture.add({ name: "Fixture", commands: [{ name: "first" }, { name: "shared" }], stop() { stops++; } });
    fixture.manager.startPlugin(other);
    assert.equal(fixture.manager.startPlugin(plugin), false);
    assert.equal(plugin.started, false);
    assert.equal(stops, 1);
    assert.deepEqual([...fixture.registeredCommands.keys()], ["shared"]);
    assert.equal(other.started, true);
});


test("Stopping declarative root commands releases their registered subcommand copies", () => {
    const fixture = loadManager();
    const root = { name: "root" };
    const plugin = fixture.add({ name: "Fixture", commands: [root] });
    fixture.manager.startPlugin(plugin);
    fixture.registeredCommands.delete(root.name);
    delete fixture.commandRegistry[root.name];
    for (const name of ["root one", "root two"]) {
        const child = { ...root, name, rootCommand: root };
        fixture.registeredCommands.set(name, child);
        fixture.commandRegistry[name] = child;
    }
    assert.equal(fixture.manager.stopPlugin(plugin), true);
    assert.equal(fixture.registeredCommands.size, 0);
});
