/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Session { id: string; newPlugins: string[]; }

function fixture() {
    const values = new Map<string, unknown>();
    const key = "LawyerCordChangelog_History";
    const DataStore = {
        async get(name: string) { return structuredClone(values.get(name)); },
        async set(name: string, value: unknown) { values.set(name, structuredClone(value)); },
        async update(name: string, updater: (value: unknown) => unknown) {
            values.set(name, structuredClone(updater(structuredClone(values.get(name)))));
        }
    };
    const mocks: Record<string, unknown> = {
        "@api/index": { DataStore }, "~git-hash": { __esModule: true, default: "current" },
        "~plugins": { __esModule: true, default: {} }
    };
    const source = readFileSync("src/components/settings/tabs/changelog/changelogManager.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(`${code}\nexports;`, { exports: {}, Map, Set, crypto: { randomUUID },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    }) as { saveUpdateSession(commits: object[], plugins: string[], settings: Map<string, string[]>): Promise<void>; clearIndividualLog(id: string): Promise<void>; };
    return { api, values, key, history: () => values.get(key) as Session[] };
}

test("Concurrent changelog sessions preserve every update and the 50-entry cap", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.api.saveUpdateSession([], [String(i)], new Map())));
    assert.equal(f.history().length, 20);
    assert.equal(new Set(f.history().flatMap(session => session.newPlugins)).size, 20);
    await Promise.all(Array.from({ length: 40 }, (_, i) => f.api.saveUpdateSession([], [`later${i}`], new Map())));
    assert.equal(f.history().length, 50);
});

test("Concurrent individual clears preserve unrelated changelog entries", async () => {
    const f = fixture();
    f.values.set(f.key, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    await Promise.all([f.api.clearIndividualLog("a"), f.api.clearIndividualLog("b")]);
    assert.deepEqual(f.history().map(session => session.id), ["c"]);
});
