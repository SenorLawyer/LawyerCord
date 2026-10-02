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

test("Song Spotlight retains a bounded recent profile cache while keeping the account's editable songs", () => {
    const source = transpileModule(readFileSync("src/equicordplugins/songSpotlight.desktop/lib/stores/SongStore.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const modules: Record<string, unknown> = {
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) },
            zustandCreate: (factory: (set: (value: object) => void, get: () => object) => object) => {
                let state: object = factory(value => state = { ...state, ...value }, () => state);
                return { getState: () => state };
            } }
    };
    const api = runInNewContext(`${source};exports`, { exports: {}, require: (name: string) => modules[name] });
    const store = api.useSongStore;
    store.getState().update({ userId: "self", data: ["editable"] });
    for (let i = 0; i < 5000; i++) store.getState().update({ userId: `peer${i}`, data: [] });
    assert.ok(Object.keys(store.getState().users).length <= 200);
    assert.equal(store.getState().self.data[0], "editable");
    assert.ok(store.getState().users.peer4999);
    assert.equal(store.getState().users.peer0, undefined);
});

for (const method of ["getData", "listData"]) {
    test(`Song Spotlight ${method} preserves newer data when an older request returns 304`, async () => {
        const source = readFileSync("src/equicordplugins/songSpotlight.desktop/lib/api.ts", "utf8");
        const start = source.indexOf("export async function getData()");
        const end = source.indexOf("export async function saveData", start);
        const userId = method === "getData" ? "self" : "peer";
        const users: Record<string, { data: string[]; at: string; }> = {};
        let resolve: ((value: null) => void) | undefined;
        const api = runInNewContext(transpileModule(source.slice(start, end), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText + "\nexports;", {
            exports: {}, URL, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            apiConstants: { api: "https://example.com" },
            authFetch: () => new Promise<null>(done => { resolve = done; }),
            useSongStore: { getState: () => ({ users, update: ({ userId: id, ...value }: { userId: string; data: string[]; at: string; }) => { users[id] = value; } }) }
        });
        for (const evicted of [false, true]) {
            const old = { data: ["old"], at: "old" };
            const newer = { data: ["new"], at: "new" };
            users[userId] = old;
            const pending = api[method](userId);
            if (evicted) delete users[userId];
            else users[userId] = newer;
            assert.ok(resolve);
            resolve(null);
            assert.equal(await pending, (evicted ? old : newer).data);
            assert.equal(users[userId].data, (evicted ? old : newer).data);
        }
    });
}
