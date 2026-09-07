/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

const themePath = "src/components/settings/tabs/themes/index.tsx";
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const before = baseline ? execFileSync("git", ["show", `${baseline}:${themePath}`], { encoding: "utf8" }) : undefined;
const after = readFileSync(themePath, "utf8");

function compile(source: string) {
    return transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
}

function projection(source: string, context: Record<string, unknown>) {
    const start = source.indexOf("    const allThemes");
    const end = source.indexOf("    const localCount", start);
    assert.ok(start >= 0 && end > start);
    return JSON.parse(JSON.stringify(runInNewContext(compile(source.slice(start, end)) + "\n({allThemes, filteredThemes})", {
        ...context,
        useMemo: (fn: () => unknown) => fn(),
        ThemeFilter: { All: "all", Online: "online", Local: "local", Enabled: "enabled", Disabled: "disabled" }
    })));
}

test("Theme projections preserve filtering and ordering with live nested settings", () => {
    const store = new SettingsStore({
        themeNames: { "https://theme.invalid/a": "Custom name" },
        enabledThemeLinks: ["https://theme.invalid/a"],
        enabledThemes: ["local.css"],
        themeActivationModes: { "local.css": "dark" },
        pinnedThemes: ["local.css", "https://theme.invalid/a"]
    });
    const settings = store.store;
    assert.notEqual(settings.pinnedThemes, settings.pinnedThemes);
    let comparisons = 0;
    for (const onlineThemes of [null, [], [{ link: "https://theme.invalid/a", name: "Online", fileName: "a.css" }]]) {
        for (const userThemes of [null, [], [{ name: "Local", fileName: "local.css" }]]) {
            for (const filter of ["all", "online", "local", "enabled", "disabled"]) {
                for (const searchQuery of ["", "Custom", "LOCAL", "missing"]) {
                    for (const pins of [[], ["local.css"], ["https://theme.invalid/a", "local.css"]]) {
                        settings.pinnedThemes = pins;
                        const context = { settings, themeNames: settings.themeNames, onlineThemes, userThemes, filter, searchQuery };
                        const result = projection(after, context);
                        if (before) assert.deepEqual(result, projection(before, context));
                        const expectedNames: string[] = [];
                        if (onlineThemes?.length && filter !== "local" && filter !== "disabled" && ["", "Custom"].includes(searchQuery))
                            expectedNames.push("Custom name");
                        if (userThemes?.length && filter !== "online" && filter !== "disabled" && ["", "LOCAL"].includes(searchQuery))
                            expectedNames.push("Local");
                        assert.deepEqual(result.filteredThemes.map((theme: { name: string; }) => theme.name).sort(), expectedNames.sort());
                        assert.equal(result.allThemes.length, (onlineThemes?.length ?? 0) + (userThemes?.length ?? 0));
                        if (result.filteredThemes.length === 2)
                            assert.equal(result.filteredThemes[0].name, pins[0] === "local.css" ? "Local" : "Custom name");
                        comparisons++;
                    }
                }
            }
        }
    }
    settings.themeNames["https://theme.invalid/a"] = "Renamed";
    const result = projection(after, { settings, onlineThemes: [{ link: "https://theme.invalid/a", fileName: "a.css" }], userThemes: [], filter: "all", searchQuery: "Renamed" });
    assert.equal(result.filteredThemes[0].name, "Renamed");
    assert.equal(comparisons, 540);
});

test("Plugin pagination cancels delayed work and loads fixed batches", () => {
    const source = readFileSync("src/components/settings/tabs/plugins/index.tsx", "utf8");
    const start = source.indexOf("    const [visibleCount, setVisibleCount]");
    const end = source.indexOf("    const visiblePlugins", start);
    assert.ok(start >= 0 && end > start);
    const code = compile(source.slice(start, end));
    let visibleCount = 36;
    let cleanup: (() => void) | undefined;
    const timers = new Map<number, () => void>();
    let timerId = 0;
    function render(length: number, visible: boolean) {
        cleanup?.();
        runInNewContext(code, {
            plugins: Array.from({ length }),
            useState: () => [visibleCount, (update: (value: number) => number) => { visibleCount = update(visibleCount); }],
            useIntersection: () => [null, visible],
            React: { useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); } },
            setTimeout: (callback: () => void, delay: number) => {
                assert.equal(delay, 100);
                timers.set(++timerId, callback);
                return timerId;
            },
            clearTimeout: (id: number) => timers.delete(id)
        });
    }
    render(100, true);
    assert.equal(timers.size, 1);
    render(100, false);
    assert.equal(timers.size, 0);
    assert.equal(visibleCount, 36);
    render(100, true);
    for (const callback of timers.values()) callback();
    assert.equal(visibleCount, 72);
    render(80, true);
    for (const callback of timers.values()) callback();
    assert.equal(visibleCount, 80);
    render(80, true);
    assert.equal(timers.size, 0);
    render(200, true);
    cleanup?.();
    assert.equal(timers.size, 0);
});


test("settings subscriptions depend on path values and clean up original paths", () => {
    const source = readFileSync("src/api/Settings.ts", "utf8").replaceAll("\r\n", "\n");
    const start = source.indexOf("export function useSettings(");
    const end = source.indexOf("\n}", start) + 2;
    assert.ok(start >= 0 && end > start);
    const store = new SettingsStore({ first: 0, second: 0, nested: { value: 0 } });
    let subscriptions = 0;
    let updates = 0;
    let previous: unknown[] | undefined;
    let cleanup: (() => void) | undefined;
    const update = () => updates++;
    const settingsStore = {
        store: store.store,
        addChangeListener: (path: "first" | "second", callback: () => void) => { subscriptions++; store.addChangeListener(path, callback); },
        removeChangeListener: (path: "first" | "second", callback: () => void) => store.removeChangeListener(path, callback),
        addPrefixChangeListener: (path: string, callback: () => void) => { subscriptions++; store.addPrefixChangeListener(path, callback); },
        removePrefixChangeListener: (path: string, callback: () => void) => store.removePrefixChangeListener(path, callback),
        addGlobalChangeListener: (callback: () => void) => { subscriptions++; store.addGlobalChangeListener(callback); },
        removeGlobalChangeListener: (callback: () => void) => store.removeGlobalChangeListener(callback)
    };
    const exports: { useSettings?: (paths?: string[]) => unknown; } = {};
    runInNewContext(compile(source.slice(start, end)), {
        exports, SettingsStore: settingsStore, React: { useReducer: () => [null, update] },
        useEffect: (effect: () => () => void, deps: unknown[]) => {
            if (previous && deps.length === previous.length && deps.every((value, index) => Object.is(value, previous?.[index]))) return;
            cleanup?.();
            cleanup = effect();
            previous = [...deps];
        }
    });
    assert.ok(exports.useSettings);
    const paths = ["first"];
    exports.useSettings(paths);
    exports.useSettings(["first"]);
    assert.equal(subscriptions, 1);
    store.store.first++;
    assert.equal(updates, 1);
    paths[0] = "second";
    exports.useSettings(paths);
    store.store.first++;
    assert.equal(updates, 1);
    store.store.second++;
    assert.equal(updates, 2);
    exports.useSettings(["nested.*"]);
    store.store.nested.value++;
    assert.equal(updates, 3);
    exports.useSettings([]);
    store.store.nested.value++;
    assert.equal(updates, 3);
    exports.useSettings();
    store.store.first++;
    assert.equal(updates, 4);
    cleanup?.();
    store.store.first++;
    assert.equal(updates, 4);
});
