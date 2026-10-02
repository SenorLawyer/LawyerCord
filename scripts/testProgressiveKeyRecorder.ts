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

test("Keyboard recorder cleans up duplicate clicks, unmount and plugin stop", () => {
    const listeners = new Map<string, Set<(event: { key: string; }) => void>>();
    const effects: (() => (() => void) | void)[] = [];
    const clicks: (() => void)[] = [];
    const code = transpileModule(readFileSync("src/equicordplugins/keyboardNavigation/index.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const loaded = runInNewContext(code + "\nexports;", {
        exports: {}, IS_DEV: false, React: { createElement: (_tag: unknown, props?: { onClick?: () => void; }) => { if (props?.onClick) clicks.push(props.onClick); return null; } },
        document: {
            querySelector: () => ({}), addEventListener: (name: string, fn: (event: { key: string; }) => void) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
            removeEventListener: (name: string, fn: (event: { key: string; }) => void) => listeners.get(name)?.delete(fn)
        },
        require(name: string) {
            if (name === "@webpack/common") return { useState: () => [false, () => {}], useEffect: (effect: () => (() => void) | void) => effects.push(effect) };
            if (name === "@api/Settings") return { definePluginSettings: (def: unknown) => ({ def, store: { hotkey: ["ctrl", "p"] } }) };
            if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value, OptionType: {} };
            if (name === "@utils/css") return { classNameFactory: () => () => "fixture" };
            return { Devs: {} };
        }
    });
    loaded.settings.def.hotkey.component();
    const cleanup = effects[0]?.();
    clicks[0]();
    clicks[0]();
    assert.equal(listeners.get("keydown")?.size, 1);
    for (const listener of listeners.get("keyup") ?? []) listener({ key: "Shift" });
    assert.equal(listeners.get("keydown")?.size, 0);
    clicks[0]();
    cleanup?.();
    assert.equal(listeners.get("keyup")?.size, 0);
    clicks[0]();
    loaded.default.stop();
    assert.equal(listeners.get("keydown")?.size, 0);
    assert.equal(listeners.get("keyup")?.size, 0);
});
