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
    type: unknown;
    props: Record<string, unknown>;
    children: Element[];
}

function load(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const exports: Record<string, unknown> = {};
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    runInNewContext(code, { exports, require: (name: string) => modules[name] ?? {}, ...globals });
    return exports;
}

function fixture() {
    let cursor = 0;
    let dirty = false;
    let mounted = true;
    let now = 0;
    let nextTimer = 0;
    let rows = 0;
    let scans = 0;
    let renders = 0;
    const slots: { value: unknown; deps?: unknown[]; cleanup?: () => void; set?: (value: unknown) => void; }[] = [];
    const effects: (() => void)[] = [];
    const timers = new Map<number, { at: number; callback: () => void; }>();
    const lodash = {
        debounce(callback: (value: string) => void, delay: number) {
            let timer: number | undefined;
            const cancel = () => { if (timer !== undefined) timers.delete(timer); timer = undefined; };
            return Object.assign((value: string) => {
                cancel();
                timer = ++nextTimer;
                timers.set(timer, { at: now + delay, callback: () => { timer = undefined; callback(value); } });
            }, { cancel });
        }
    };
    const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
    const createElement = (type: unknown, props: Record<string, unknown>, ...children: Element[]): Element => ({ type, props: props ?? {}, children });
    const React = {
        createElement,
        useState(initial: unknown) {
            const i = cursor++;
            const slot = slots[i] ??= { value: initial };
            slot.set ??= value => {
                assert.ok(mounted, "no state update after unmount");
                if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
            };
            return [slot.value, slot.set];
        },
        useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
            const slot = slots[cursor++] ??= { value: undefined };
            if (!same(slot.deps, deps)) effects.push(() => {
                slot.cleanup?.();
                slot.deps = deps;
                slot.cleanup = effect();
            });
        },
        useMemo(factory: () => unknown, deps: unknown[]) {
            const slot = slots[cursor++] ??= { value: undefined };
            if (!same(slot.deps, deps)) { slot.deps = deps; slot.value = factory(); }
            return slot.value;
        }
    };
    const childReact = {
        createElement(type: unknown, props: Record<string, unknown>, ...children: Element[]) {
            if (typeof type === "function" && type.name === "PickerContentRow") rows++;
            return createElement(type, props, ...children);
        },
        useState: () => [null, () => {}],
        useRef: () => ({ current: null })
    };
    const picker = load("src/equicordplugins/moreStickers/components/picker.tsx", {
        "@webpack/common": { React: childReact, TextInput: "input" },
        "@utils/react": { useAwaiter: () => [[]] },
        "@equicordplugins/moreStickers/utils": { clPicker: () => "" },
        "./icons": { CancelIcon: "clear" }
    }) as { PickerContent: (props: Record<string, unknown>) => Element; PickerHeader: (props: Record<string, unknown>) => Element; };
    let packs = Array.from({ length: 50 }, (_, p) => ({
        id: String(p), title: "Pack", logo: {},
        stickers: Array.from({ length: 100 }, (_, s) => ({
            id: `${p}:${s}`, get title() { scans++; return "matching sticker"; }
        }))
    }));
    const plugin = load("src/equicordplugins/moreStickers/index.tsx", {
        "@webpack/common": { React, lodash },
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/react": { useAwaiter: () => [packs] },
        "./components": { PickerContent: picker.PickerContent, PickerHeader: picker.PickerHeader, PickerSidebar: "sidebar" },
        "./utils": { cl: () => "" }
    }).default as { moreStickersComponent: (props: Record<string, unknown>) => Element; };
    const props = { channel: { id: "channel" }, closePopout() {} };
    let content: Element | undefined;
    let header: Element | undefined;
    function visit(element: Element) {
        if (!element || typeof element !== "object") return;
        if (element.type === picker.PickerHeader) header = element;
        if (element.type === picker.PickerContent && element !== content) {
            content = element;
            renders++;
            picker.PickerContent(element.props);
        }
        element.children?.forEach(visit);
    }
    function render() {
        do {
            dirty = false;
            cursor = 0;
            visit(plugin.moreStickersComponent(props));
            effects.splice(0).forEach(effect => effect());
        } while (dirty);
    }
    render();
    return {
        stats: () => ({ rows, scans, renders }),
        query(value: string) {
            assert.ok(header);
            const change = header.props.onQueryChange;
            assert.equal(typeof change, "function");
            if (typeof change === "function") change(value);
            render();
            assert.equal(header.props.query, value);
        },
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) {
                timers.delete(id);
                timer.callback();
            }
            if (dirty) render();
        },
        clear() {
            assert.ok(header);
            const tree = picker.PickerHeader(header.props);
            function click(element: Element): void {
                if (!element || typeof element !== "object") return;
                if (element.type === "clear" && typeof element.props.onClick === "function") element.props.onClick();
                element.children?.forEach(click);
            }
            click(tree);
            render();
            assert.equal(header.props.query, "");
            assert.equal(content?.props.query, "");
        },
        updatePacks() { packs = [...packs]; render(); },
        unmount() { slots.forEach(slot => slot.cleanup?.()); mounted = false; assert.equal(timers.size, 0); },
        results: () => content?.props.query
    };
}

test("controlled typing coalesces collection scans and row construction", () => {
    const f = fixture();
    const before = f.stats();
    for (let i = 1; i <= 8; i++) { f.query("matching".slice(0, i)); f.advance(50); }
    assert.deepEqual(f.stats(), before);
    f.advance(100);
    assert.equal(f.results(), "matching");
    assert.equal(f.stats().renders - before.renders, 1);
    assert.equal(f.stats().scans - before.scans, 5000);
    assert.equal(f.stats().rows - before.rows, 1700);
    f.updatePacks();
    assert.equal(f.stats().renders - before.renders, 2);
    f.unmount();
});

test("clear is immediate and cancels stale results, including clear then retype", () => {
    const f = fixture();
    f.query("matching"); f.advance(150);
    f.query("missing"); f.advance(50);
    f.clear();
    const cleared = f.stats();
    f.advance(500);
    assert.deepEqual(f.stats(), cleared);
    f.query("sticker");
    assert.equal(f.results(), "");
    f.advance(150);
    assert.equal(f.results(), "sticker");
    f.query("pending");
    f.unmount();
    f.advance(500);
});

test("picker instances do not share search timers", () => {
    const first = fixture();
    const second = fixture();
    first.query("first"); second.query("second");
    first.unmount(); second.advance(150);
    assert.equal(second.results(), "second");
    second.unmount();
});
