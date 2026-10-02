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
    let cursor = 0;
    const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void; }[] = [];
    const effects: (() => void)[] = [];
    const pending = new Set<() => Promise<void>>();
    const requests: { signal?: AbortSignal; resolve: (response: unknown) => void; }[] = [];
    const links = new Set<unknown>();
    const debounce = (callback: () => Promise<void>) => {
        const call = Object.assign(() => { pending.add(callback); }, { cancel: () => pending.delete(callback) });
        return call;
    };
    const React = {
        createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }),
        useState: (value: unknown) => {
            const index = cursor++;
            slots[index] ??= { value };
            return [slots[index].value, (next: unknown) => { slots[index].value = next; }];
        },
        useRef: (value: unknown) => {
            const index = cursor++;
            slots[index] ??= { value: { current: value } };
            return slots[index].value;
        },
        useMemo: (factory: () => unknown, deps: unknown[]) => {
            const index = cursor++;
            if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps?.[i]))) slots[index] = { value: factory(), deps };
            return slots[index].value;
        },
        useCallback: (callback: unknown, deps: unknown[]) => React.useMemo(() => callback, deps),
        useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
            const index = cursor++;
            if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps?.[i]))) {
                effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
            }
        }
    };
    const mocks: Record<string, unknown> = {
        "./styles.css": {}, "@api/Settings": { definePluginSettings: (def: unknown) => ({ def, store: {} }), migratePluginSetting: () => {} },
        "@components/Card": { Card: "card" }, "@components/Heading": { HeadingSecondary: "heading", HeadingTertiary: "heading3" },
        "@components/Paragraph": { Paragraph: "paragraph" }, "@shared/debounce": { debounce },
        "@utils/constants": { EquicordDevs: {} }, "@utils/margins": { Margins: {} }, "@utils/misc": { classes: () => "" },
        "@utils/Logger": { Logger: class { warn() {} error() {} } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": { React, TextInput: "input", lodash: { debounce } }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/fontLoader/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, AbortController, CSS: { escape: (value: string) => value },
        fetch: (_url: string, options: { signal?: AbortSignal; }) => new Promise(resolve => requests.push({ signal: options.signal, resolve })),
        document: { createElement: () => { const link = { remove: () => links.delete(link) }; return link; }, head: { appendChild: (link: unknown) => links.add(link) } },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const component = plugin.settings.def.fontSearch.component();
    return {
        requests, pending, links,
        render() {
            cursor = 0;
            const node = component.type(component.props);
            effects.splice(0).forEach(effect => effect());
            return node;
        },
        start() { const callbacks = [...pending]; pending.clear(); return callbacks.map(callback => callback()); },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); }
    };
}

test("font searches abort on replacement and unmount and discard stale completions", async () => {
    const view = fixture();
    view.render().children[2].props.onChange("first");
    view.render();
    const first = view.start();
    assert.equal(view.requests.length, 1);
    view.render().children[2].props.onChange("second");
    view.render();
    assert.equal(view.requests[0].signal?.aborted, true);
    const second = view.start();
    view.requests[0].resolve({ ok: true, json: async () => [null, [["id", ["First", "First", ["Author"], null, null, null, []]]]] });
    await Promise.all(first);
    assert.equal(view.links.size, 0);
    view.requests[1].resolve({ ok: true, json: async () => [null, [["id", ["Second", "Second", ["Author"]]], ["bad", [null, {}, []]]]] });
    await Promise.all(second);
    assert.equal(view.links.size, 1);
    const input = view.render().children[2];
    assert.notEqual(input.props.disabled, true);
    input.props.onChange("third");
    view.render();
    const third = view.start();
    view.unmount();
    assert.equal(view.requests[2].signal?.aborted, true);
    assert.equal(view.links.size, 0);
    view.requests[2].resolve({ ok: true, json: async () => [null, [["id", ["Third", "Third", []]]]] });
    await Promise.all(third);
    assert.equal(view.links.size, 0);
});

test("font search cleanup cancels a pending debounce before it starts a request", () => {
    const view = fixture();
    view.render().children[2].props.onChange("pending");
    view.render();
    view.unmount();
    assert.equal(view.pending.size, 0);
    assert.equal(view.start().length, 0);
    assert.equal(view.requests.length, 0);
});
