/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

for (const service of ["statsfm", "jellyfin", "audiobookshelf"]) {
    test(`${service} stop aborts pending fetches across 100 restart cycles`, async () => {
        const source = transpileModule(readFileSync(`src/equicordplugins/richPresence/services/${service}.ts`, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        let pending = 0;
        const timers = new Map<number, () => void>();
        let nextTimer = 1;
        const store = { sfm_username: "tester", jf_serverUrl: "https://example.com", jf_apiKey: "test", jf_userId: "test", abs_serverUrl: "https://example.com", abs_username: "test", abs_password: "test" };
        const modules: Record<string, unknown> = {
            "../settings": { settings: { store } },
            "@utils/Logger": { Logger: class { error() {} warn() {} } },
            "@webpack": { findByPropsLazy: () => ({}) },
            "@webpack/common": { FluxDispatcher: { dispatch() {} } }
        };
        const api = runInNewContext(`${source};exports`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, AbortController, AbortSignal: {},
            setInterval: () => 1, clearInterval() {},
            setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 30_000); const id = nextTimer++; timers.set(id, fn); return id; },
            clearTimeout: (id: number) => timers.delete(id),
            fetch: (_url: string, options?: { signal?: AbortSignal }) => {
                pending++;
                return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => { pending--; reject(Error("Cancelled")); }, { once: true }));
            }
        });
        for (let cycle = 0; cycle < 100; cycle++) {
            api.start();
            assert.equal(pending, 1);
            api.stop();
            await setImmediate();
            assert.equal(pending, 0);
            assert.equal(timers.size, 0);
        }
        api.start();
        timers.values().next().value?.();
        await setImmediate();
        assert.equal(pending, 0);
        api.stop();
    });
}

test("Music presence asset lookup supports older AbortSignal objects and honors cancellation", async () => {
    const source = readFileSync("src/plugins/musicRichPresence/index.tsx", "utf8");
    const start = source.indexOf("async function getApplicationAsset(");
    const end = source.indexOf("\n}", start) + 2;
    let calls = 0;
    const getAsset = runInNewContext(transpileModule(source.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText + "\ngetApplicationAsset;", {
        DOMException, DISCORD_APP_ID: "test",
        ApplicationAssetUtils: { fetchAssetIds: async () => { calls++; return ["asset"]; } }
    });
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
    assert.equal(await getAsset("cover", controller.signal), "asset");
    controller.abort();
    await assert.rejects(getAsset("cover", controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
});
