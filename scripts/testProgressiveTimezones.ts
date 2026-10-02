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

test("Timezone message rows share system timezone discovery while still observing timezone changes", () => {
    const source = readFileSync("src/equicordplugins/timezones/index.tsx", "utf8");
    const block = source.slice(source.indexOf("export let timezones"), source.indexOf("const classes ="));
    const compiled = transpileModule(block, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    let constructions = 0;
    let zone = "Europe/Amsterdam";
    let now = 1000;
    const api = runInNewContext(`${compiled};exports`, { exports: {}, Date: { now: () => now }, Intl: {
        DateTimeFormat() { constructions++; return { resolvedOptions: () => ({ timeZone: zone }) }; }
    } });
    for (let render = 0; render < 1000; render++) assert.equal(api.getSystemTimezone(), zone);
    assert.equal(constructions, 1);
    now += 60_001;
    zone = "America/New_York";
    assert.equal(api.getSystemTimezone(), zone);
    assert.equal(constructions, 2);
});
