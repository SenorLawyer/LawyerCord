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

import { SettingsStore } from "../src/shared/SettingsStore";

test("one plugin's setting updates cannot rebuild every other plugin's settings proxies", () => {
    let allocations = 0;
    const source = readFileSync(process.env.AUDIT_SETTINGS_ISOLATION_SOURCE ?? "src/shared/SettingsStore.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } });
    const module = runInNewContext(`${outputText};exports`, { exports: {}, Proxy: new Proxy(Proxy, { construct(target, args) { allocations++; return Reflect.construct(target, args); } }) });
    const plugins = Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`Plugin${index}`, { count: 0, options: { color: "red" }, history: ["first"] }]));
    const store: SettingsStore<{ plugins: typeof plugins; }> = new module.SettingsStore({ plugins });
    let reads = 0;
    const read = () => { for (const name of Object.keys(plugins)) { assert.equal(store.store.plugins[name].options.color, "red"); assert.equal(store.store.plugins[name].history[0], "first"); reads += 2; } };
    read();
    const warmAllocations = allocations;
    for (let event = 1; event <= 100; event++) { store.store.plugins.Plugin0.count = event; read(); }
    assert.equal(reads, 22_220);
    assert.ok(allocations - warmAllocations <= 200, `${allocations - warmAllocations} proxies allocated after 100 unrelated setting updates`);
});

test("mutations invalidate changed ancestors while preserving sibling object identities", () => {
    const store = new SettingsStore({ plugins: { A: { options: { count: 0 } }, B: { options: { count: 0 } } } });
    const plugins = store.store.plugins;
    const a = plugins.A;
    const options = a.options;
    const b = plugins.B;
    const sibling = b.options;
    a.options.count = 1;
    assert.notEqual(store.store.plugins, plugins);
    assert.notEqual(store.store.plugins.A, a);
    assert.notEqual(store.store.plugins.A.options, options);
    assert.equal(store.store.plugins.B, b);
    assert.equal(store.store.plugins.B.options, sibling);
    assert.equal(store.store.plugins.A.options.count, 1);
    store.store.plugins.A.options = { count: 2 };
    options.count = 3;
    assert.equal(store.store.plugins.A.options.count, 2);
    assert.equal(options.count, 3);
    store.markAsChanged();
    assert.notEqual(store.store.plugins.B, b);
});

test("literal dotted keys and reparented objects retain their actual ancestor identities", () => {
    const nested = { value: 0 };
    const branch = { nested };
    const store = new SettingsStore({ map: { "a.b": branch }, sibling: { value: 0 } });
    const first = store.store.map["a.b"];
    first.nested.value = 1;
    assert.notEqual(store.store.map["a.b"], first);
    const previousMap = store.store.map;
    const oldNested = store.store.map["a.b"].nested;
    store.store.map = { "a.b": branch };
    const currentMap = store.store.map;
    const currentBranch = currentMap["a.b"];
    const currentNested = currentBranch.nested;
    assert.notEqual(currentNested, oldNested, "a shared object moved under a replacement ancestor needs a new ownership path");
    currentNested.value = 2;
    assert.notEqual(store.store.map, currentMap);
    assert.notEqual(store.store.map["a.b"], currentBranch);
    assert.equal(store.store.map["a.b"].nested.value, 2);
    assert.equal(previousMap["a.b"].nested.value, 2);
});
