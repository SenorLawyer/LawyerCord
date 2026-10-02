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

test("Repeated unchanged settings reads allocate proxies once per path", () => {
    let allocations = 0;
    const exports: { SettingsStore?: typeof SettingsStore; } = {};
    const source = transpileModule(readFileSync("src/shared/SettingsStore.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(source, {
        exports,
        console,
        Proxy: new Proxy(Proxy, {
            construct(target, args) {
                allocations++;
                return Reflect.construct(target, args);
            }
        })
    });
    assert.ok(exports.SettingsStore);
    const store = new exports.SettingsStore({ plugins: { Example: { options: { color: "red" } } } });
    for (let index = 0; index < 30_000; index++) {
        assert.equal(store.store.plugins.Example.options.color, "red");
    }
    assert.ok(allocations <= 4, `Unchanged reads allocated ${allocations} proxies`);
});

test("Nested settings references stay stable until a mutation invalidates them", () => {
    const store = new SettingsStore({ plugins: { Example: { list: ["first"], options: { color: "red" } } } });
    const list = store.store.plugins.Example.list;
    const options = store.store.plugins.Example.options;
    assert.equal(store.store.plugins.Example.list, list);
    assert.equal(store.store.plugins.Example.options, options);
    options.color = "blue";
    assert.notEqual(store.store.plugins.Example.options, options);
    assert.equal(store.store.plugins.Example.options.color, "blue");
    store.store.plugins.Example.list.push("second");
    assert.notEqual(store.store.plugins.Example.list, list);
    assert.deepEqual([...store.store.plugins.Example.list], ["first", "second"]);
});

test("Aliases retain their own notification paths after other aliases are read", () => {
    const value = { count: 0 };
    const store = new SettingsStore({ first: value, second: value });
    const paths: string[] = [];
    store.addGlobalChangeListener((_, path) => paths.push(path));
    const first = store.store.first;
    const second = store.store.second;
    first.count = 1;
    second.count = 2;
    Reflect.deleteProperty(store.store.first, "count");
    assert.deepEqual(paths, ["first.count", "second.count", "first.count"]);
});

test("Replacing roots keeps retained references associated with their original root", () => {
    const shared = { count: 0 };
    const firstRoot = { nested: shared };
    const store = new SettingsStore(firstRoot);
    const first = store.store.nested;
    const secondRoot = { nested: shared };
    store.setData(secondRoot);
    const second = store.store.nested;
    const roots: object[] = [];
    store.addGlobalChangeListener(root => roots.push(root));
    first.count = 1;
    second.count = 2;
    assert.equal(roots[0], firstRoot);
    assert.equal(roots[1], secondRoot);
});

test("Explicit plain-data updates invalidate nested React dependency references", () => {
    const store = new SettingsStore({ nested: { count: 0 } });
    const nested = store.store.nested;
    store.plain.nested.count = 1;
    store.markAsChanged();
    assert.notEqual(store.store.nested, nested);
    assert.equal(store.store.nested.count, 1);
});
