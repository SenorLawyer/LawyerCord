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

test("expanded inputs retain their component type when the parent supplies a new render callback", () => {
    let expanded = false;
    let contentCalls = 0;
    const React = { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }) };
    const mocks: Record<string, unknown> = {
        "./ExpandableCard.css": {}, "@utils/misc": { classes: () => "" },
        "./Card": { Card: "card" }, "./Icons": { DownArrow: "down", RightArrow: "right" },
        "@webpack/common": { Clickable: "clickable", useState: () => [expanded, (update: (value: boolean) => boolean) => { expanded = update(expanded); }] }
    };
    const { outputText } = transpileModule(readFileSync("src/components/ExpandableCard.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { ExpandableSection } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const input = function Input() {};
    const render = (value: string) => ExpandableSection({ children: "Edit rule", renderContent: () => {
        contentCalls++;
        return React.createElement(input, { value });
    } });
    const collapsed = render("initial");
    assert.equal(contentCalls, 0);
    assert.equal(collapsed.children[1], null);
    collapsed.children[0].props.onClick();
    const first = render("initial").children[1].children[0];
    const next = render("updated").children[1].children[0];
    assert.equal(first.type, next.type);
    assert.equal(next.type, input);
    assert.equal(next.props.value, "updated");
});
