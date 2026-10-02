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

interface Element {
    type: string | ((props: Record<string, unknown>) => unknown);
    props: Record<string, unknown>;
    children: unknown[];
}

test("Changing enabled popover factories preserves each component's hook ownership", () => {
    let owner = "";
    const hooks: string[] = [];
    const enabled: Record<string, { enabled: boolean; }> = {};
    const createElement = (type: Element["type"], props: Element["props"] | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
    const { outputText } = transpileModule(readFileSync("src/api/MessagePopover.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, createElement, Fragment: "fragment",
        require: (id: string) => {
            if (id === "./Settings") return { useSettings: () => { hooks.push(owner); return { uiElements: { messagePopoverButtons: enabled } }; } };
            if (id === "@components/ErrorBoundary") return { default: "boundary" };
            if (id === "@utils/Logger") return { Logger: class { error(error: unknown) { throw error; } } };
            throw new Error(`Unexpected module ${id}`);
        }
    }) as { addMessagePopoverButton(id: string, factory: () => unknown, icon: unknown): void; _buildPopoverElements(component: unknown, message: unknown): Element; };
    function render(value: unknown, path = "root"): void {
        if (value == null) return;
        if (Array.isArray(value)) { value.forEach((child, index) => render(child, `${path}/${index}`)); return; }
        const element = value as Element;
        if (typeof element.type === "function") {
            const previousOwner = owner;
            owner = `${path}/${element.type.name}`;
            const result = element.type(element.props);
            owner = previousOwner;
            render(result, `${path}/${element.type.name}`);
        } else {
            element.children.forEach((child, index) => render(child, `${path}/${index}`));
        }
    }
    const factoryOwners: string[] = [];
    for (const id of ["first", "second"]) {
        api.addMessagePopoverButton(id, () => {
            hooks.push(owner);
            factoryOwners.push(owner);
            return { label: id, icon: "icon", message: {}, channel: {} };
        }, "icon");
    }
    render(api._buildPopoverElements(() => null, {}));
    assert.equal(factoryOwners.length, 2);
    assert.notEqual(factoryOwners[0], factoryOwners[1]);
    assert.ok(factoryOwners.every(value => !value.endsWith("/VencordPopoverButtons")), "Factories consume the parent component's hooks");
    assert.equal(hooks.filter(value => value.endsWith("/VencordPopoverButtons")).length, 1);
    hooks.length = 0;
    enabled.first = { enabled: false };
    render(api._buildPopoverElements(() => null, {}));
    assert.equal(hooks.filter(value => value.endsWith("/VencordPopoverButtons")).length, 1);
});
