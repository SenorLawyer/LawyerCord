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

import { catalogPage, createCatalog, DEFAULT_FILTERS, filterCatalog, PAGE_SIZE } from "../src/components/settings/tabs/plugins/catalog";
import { SettingsStore } from "../src/shared/SettingsStore";
import { makeLazy } from "../src/utils/lazy";
import type { Plugin } from "../src/utils/types";

function plugins(count: number): Record<string, Plugin> {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => {
        const name = `Plugin${String(index).padStart(3, "0")}`;
        return [name, { name, description: "A test plugin.", authors: [], started: false, tags: ["Utility"] } satisfies Plugin];
    }));
}

test("catalog combines status, source, tags, settings and impact without inventing ratings", () => {
    const list = plugins(4);
    list.Plugin000.settingsAboutComponent = () => null;
    list.Plugin000.performance = { impact: "low", description: "Only runs on demand." };
    list.Plugin001.performance = { impact: "high", description: "Continuously draws a visualization." };
    const meta = Object.fromEntries(Object.keys(list).map((name, index) => [name, { folderName: index < 2 ? "src/equicordplugins/test" : "src/plugins/test", userPlugin: false }]));
    const catalog = createCatalog(list, meta);
    const enabled = new Set(["Plugin000", "Plugin002"]);
    const hasSettings = (plugin: Plugin) => Boolean(plugin.settingsAboutComponent);
    assert.deepEqual(filterCatalog(catalog, { ...DEFAULT_FILTERS, status: "enabled", source: "lawyercord", tags: ["Utility"], feature: "settings", impact: "low" }, enabled, null, hasSettings).map(plugin => plugin.name), ["Plugin000"]);
    assert.deepEqual(filterCatalog(catalog, { ...DEFAULT_FILTERS, impact: "unknown" }, enabled, null, hasSettings).map(plugin => plugin.name), ["Plugin002", "Plugin003"]);
    assert.deepEqual(filterCatalog(catalog, { ...DEFAULT_FILTERS, sort: "impact" }, enabled, null, hasSettings).map(plugin => plugin.name), ["Plugin000", "Plugin001", "Plugin002", "Plugin003"]);
    assert.deepEqual(filterCatalog(catalog, { ...DEFAULT_FILTERS, query: "Plugin 002" }, enabled, null, hasSettings).map(plugin => plugin.name), ["Plugin002"]);
    assert.deepEqual(filterCatalog(catalog, { ...DEFAULT_FILTERS, feature: "new", sort: "new" }, enabled, new Set(["Plugin003"]), hasSettings).map(plugin => plugin.name), ["Plugin003"]);
});

test("every catalog page stays bounded and a shrinking result set clamps the current page", () => {
    const list = Object.values(plugins(362));
    const seen = new Set<string>();
    for (let page = 0; page < Math.ceil(list.length / PAGE_SIZE); page++) {
        const result = catalogPage(list, page);
        assert.ok(result.entries.length <= PAGE_SIZE);
        for (const plugin of result.entries) { assert.ok(!seen.has(plugin.name)); seen.add(plugin.name); }
    }
    assert.equal(seen.size, 362);
    assert.equal(catalogPage(list.slice(0, 2), 10).page, 0);
    assert.equal(catalogPage([], 10).entries.length, 0);
});

test("the actual settings screen constructs one page of cards and subscribes only to enable changes", () => {
    const list = plugins(362);
    const settings = { plugins: Object.fromEntries(Object.keys(list).map(name => [name, { enabled: false }])) };
    let cards = 0;
    let registryReady = false;
    let subscribed: string[] | undefined;
    const React = { createElement(type: unknown, props: object | null, ...children: unknown[]) { if (type === "plugin-card") cards++; return { type, props: { ...props, children } }; }, Fragment: "fragment", useEffect() {} };
    const common = { React, useMemo: (factory: () => unknown) => factory(), useRef: () => ({ current: null }), useCallback: (fn: unknown) => fn,
        useState: (initial: unknown) => [initial, () => undefined], Tooltip: "tooltip", lodash: { isEqual: () => true } };
    const modules: Record<string, unknown> = {
        "@api/Settings": { useSettings: (paths?: string[]) => { subscribed = paths; return settings; } },
        "@api/PluginManager": { isPluginEnabled: () => false, hasAnyVisibleSettings: () => false },
        "@utils/ChangeList": { ChangeList: class { hasChanges = false; } },
        "@utils/css": { classNameFactory: () => () => "plugins" },
        "@utils/lazy": { makeLazy },
        "@utils/Logger": { Logger: class {} },
        "@utils/misc": { classes: (...names: string[]) => names.join(" ") },
        "@utils/margins": { Margins: {} }, "@utils/types": { PluginTags: [] }, "@utils/guards": { isTruthy: Boolean },
        "@utils/react": { useCleanupEffect() {}, useAwaiter: () => [null], useIntersection: () => [null, false] },
        "@webpack/common": common,
        "~plugins": { __esModule: true, get default() { assert.ok(registryReady, "the generated plugin registry must not be read during its import cycle"); return list; }, ExcludedPlugins: {}, get PluginMeta() { assert.ok(registryReady); return Object.fromEntries(Object.keys(list).map(name => [name, { folderName: "src/plugins/test", userPlugin: false }])); } },
        "./catalog": { createCatalog, filterCatalog, catalogPage, DEFAULT_FILTERS, IMPACT_LABELS: {} },
        "./PluginCard": { PluginCard: "plugin-card" }
    };
    const source = readFileSync(process.env.AUDIT_CATALOG_SOURCE ?? "src/components/settings/tabs/plugins/index.tsx", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } });
    const component = runInNewContext(`${outputText};exports.default`, { exports: {}, require: (name: string) => modules[name] ?? {}, IS_STANDALONE: false, React });
    registryReady = true;
    component();
    assert.equal(cards, PAGE_SIZE, "offscreen cards must not even be constructed");
    assert.ok(subscribed);
    const paths = Array.from(subscribed);
    assert.ok(paths.includes("plugins"));
    assert.ok(Object.keys(list).every(name => paths.includes(`plugins.${name}`) && paths.includes(`plugins.${name}.enabled`)));
    const store = new SettingsStore(settings);
    let invalidations = 0;
    const invalidate = () => invalidations++;
    for (const path of paths) store.addChangeListener(path, invalidate);
    Object.assign(store.store.plugins.Plugin000, { backgroundHistory: Array.from({ length: 1000 }, (_, index) => index) });
    assert.equal(invalidations, 0, "background plugin settings must not redraw the catalog");
    store.store.plugins.Plugin000.enabled = true;
    assert.equal(invalidations, 1);
    store.store.plugins.Plugin000 = { enabled: false };
    assert.equal(invalidations, 2, "imported plugin settings must update the catalog");
    store.store.plugins = Object.fromEntries(Object.keys(list).map(name => [name, { enabled: true }]));
    assert.equal(invalidations, 3, "imported settings roots must update the catalog");
});
