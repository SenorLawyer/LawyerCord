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

function fixture() {
    const reads: ((value: object[]) => void)[] = [];
    let writes = 0;
    let updates = 0;
    const saved: object[] = [];
    const menuSnapshots: unknown[] = [];
    const cleanups: (() => void)[] = [];
    const interceptors: unknown[] = [];
    const modules: Record<string, unknown> = {};
    for (const name of ["./style.css", "@components/Button", "@components/Flex", "@components/FormSwitch", "@components/Heading", "@components/Icons", "@utils/constants", "@utils/margins", "@utils/misc", "@utils/react"])
        modules[name] = {};
    Object.assign(modules, {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/misc": { classes: () => "keyword" },
        "@components/ErrorBoundary": {},
        "@api/index": { DataStore: {
            get: (key: string) => key.endsWith("keywordEntries") ? new Promise(resolve => reads.push(resolve)) : Promise.resolve([JSON.stringify({ id: "saved", timestamp: 1 })]),
            set: async (_key: string, value: object) => { writes++; saved.push(JSON.parse(JSON.stringify(value))); }
        } },
        "@api/Settings": { definePluginSettings: () => ({ store: { amountToKeep: 50 } }) },
        "@utils/css": { classNameFactory: () => () => "keyword" },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}), findByCodeLazy: () => (message: object) => message },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({}) }, SelectedChannelStore: { getChannelId: () => "channel" },
            useState: (value: unknown) => [value, (next: unknown) => { updates++; menuSnapshots.push(next); }],
            useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
            FluxDispatcher: { _interceptors: interceptors, addInterceptor: (fn: unknown) => interceptors.push(fn) },
            UserStore: { getCurrentUser: () => ({ id: "self" }) }
        }
    });
    const code = transpileModule(readFileSync("src/equicordplugins/keywordNotify/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(`${code}\n({plugin: exports.default, size: () => keywordLog.length, addKeywordEntry, loadKeywordEntries});`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, console: { error() {} },
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) }
    });
    return { api, reads, interceptors, cleanups, saved, menuSnapshots, writes: () => writes, updates: () => updates };
}

test("keyword startup cannot install an interceptor after being stopped", async () => {
    const f = fixture(); const pending = f.api.plugin.start();
    f.api.plugin.stop(); f.reads[0]([]); await pending;
    assert.equal(f.interceptors.length, 0); assert.equal(f.api.size(), 0); assert.equal(f.writes(), 0);
});

test("keyword menus release callbacks without detaching a newer menu", async () => {
    const f = fixture(); const starting = f.api.plugin.start(); f.reads[0]([]); await starting;
    const mount = () => {
        const tree = f.api.plugin.tryKeywordMenu(() => {});
        const menu = tree.children[0];
        menu.type(menu.props);
    };
    mount(); mount();
    const before = f.updates();
    f.cleanups[0](); f.api.plugin.onUpdate(); assert.equal(f.updates(), before + 1);
    f.cleanups[1](); f.api.plugin.onUpdate(); assert.equal(f.updates(), before + 1);
    mount(); f.api.plugin.stop(); f.api.plugin.onUpdate();
    assert.equal(f.updates(), before + 3);
    assert.equal((f.menuSnapshots.at(-1) as unknown[]).length, 0);
});

test("keyword stop releases saved message records and later starts supersede older reads", async () => {
    const f = fixture(); const first = f.api.plugin.start(); f.reads[0]([]); await first;
    assert.equal(f.api.size(), 1); assert.equal(f.interceptors.length, 1);
    f.api.plugin.stop(); assert.equal(f.api.size(), 0); assert.equal(f.interceptors.length, 0);
    const old = f.api.plugin.start(); f.api.plugin.stop(); const current = f.api.plugin.start();
    await current; await old;
    assert.equal(f.interceptors.length, 1); assert.equal(f.api.size(), 1); assert.equal(f.writes(), 0);
});

test("keyword configuration survives stop and edits preserve previously saved rules", async () => {
    const f = fixture();
    const loading = f.api.loadKeywordEntries();
    f.reads[0]([{ regex: "saved", listIds: [], listType: "BlackList", ignoreCase: false }]);
    await loading;
    const starting = f.api.plugin.start(); await starting;
    f.api.plugin.stop();
    await f.api.addKeywordEntry(() => {});
    assert.equal((f.saved.at(-1) as { regex: string }[])[0].regex, "saved");
    assert.equal((f.saved.at(-1) as object[]).length, 2);
    assert.equal(f.interceptors.length, 0);
    assert.equal(f.api.size(), 0);
});
