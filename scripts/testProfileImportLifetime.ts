/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

import { isPresetList } from "../src/equicordplugins/profileSets/utils/validation";

const source = transformSync(readFileSync("src/equicordplugins/profileSets/utils/actions.ts", "utf8"), { loader: "ts", format: "cjs" }).code;

function fixture() {
    const controller = new AbortController();
    const picker = Promise.withResolvers<{ text(): Promise<string>; }>();
    const contents = Promise.withResolvers<string>();
    const readStarted = Promise.withResolvers<void>();
    const promptStarted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<string>();
    let userId = "first";
    const counts = { picks: 0, reads: 0, parses: 0, writes: 0, updates: 0, errors: 0 };
    const storage = {
        presets: [{ name: "Existing", timestamp: 0 }],
        savePresetsData: async (_section: string, presets: typeof storage.presets) => { counts.writes++; storage.presets = presets; }
    };
    const modules: Record<string, unknown> = {
        "@utils/web": { chooseFile: () => { counts.picks++; return picker.promise; } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, showToast: () => counts.errors++, Toasts: { Type: { FAILURE: "failure" } } },
        "./profile": {},
        "./validation": { isPresetList }
    };
    const exports = {};
    const api = runInNewContext(`${source}; module.exports`, {
        exports, module: { exports }, require: (id: string) => { assert.ok(id in modules, id); return modules[id]; },
        JSON: { parse: (text: string) => { counts.parses++; return JSON.parse(text); } }
    }).createPresetActions(storage, controller.signal);
    return {
        counts, controller, storage, readStarted, promptStarted, contents, decision,
        changeAccount: () => { userId = "second"; },
        pick: () => picker.resolve({ text: () => { counts.reads++; readStarted.resolve(); return contents.promise; } }),
        start: () => api.importPresets(() => counts.updates++, () => { promptStarted.resolve(); return decision.promise; }, "main")
    };
}

for (const change of ["already closed", "closed", "account", "list"]) {
    test(`profile import rejects ${change} ownership before reading the selected file`, async () => {
        const f = fixture();
        if (change === "already closed") f.controller.abort();
        const pending = f.start();
        if (change === "closed") f.controller.abort();
        if (change === "account") f.changeAccount();
        if (change === "list") f.storage.presets = [{ name: "Replacement", timestamp: 1 }];
        f.pick();
        f.contents.resolve('[{"name":"Imported","timestamp":0}]');
        f.decision.resolve("override");
        await pending;
        assert.equal(f.counts.picks, change === "already closed" ? 0 : 1);
        assert.equal(f.counts.reads, 0);
        assert.equal(f.counts.parses, 0);
        assert.equal(f.counts.writes, 0);
        assert.equal(f.counts.updates, 0);
        assert.equal(f.counts.errors, change === "account" || change === "list" ? 1 : 0);
    });
}

for (const change of ["closed", "account", "list"]) {
    test(`profile import rejects ${change} ownership before parsing completed file reads`, async () => {
        const f = fixture();
        const pending = f.start();
        f.pick();
        await f.readStarted.promise;
        if (change === "closed") f.controller.abort();
        if (change === "account") f.changeAccount();
        if (change === "list") f.storage.presets = [{ name: "Replacement", timestamp: 1 }];
        f.contents.resolve('[{"name":"Imported","timestamp":0}]');
        f.decision.resolve("override");
        await pending;
        assert.equal(f.counts.reads, 1);
        assert.equal(f.counts.parses, 0);
        assert.equal(f.counts.writes, 0);
        assert.equal(f.counts.updates, 0);
        assert.equal(f.counts.errors, change === "closed" ? 0 : 1);
    });
}

for (const close of [false, true]) {
    test(`profile import ${close ? "ignores a closed" : "saves a current"} confirmation`, async () => {
        const f = fixture();
        const pending = f.start();
        f.pick();
        f.contents.resolve('[{"name":"Imported","timestamp":0}]');
        await f.promptStarted.promise;
        if (close) f.controller.abort();
        f.decision.resolve("override");
        await pending;
        assert.equal(f.counts.parses, 1);
        assert.equal(f.counts.writes, close ? 0 : 1);
        assert.equal(f.counts.updates, close ? 0 : 1);
        assert.equal(f.counts.errors, 0);
    });
}
