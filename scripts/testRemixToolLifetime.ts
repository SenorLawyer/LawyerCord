/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

test("Remix crop removes listeners after its canvas has unmounted", () => {
    const listeners = new Map<string, Set<unknown>>();
    const surface = { canvas: { width: 100, height: 100 }, cropCanvas: new Proxy({}, { get: () => () => {} }), render() {} };
    const code = transformSync(readFileSync("src/equicordplugins/remix/editor/tools/crop.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const tool = runInNewContext(`${code};module.exports.CropTool`, { module: { exports: {} }, require: (name: string) => name.endsWith("/input") ? { Mouse: { event: {
        on: (name: string, callback: unknown) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)?.add(callback); },
        off: (name: string, callback: unknown) => listeners.get(name)?.delete(callback)
    } } } : name.endsWith("/Canvas") ? surface : { fillCircle() {} } });
    tool.selected();
    assert.equal(listeners.get("move")?.size, 1);
    Object.assign(surface, { canvas: null });
    tool.unselected();
    assert.equal(listeners.get("move")?.size, 0);
    assert.equal(listeners.get("up")?.size, 0);
});

test("Remix toolbar unmount releases the selected tool between editor sessions", () => {
    let subscriptions = 0;
    const tool = { selected() { subscriptions++; }, unselected() { subscriptions--; } };
    const states: unknown[] = [];
    const effects: Array<() => void | (() => void)> = [];
    let cursor = 0;
    type Node = { props: { children: unknown[]; onClick?: () => void } };
    const React = { createElement: (_type: unknown, props: object, ...children: unknown[]): Node => ({ props: { ...props, children } }) };
    const code = transformSync(readFileSync("src/equicordplugins/remix/editor/components/Toolbar.tsx", "utf8"), { loader: "tsx", format: "cjs" }).code;
    const component = runInNewContext(`${code};module.exports.Toolbar`, { module: { exports: {} }, React, require: (name: string) => {
        if (name === "@webpack/common") return {
            useState: (initial: unknown) => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], (value: unknown) => { states[index] = value; }]; },
            useEffect: (effect: () => void | (() => void)) => { effects.push(effect); }
        };
        if (name.endsWith("/shape")) return { ShapeTool: tool, setShapeFill() {} };
        if (name === "./Canvas") return { brushCanvas: {}, shapeCanvas: {} };
        return {};
    } });
    for (let session = 0; session < 20; session++) {
        cursor = 0;
        states.length = 0;
        effects.length = 0;
        const tree: Node = component();
        const cleanups = effects.map(effect => effect());
        const clickShape = (node: Node): void => {
            if (node.props.children.includes("Shape")) node.props.onClick?.();
            for (const child of node.props.children) if (typeof child === "object" && child !== null && "props" in child) clickShape(child as Node);
        };
        clickShape(tree);
        assert.equal(subscriptions, 1);
        cursor = 0;
        effects.length = 0;
        component();
        effects.forEach(effect => effect());
        for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
        assert.equal(subscriptions, 0);
    }
});
