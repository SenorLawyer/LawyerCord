/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("text previews fall back while highlight.js is unavailable and retry when it loads", () => {
    let available = false;
    const hljs = { getLanguage: () => ({ name: "Lua" }) };
    const modules: Record<string, unknown> = {
        "@plugins/shikiCodeblocks.desktop/api/languages": { resolveLang: () => null },
        "@plugins/shikiCodeblocks.desktop/types": { HljsSetting: { Always: 0, Primary: 1, Secondary: 2, Never: 3 } },
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack": { filters: { byProps: () => null }, find: () => available ? hljs : undefined, extractAndLoadChunksLazy: () => () => {}, DefaultExtractAndLoadChunksRegex: /x/ }
    };
    const { outputText } = transpileModule(readFileSync("src/plugins/shikiCodeblocks.desktop/utils/misc.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const misc = runInNewContext(`${outputText}\nexports;`, { exports: {}, require: (name: string) => modules[name] });
    assert.equal(misc.shouldUseHljs({ lang: "lua", tryHljs: 2 }), false);
    available = true;
    assert.equal(misc.shouldUseHljs({ lang: "lua", tryHljs: 2 }), true);
});
