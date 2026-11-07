/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("patchWebpack.ts", readFileSync("src/webpack/patchWebpack.ts", "utf8"), ts.ScriptTarget.Latest, true);
let implementation = "";
function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "this.d") implementation = node.right.getText(source);
    ts.forEachChild(node, visit);
}
visit(source);
assert.ok(implementation);
const defineExports: (exports: Record<string, unknown>, getters: Record<string, () => unknown>, values?: Record<string, unknown>) => void = runInNewContext(ts.transpile(`(${implementation})`));

test("legacy exports remain live getters and configurable", () => {
    const exports: Record<string, unknown> = {};
    let value = 1;
    defineExports(exports, { A: () => value });
    value = 2;
    assert.equal(exports.A, 2);
    assert.equal(Object.getOwnPropertyDescriptor(exports, "A")?.configurable, true);
    assert.deepEqual(Object.keys(exports), ["A"]);
});

test("startup can construct a class exported through the third argument", () => {
    class DiscordLogger { }
    const exports: Record<string, unknown> = {};
    defineExports(exports, {}, { A: DiscordLogger, missing: undefined, count: 0 });
    assert.equal(exports.A, DiscordLogger);
    assert.ok(Reflect.construct(exports.A as typeof DiscordLogger, []) instanceof DiscordLogger);
    assert.deepEqual(Object.getOwnPropertyDescriptor(exports, "A"), {
        value: DiscordLogger, enumerable: true, configurable: true, writable: false
    });
    assert.ok(Object.hasOwn(exports, "missing"));
    assert.equal(exports.count, 0);
    Object.defineProperty(exports, "A", { enumerable: false });
    assert.deepEqual(Object.keys(exports), ["missing", "count"]);
});

test("existing exports and getters take precedence over direct values", () => {
    const exports: Record<string, unknown> = { existing: 1 };
    defineExports(exports, { existing: () => 2, shared: () => 3 }, { existing: 4, shared: 5, value: 6 });
    assert.equal(exports.existing, 1);
    assert.equal(exports.shared, 3);
    assert.equal(exports.value, 6);
});

test("inherited definitions are ignored in both export formats", () => {
    const exports: Record<string, unknown> = {};
    defineExports(exports, Object.create({ getter: () => 1 }), Object.create({ value: 2 }));
    assert.deepEqual(Object.keys(exports), []);
});

const runFactorySource = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runFactoryWithWrap")?.getText(source);
assert.ok(runFactorySource);

interface TestModule {
    id: string;
    exports: Record<string, unknown>;
    loaded?: boolean;
}

for (const initialLoaded of [undefined, false]) {
    test(`completed modules become searchable before listeners run, initial loaded=${initialLoaded}`, () => {
        const original = Symbol("original");
        const module: TestModule = { id: "sound-context", exports: {} };
        if (initialLoaded !== undefined) module.loaded = initialLoaded;
        const factory = Object.assign((current: TestModule) => {
            assert.notEqual(current.loaded, true);
            current.exports.sound = "discodo";
            return "finished";
        }, { [original]: undefined as unknown });
        factory[original] = factory;
        let notified = false;
        const runFactory = runInNewContext(ts.transpile(`${runFactorySource}; runFactoryWithWrap;`), {
            SYM_ORIGINAL_FACTORY: original,
            defineInWebpackInstances() { },
            wreq: {},
            moduleListeners: [(exports: Record<string, unknown>) => {
                assert.equal(module.loaded, true);
                assert.equal(exports.sound, "discodo");
                notified = true;
            }],
            waitForSubscriptions: new Map()
        });
        assert.equal(runFactory(factory, null, [module, module.exports, null]), "finished");
        assert.equal(module.loaded, true);
        assert.equal(notified, true);
    });
}

test("a throwing module is not marked as loaded", () => {
    const original = Symbol("original");
    const module: TestModule = { id: "broken", exports: {} };
    const failure = new Error("Factory failed");
    const factory = Object.assign(() => { throw failure; }, { [original]: undefined as unknown });
    factory[original] = factory;
    const runFactory = runInNewContext(ts.transpile(`${runFactorySource}; runFactoryWithWrap;`), {
        SYM_ORIGINAL_FACTORY: original,
        defineInWebpackInstances() { },
        wreq: {}
    });
    assert.throws(() => runFactory(factory, null, [module, module.exports, null]), error => error === failure);
    assert.equal(module.loaded, undefined);
});
