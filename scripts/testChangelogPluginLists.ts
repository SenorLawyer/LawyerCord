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

interface Element {
    type: string;
    props: Record<string, unknown>;
    children: unknown[];
}

function fixture() {
    const cleanups: (() => void)[] = [];
    let updates = 0;
    let dependencyReads = 0;
    const store = new SettingsStore({ plugins: {
        Visible: { enabled: false, value: 0 }, Other: { enabled: false },
        Consumer: { enabled: false }, Unrelated: { enabled: false, value: 0 }
    }, theme: "dark" });
    const React = {
        Fragment: "fragment",
        useMemo: (factory: () => unknown) => factory(),
        useReducer: () => [null, () => updates++],
        createElement(type: string | ((props: Record<string, unknown>) => unknown), props: Record<string, unknown> | null, ...children: unknown[]) {
            const elementProps = { ...props, children: children.length === 1 ? children[0] : children };
            return typeof type === "function" ? type(elementProps) : { type, props: elementProps, children };
        }
    };
    const useEffect = (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); };
    const settingsSource = readFileSync("src/api/Settings.ts", "utf8").replaceAll("\r\n", "\n");
    const start = settingsSource.indexOf("export function useSettings(");
    const end = settingsSource.indexOf("\n}", start) + 2;
    assert.ok(start >= 0 && end > start);
    const options = { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React };
    const useSettings = runInNewContext(transpileModule(settingsSource.slice(start, end), { compilerOptions: options }).outputText + "\nexports.useSettings;", {
        exports: {}, React, useEffect, SettingsStore: store
    });
    const source = readFileSync(process.env.AUDIT_CHANGELOG_PLUGINS_SOURCE ?? "src/components/settings/tabs/changelog/NewPluginsSection.tsx", "utf8");
    const exports: { NewPluginsCompact?: (props: { newPlugins: string[]; maxDisplay?: number; }) => unknown; NewPluginsSection?: (props: { newPlugins: string[]; }) => unknown; } = {};
    const plugins = {
        Visible: { name: "Visible", description: "Visible plugin", authors: [] },
        Other: { name: "Other", authors: [] }, Hidden: { name: "Hidden", hidden: true },
        Consumer: { name: "Consumer", get dependencies() { dependencyReads++; return ["Visible"]; } }
    };
    runInNewContext(transpileModule(source, { compilerOptions: options }).outputText, {
        exports, require(name: string) {
            if (name === "~plugins") return { __esModule: true, default: plugins };
            if (name === "@api/Settings") return { useSettings };
            if (name === "@utils/lazy") return { makeLazy: (factory: () => unknown) => { let value: unknown; return () => value ??= factory(); } };
            if (name === "@utils/css") return { classNameFactory: (prefix: string) => (...values: string[]) => values.map(value => prefix + value).join(" ") };
            if (name === "@utils/ChangeList") return { ChangeList: class { hasChanges = false; } };
            if (name === "@utils/margins") return { Margins: {} };
            if (name === "@utils/react") return { useForceUpdater: () => () => updates++ };
            if (name === "@webpack/common") return { React, Tooltip: (props: { children: (handlers: object) => unknown; }) => props.children({}) };
            const component = name.split("/").at(-1);
            return { [component ?? ""]: component };
        }
    });
    assert.ok(exports.NewPluginsCompact);
    assert.ok(exports.NewPluginsSection);
    const compact = exports.NewPluginsCompact;
    const section = exports.NewPluginsSection;
    return {
        store, updates: () => updates, dependencyReads: () => dependencyReads,
        compact(names: string[], maxDisplay = 20) { cleanups.splice(0).forEach(fn => fn()); return compact({ newPlugins: names, maxDisplay }); },
        section(names: string[]) { cleanups.splice(0).forEach(fn => fn()); return section({ newPlugins: names }); },
        unmount() { cleanups.splice(0).forEach(fn => fn()); }
    };
}

function elements(tree: unknown): Element[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== "object" || !("children" in tree)) return [];
    const element = tree as Element;
    return [element, ...elements(element.children)];
}

test("Changelog plugin lists ignore unrelated settings while tracking displayed flags and dependents", () => {
    for (const mode of ["compact", "section"] as const) {
        const f = fixture(); f[mode](["Visible"]);
        for (let i = 1; i <= 100; i++) f.store.store.plugins.Unrelated.value = i;
        f.store.store.plugins.Visible.value = 1;
        f.store.store.theme = "light";
        assert.equal(f.updates(), 0);
        f.store.store.plugins.Consumer.enabled = true;
        assert.equal(f.updates(), 1);
        const tree = f[mode](["Visible"]);
        assert.ok(elements(tree).some(element => String(element.props.className).includes("required")));
        f.store.store.plugins.Visible.enabled = true;
        assert.equal(f.updates(), 2);
        f.unmount(); f.store.store.plugins.Consumer.enabled = false;
        assert.equal(f.updates(), 2);
    }
});

test("Compact changelog lists filter missing and hidden entries before their display limit", () => {
    const f = fixture();
    const tree = f.compact(["Missing", "Hidden", "Visible", "Other", "Consumer"], 1);
    const nodes = elements(tree);
    assert.ok(nodes.some(node => node.children.includes("Visible")));
    assert.ok(nodes.some(node => node.children.includes(2) && node.children.includes(" more plugins")));
    assert.equal(f.compact(["Missing", "Hidden"]), null);
    f.unmount();
});

test("Changelog lists share one deferred dependency-map build across history entries", () => {
    const f = fixture();
    assert.equal(f.dependencyReads(), 0);
    f.section(["Visible"]);
    f.compact(["Visible"]);
    f.compact(["Other"]);
    assert.equal(f.dependencyReads(), 1);
    f.unmount();
});
