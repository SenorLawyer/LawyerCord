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

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    return runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }, ...globals
    });
}

function pending<T>() {
    let resolve: (value: T) => void = () => assert.fail("Promise not initialized");
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test("stopped and superseded palette starts cannot install handlers or register commands", async () => {
    const loads: ReturnType<typeof pending<void>>[] = [];
    let listeners = 0;
    let registrations = 0;
    let handlers = 0;
    const hydrate = () => { const next = pending<void>(); loads.push(next); return next.promise; };
    const { default: plugin } = load("src/equicordplugins/commandPalette/index.tsx", {
        "./style.css": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "./api/registry": { clearRegistry: () => { registrations = 0; } },
        "./commands": { registerBuiltinCommands: () => { registrations++; }, loadCustomCommands: async () => {} },
        "./settings": {}, "./state/aliases": { loadAliases: async () => {} },
        "./state/frecency": { loadFrecency: hydrate }, "./state/hotkeys": { loadHotkeys: async () => {} },
        "./state/pins": { loadPins: async () => {} },
        "./ui/keyboard": {
            installKeyboardListeners: () => { listeners++; }, removeKeyboardListeners: () => { listeners = 0; handlers = 0; },
            setGlobalKeyHandler: () => { handlers++; }
        }, "./ui/openPalette": { closePalette: () => {} }
    });
    const first = plugin.start();
    plugin.stop();
    loads[0].resolve();
    await first;
    assert.equal(registrations, 0);
    assert.equal(listeners, 0);
    const obsolete = plugin.start();
    plugin.stop();
    const current = plugin.start();
    loads[2].resolve();
    await current;
    loads[1].resolve();
    await obsolete;
    assert.equal(registrations, 1);
    assert.equal(listeners, 1);
    assert.equal(handlers, 1);
    plugin.stop();
});

test("palette hydration cannot replace an edit or the result of a newer read", async () => {
    const reads: ReturnType<typeof pending<string>>[] = [];
    const { createPersistedValue } = load("src/equicordplugins/commandPalette/state/persist.ts", {
        "@api/DataStore": {
            get: () => { const next = pending<string>(); reads.push(next); return next.promise; }, set: async () => {}
        },
        "../api/registry": { notifyPaletteChange: () => {} },
        "@utils/Logger": { Logger: class { error() {} } }
    });
    const value = createPersistedValue("test", "default");
    const initial = value.load();
    value.set("edited");
    reads[0].resolve("old");
    await initial;
    assert.equal(value.get(), "edited");
    const older = value.load();
    const newer = value.load();
    reads[2].resolve("newer");
    await newer;
    reads[1].resolve("older");
    await older;
    assert.equal(value.get(), "newer");
});

test("attachment previews release their own URLs even when an image never decodes", () => {
    const active = new Set<string>();
    let nextId = 0;
    let imageDecodes = 0;
    let state: unknown[] = [];
    let cleanup: (() => void) | undefined;
    let filesDependency: unknown;
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const { MessageMarkdownPreview } = load("src/equicordplugins/commandPalette/ui/MessageMarkdownPreview.tsx", {
        "@api/Commands": { generateId: () => "id" }, "@components/ErrorBoundary": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/react": { LazyComponent: () => () => null },
        "@webpack": { findByCodeLazy: () => () => ({}) },
        "@webpack/common": {
            useState: () => [state, (next: unknown[] | ((prev: unknown[]) => unknown[])) => { state = typeof next === "function" ? next(state) : next; }],
            useRef: (initial: unknown) => ({ current: initial }), useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => (() => void), deps: unknown[]) => {
                if (filesDependency === deps[0]) return;
                cleanup?.(); filesDependency = deps[0]; cleanup = effect();
            },
            SelectedChannelStore: { getChannelId: () => "channel" }, UserStore: { getCurrentUser: () => ({ id: "self", username: "self" }) },
            moment: () => ({})
        }
    }, {
        React,
        Image: class { constructor() { imageDecodes++; } },
        URL: {
            createObjectURL: () => { const url = `blob:${++nextId}`; active.add(url); return url; },
            revokeObjectURL: (url: string) => { active.delete(url); }
        }
    });
    const firstFiles = [{ name: "image.png", type: "image/png", size: 1 }, { name: "video.mp4", type: "video/mp4", size: 1 }];
    MessageMarkdownPreview({ content: "", files: firstFiles });
    assert.equal(active.size, 2);
    cleanup?.();
    assert.equal(active.size, 0);
    assert.equal(imageDecodes, 0);
    MessageMarkdownPreview({ content: "", files: [{ name: "other.txt", type: "text/plain", size: 1 }] });
    assert.equal(active.size, 1);
    cleanup?.();
    assert.equal(active.size, 0);
});
