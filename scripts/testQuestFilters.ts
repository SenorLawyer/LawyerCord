/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

function fixture() {
    const source = readFileSync(process.env.AUDIT_QUEST_TILES_SOURCE ?? "src/equicordplugins/questify/utils/questTiles.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const store = new SettingsStore({ rememberQuestPageFilters: true, lastQuestPageFilters: {} as Record<string, { group: string; filter: string; }> });
    let writes = 0;
    store.addChangeListener("lastQuestPageFilters", () => writes++);
    const modules: Record<string, unknown> = {
        "@webpack/common": { lodash: { isEqual: (a: Record<string, object>, b: Record<string, object>) => isDeepStrictEqual(
            Object.fromEntries(Object.entries(a).map(([key, value]) => [key, { ...value }])),
            Object.fromEntries(Object.entries(b).map(([key, value]) => [key, { ...value }]))
        ) } },
        "../settings/access": { getQuestifySettings: () => store.store },
        "../settings/def": {}, "../settings/ignoredQuests": {}, "./questState": {}, "./ui": { q: (s: string) => s }
    };
    const exports: { getLastFilterChoices?: () => { group: string; filter: string; }[] | null; setLastFilterChoices?: (filters: { group: string; filter: string; }[] | null) => void; } = {};
    runInNewContext(outputText, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    const { getLastFilterChoices, setLastFilterChoices } = exports;
    assert.ok(getLastFilterChoices && setLastFilterChoices);
    return { store, get: getLastFilterChoices, set: setLastFilterChoices, writes: () => writes };
}

test("quest filter renders only save changed choices and do not retain their input objects", () => {
    const f = fixture();
    const filters = [{ group: "status", filter: "unclaimed" }];
    f.set(filters); assert.equal(f.writes(), 1);
    const saved = f.store.plain.lastQuestPageFilters;
    for (let i = 0; i < 100; i++) f.set([{ group: "status", filter: "unclaimed" }]);
    assert.equal(f.writes(), 1); assert.equal(f.store.plain.lastQuestPageFilters, saved);
    filters[0].filter = "claimed";
    assert.equal(Object.values(saved)[0].filter, "unclaimed");
    f.set(filters); assert.equal(f.writes(), 2);
    f.set([{ group: "", filter: "invalid" }]); assert.equal(f.writes(), 2);
    f.set([]); assert.equal(f.writes(), 3);
    f.set(null); f.set([]); assert.equal(f.writes(), 3);
});

test("quest filter reads preserve ordering and isolate edits from saved choices", () => {
    const f = fixture();
    f.set([{ group: "reward", filter: "orbs" }, { group: "status", filter: "unclaimed" }]);
    const choices = f.get(); assert.ok(choices);
    assert.deepEqual(Array.from(choices, choice => choice.filter), ["orbs", "unclaimed"]);
    choices[0].filter = "edited";
    assert.equal(Object.values(f.store.plain.lastQuestPageFilters)[0].filter, "orbs");
    Object.assign(f.store.plain.lastQuestPageFilters, { bad: null, incomplete: { group: "bad" } });
    assert.deepEqual(Array.from(f.get() ?? [], choice => choice.filter), ["orbs", "unclaimed"]);
    f.store.store.rememberQuestPageFilters = false; assert.equal(f.get(), null);
});
