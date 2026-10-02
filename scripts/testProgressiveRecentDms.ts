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

test("Recent DM switcher cannot install listeners after stop during history loading", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/recentDMSwitcher/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    let finish: (value: string[]) => void = () => {};
    const history = new Promise<string[]>(resolve => finish = resolve);
    const listeners = new Set<unknown>();
    const modules: Record<string, unknown> = {
        "@api/DataStore": { get: () => history },
        "@api/Settings": { definePluginSettings: () => ({ store: { amountOfUsers: 20 } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, makeRange: () => [] },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => undefined } }
    };
    const plugin = runInNewContext(`${source};exports.default`, {
        exports: {}, require: (name: string) => modules[name] ?? {},
        document: { addEventListener: (_name: string, listener: unknown) => listeners.add(listener), removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener) }
    });
    for (let cycle = 0; cycle < 100; cycle++) {
        const start = plugin.start();
        plugin.stop();
        finish([]);
        await start;
        assert.equal(listeners.size, 0);
    }
});
