/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("settings caches release removed ancestors and bound transient alias proxies", () => {
    const source = readFileSync(process.env.AUDIT_SETTINGS_RETENTION_SOURCE ?? "src/shared/SettingsStore.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } });
    const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "-e", `
        const { readFileSync } = require("node:fs");
        const { SettingsStore } = require("node:vm").runInNewContext(readFileSync(0, "utf8") + ";exports", { exports: {} });
        const leaf = { value: 1 };
        const store = new SettingsStore({ keep: leaf, parents: {} });
        const parents = [], aliases = [], controls = [];
        function populate() {
            for (let i = 0; i < 256; i++) {
                const parent = { leaf, payload: new Uint8Array(4096) };
                parents.push(new WeakRef(parent));
                controls.push(new WeakRef({ payload: new Uint8Array(4096) }));
                store.store.parents["p" + i] = parent;
                void store.store.parents["p" + i].leaf;
                delete store.store.parents["p" + i];
                store.store["alias" + i] = leaf;
                aliases.push(new WeakRef(store.store["alias" + i]));
                delete store.store["alias" + i];
            }
        }
        populate();
        (async () => {
            for (let i = 0; i < 16; i++) {
                await new Promise(setImmediate);
                global.gc();
            }
            const retained = refs => refs.filter(ref => ref.deref() !== undefined).length;
            process.stdout.write(JSON.stringify({ controls: retained(controls), parents: retained(parents), aliases: retained(aliases), alive: store.store.keep.value }));
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { input: outputText, encoding: "utf8", timeout: 30_000 })) as { controls: number; parents: number; aliases: number; alive: number; };
    assert.equal(result.controls, 0, "the subprocess must demonstrate collection of unreferenced control objects");
    assert.equal(result.alive, 1, "the store and shared leaf must remain alive throughout collection");
    assert.equal(result.parents, 0, "cached shared children must not retain removed parent objects");
    assert.ok(result.aliases <= 64, `${result.aliases} transient alias proxies remain reachable through the long lived root`);
});
