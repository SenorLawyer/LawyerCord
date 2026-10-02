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

interface Node {
    type: string;
    props: Record<string, unknown>;
    children: Node[];
}

function fixture(type: "number" | "bigint", validator?: (this: object, value: string) => boolean | string) {
    let cursor = 0;
    const slots: unknown[] = [];
    const changes: unknown[] = [];
    const settings = { id: "Settings owner" };
    const React = {
        createElement: (type: string, props: Node["props"], ...children: Node[]) => ({ type, props, children }),
        useState: (value: unknown) => {
            const index = cursor++;
            if (index >= slots.length) slots[index] = value;
            return [slots[index], (next: unknown) => { slots[index] = next; }];
        }
    };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: "number", BIGINT: "bigint" } },
        "@webpack/common": { React, ...React, TextInput: "input" },
        "./Common": { SettingsSection: "section", resolveError: (value: boolean | string) => typeof value === "string" ? value : value ? null : "Invalid input provided" }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_NUMBER_SOURCE ?? "src/components/settings/tabs/plugins/components/NumberSetting.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { NumberSetting } = runInNewContext(`${outputText}\nexports;`, { exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
    let input: Node;
    return { changes, settings,
        render() {
            cursor = 0;
            const node: Node = NumberSetting({ setting: { type, default: type === "number" ? 5 : 1026532993923293184n, isValid: validator },
                id: "value", pluginSettings: {}, definedSettings: settings, onChange: (value: unknown) => changes.push(value) });
            input = node.children[0];
            return node;
        },
        change(value: string) { (input.props.onChange as (value: string) => void)(value); }
    };
}

test("bigint settings retain precise values and recover from intermediate and decimal input", () => {
    const f = fixture("bigint"); f.render();
    for (const value of ["-", "+", "1.", "1.5", "1e2", "", " "]) {
        assert.doesNotThrow(() => f.change(value));
        const node = f.render();
        assert.ok(node.props.error, value);
        assert.equal(node.children[0].props.value, value);
        assert.equal(f.changes.length, 0, value);
    }
    f.change("1026532993923293184");
    assert.equal(f.changes[0], 1026532993923293184n);
    assert.equal(f.render().props.error, null);
    f.change("-42"); f.change("0");
    assert.deepEqual(f.changes, [1026532993923293184n, -42n, 0n]);
});

test("bigint input avoids native floating point number stepping", () => {
    const f = fixture("bigint");
    const { props } = f.render().children[0];
    assert.equal(props.type, "text");
    assert.equal(props.inputMode, "numeric");
    assert.equal(props.value, "1026532993923293184");
});

test("number settings reject blank, incomplete and non-finite values without losing edits", () => {
    const f = fixture("number"); f.render();
    for (const value of ["", " ", "-", "1e", "1e999", "NaN", "Infinity"]) {
        f.change(value);
        const node = f.render();
        assert.equal(f.changes.length, 0, value);
        assert.ok(node.props.error, value);
        assert.equal(node.children[0].props.value, value);
    }
    for (const value of ["0", "-1.5", ".25", "1e2"]) { f.change(value); f.render(); }
    assert.deepEqual(f.changes, [0, -1.5, 0.25, 100]);
});

test("numeric validators retain their raw input and settings receiver contract", () => {
    const inputs: string[] = [];
    const receivers: object[] = [];
    const f = fixture("number", function (value) { inputs.push(value); receivers.push(this); return Number(value) >= 3 || "Must be three or greater."; });
    f.render(); f.change("2");
    assert.equal(f.render().props.error, "Must be three or greater.");
    assert.equal(f.changes.length, 0);
    f.change("3.5");
    assert.equal(f.render().props.error, null);
    assert.deepEqual(f.changes, [3.5]);
    assert.deepEqual(inputs, ["2", "3.5"]);
    assert.equal(receivers[0], f.settings);
});
