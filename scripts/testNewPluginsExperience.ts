/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

import * as knownSettingsData from "../src/equicordplugins/newPluginsManager/knownSettingsData";

import { catalogPage, PAGE_SIZE } from "../src/components/settings/tabs/plugins/catalog";

function compile(path: string) {
    return transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
}

function fixture(count = 1, deferRegistry = false) {
    let registryReady = !deferRegistry;
    let writes = 0;
    let opens = 0;
    let closes = 0;
    let cards = 0;
    let failWrite = false;
    let boundary: { props: { onError(): void; children: Array<{ type(props: object): { props: { actions: Array<{ onClick(): Promise<void> }> } }; props: object }> } };
    let onClose = () => {};
    const subscriptions: string[][] = [];
    const plugins = Object.fromEntries(Array.from({ length: count }, (_, index) => [`Plugin${index}`, { name: `Plugin${index}`, description: "Plugin." }]));
    const settings = { plugins: { NewPluginsManager: { enabled: true }, ...Object.fromEntries(Object.keys(plugins).map(name => [name, { enabled: false }])) } };
    const changes = { newPlugins: new Set(Object.keys(plugins)), newSettings: new Map() };
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => {
        if (type === "PluginCard") cards++;
        return { type, props: { ...props, children } };
    } };
    const modules: Record<string, unknown> = {
        "~plugins": { __esModule: true, get default() { if (!registryReady) throw Error("Plugin registry is still initializing."); return plugins; } },
        "@api/Settings": { Settings: settings, useSettings: (paths: string[]) => { subscriptions.push(paths); return settings; } },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/ChangeList": { ChangeList: class { hasChanges = false; } },
        "@utils/react": { useForceUpdater: () => () => {} }, "@components/Notice": { Notice: { Info: "notice" } },
        "@components/settings/tabs/plugins/PluginCard": { PluginCard: "PluginCard" },
        "@components/settings/tabs/plugins/catalog": { catalogPage, PAGE_SIZE },
        "@components/settings/tabs/plugins": { CatalogPagination: "pages" },
        "@webpack/common": { React, useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, () => {}],
            openModal: (render: (props: object) => typeof boundary, options?: { onCloseCallback(): void }) => {
                opens++; onClose = () => { closes++; options?.onCloseCallback(); }; boundary = render({ onClose }); return "modal";
            }, closeModal: () => onClose(), showToast() {}, Toasts: { Type: { FAILURE: "failure" } }
        },
        "./knownSettings": { getNewPluginChanges: async () => changes, writeKnownSettings: async () => { writes++; if (failWrite) throw Error("Storage unavailable."); } }
    };
    const api = runInNewContext(`${compile("src/equicordplugins/newPluginsManager/NewPluginsModal.tsx")};({ ...exports, NewPluginsModal })`, {
        exports: {}, React, require: (name: string) => modules[name] ?? {}, location: { reload() {} }
    });
    registryReady = true;
    return { api, settings, subscriptions, changes, get writes() { return writes; }, get opens() { return opens; }, get closes() { return closes; }, get cards() { return cards; },
        failStorage() { failWrite = true; }, close: () => onClose(), error: () => boundary.props.onError(),
        render: () => { const node = boundary.props.children[0]; return node.type(node.props); }
    };
}

test("New plugin updates remain unread after closing or a rendering failure", async () => {
    const f = fixture();
    await f.api.openNewPluginsModal();
    assert.equal(f.writes, 0);
    await f.api.openNewPluginsModal();
    assert.equal(f.opens, 1);
    f.close();
    await f.api.openNewPluginsModal();
    assert.equal(f.opens, 2);
    f.error();
    await f.api.openNewPluginsModal();
    assert.equal(f.opens, 3);
    assert.equal(f.writes, 0);
});

for (const action of [0, 1]) test(`New plugin acknowledgment action ${action} persists only after explicit selection`, async () => {
    const f = fixture();
    await f.api.openNewPluginsModal();
    const modal = f.render();
    assert.equal(f.writes, 0);
    await modal.props.actions[action].onClick();
    assert.equal(f.writes, 1);
    assert.equal(f.settings.plugins.NewPluginsManager.enabled, action !== 0);
    await f.api.openNewPluginsModal();
    assert.equal(f.opens, 1);
});

test("New plugin acknowledgment storage failure preserves unread state", async () => {
    const f = fixture();
    await f.api.openNewPluginsModal();
    f.failStorage();
    await f.render().props.actions[1].onClick();
    assert.equal(f.closes, 0);
    f.close();
    await f.api.openNewPluginsModal();
    assert.equal(f.opens, 2);
});

test("New plugin list slices data before creating cards and subscribes only to enabled flags", async () => {
    const f = fixture(500);
    await f.api.openNewPluginsModal();
    f.render();
    assert.equal(f.cards, PAGE_SIZE);
    assert.ok(f.subscriptions[0].length > 0);
    assert.ok(f.subscriptions[0].includes("plugins"));
    assert.ok(f.subscriptions[0].every(path => path === "plugins" || /^plugins\.[^.]+(?:\.enabled)?$/.test(path)));
    for (const path of f.subscriptions[0].filter(path => path.endsWith(".enabled")))
        assert.ok(f.subscriptions[0].includes(path.slice(0, -".enabled".length)));
    const store = new SettingsStore({ plugins: { Plugin0: { enabled: false, history: 0 } } });
    let invalidations = 0;
    for (const path of f.subscriptions[0]) store.addChangeListener(path, () => invalidations++);
    store.store.plugins.Plugin0.history++;
    assert.equal(invalidations, 0);
    store.store.plugins.Plugin0.enabled = true;
    assert.equal(invalidations, 1);
    store.store.plugins.Plugin0 = { enabled: false, history: 0 };
    assert.equal(invalidations, 2);
    store.store.plugins = { Plugin0: { enabled: true, history: 0 } };
    assert.equal(invalidations, 3);
});

for (const legacy of [false, true]) test(`New plugin baseline ${legacy ? "migration preserves unread additions" : "is silent on first install"}`, async () => {
    const stored = new Map<string, unknown>();
    if (legacy) stored.set("NewPluginsManager_KnownPlugins", ["Existing"]);
    const plugins = { Existing: { settings: { def: { alpha: {} } } }, Added: { settings: { def: { beta: {} } } } };
    const modules: Record<string, unknown> = {
        "~plugins": { __esModule: true, default: plugins }, "./knownSettingsData": knownSettingsData,
        "@api/index": { DataStore: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => stored.set(key, value) } }
    };
    const api = runInNewContext(`${compile("src/equicordplugins/newPluginsManager/knownSettings.ts")};exports`, {
        exports: {}, Map, Set, require: (name: string) => modules[name]
    });
    const changes = await api.getNewPluginChanges();
    assert.deepEqual(Array.from(changes.newPlugins), legacy ? ["Added"] : []);
    assert.deepEqual(Array.from(changes.newSettings.keys()), legacy ? ["Added"] : []);
    await api.writeKnownSettings();
    assert.equal((await api.getNewPluginChanges()).newPlugins.size, 0);
});

test("New plugin module defers registry access until rendering", async () => {
    const f = fixture(2, true);
    await f.api.openNewPluginsModal();
    f.render();
    assert.equal(f.cards, 2);
});
