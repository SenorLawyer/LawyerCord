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

test("Chat button visibility changes preserve hook order", () => {
    let hooks = 0;
    const code = transpileModule(readFileSync("src/equicordplugins/hideChatButtons/index.tsx", "utf8") + "\nexport { ButtonsInnerComponent };", { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const { ButtonsInnerComponent } = runInNewContext(code + "\nexports;", {
        exports: {}, React: { createElement: () => null },
        require(name: string) {
            if (name === "@webpack/common") return { useState: () => { hooks++; return [false, () => {}]; }, useEffect: () => { hooks++; } };
            if (name === "@api/Settings") return { definePluginSettings: () => ({ store: {} }), migratePluginSetting() {} };
            if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value, OptionType: {}, StartAt: {} };
            return { EquicordDevs: {} };
        }
    });
    const counts = [[], [{ props: { disabled: false } }], [{ props: { disabled: true } }]].map(buttons => {
        hooks = 0;
        ButtonsInnerComponent({ buttons });
        return hooks;
    });
    assert.deepEqual(counts, [2, 2, 2]);
});
