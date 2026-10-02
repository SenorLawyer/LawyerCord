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

for (const plugin of ["profileSets/utils/profile", "richPresence/services/tosu"]) {
    test(`${plugin} supports AbortController without newer AbortSignal static helpers`, async () => {
        const source = transpileModule(readFileSync(`src/equicordplugins/${plugin}.ts`, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        const timers = new Map<number, () => void>();
        let fetches = 0;
        const modules: Record<string, unknown> = {
            "@api/UserSettings": { getUserSettingLazy: () => ({}) },
            "@webpack": { findStoreLazy: () => ({}) },
            "@utils/Logger": { Logger: class {} },
            "./assetCache": { getCachedApplicationAsset: async () => "https://example.com/cover" }
        };
        class Reader {
            result = "data:image/png;base64,AQ==";
            onload?: () => void;
            readAsDataURL() { this.onload?.(); }
        }
        const api = runInNewContext(`${source};${plugin.startsWith("profile") ? "exports.imageUrlToBase64" : "getBeatmapCover"}`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, AbortController, AbortSignal: {}, Blob, FileReader: Reader,
            setTimeout: (fn: () => void) => { timers.set(1, fn); return 1; }, clearTimeout: (id: number) => timers.delete(id),
            fetch: async () => { fetches++; return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }); }
        });
        const result = await api(plugin.startsWith("profile") ? "https://example.com/image" : 123, new AbortController().signal);
        assert.equal(result, plugin.startsWith("profile") ? "data:image/png;base64,AQ==" : "https://example.com/cover");
        assert.equal(fetches, 1);
        assert.equal(timers.size, 0);
    });
}

for (const plugin of ["profileSets/utils/profile", "richPresence/services/tosu"]) {
    for (const trigger of ["caller", "deadline"]) {
        test(`${plugin} aborts stalled requests on ${trigger} and releases its timer`, async () => {
            const source = transpileModule(readFileSync(`src/equicordplugins/${plugin}.ts`, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
            const timers = new Map<number, () => void>();
            let requestSignal: AbortSignal | undefined;
            let started: () => void = () => undefined;
            const fetching = new Promise<void>(resolve => { started = resolve; });
            const modules: Record<string, unknown> = {
                "@api/UserSettings": { getUserSettingLazy: () => ({}) },
                "@webpack": { findStoreLazy: () => ({}) },
                "@utils/Logger": { Logger: class {} },
                "./assetCache": { getCachedApplicationAsset: async () => "https://example.com/cover" }
            };
            const api = runInNewContext(`${source};${plugin.startsWith("profile") ? "exports.imageUrlToBase64" : "getBeatmapCover"}`, {
                exports: {}, require: (name: string) => modules[name] ?? {}, AbortController, AbortSignal: {},
                setTimeout: (fn: () => void) => { timers.set(1, fn); return 1; }, clearTimeout: (id: number) => timers.delete(id),
                fetch: (_url: string, options: { signal: AbortSignal }) => {
                    requestSignal = options.signal;
                    started();
                    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("Cancelled")), { once: true }));
                }
            });
            const caller = new AbortController();
            const pending = api(plugin.startsWith("profile") ? "https://example.com/image" : 123, caller.signal);
            await fetching;
            if (trigger === "caller") caller.abort();
            else for (const timer of timers.values()) timer();
            assert.equal(await pending, plugin.startsWith("profile") ? null : undefined);
            assert.equal(requestSignal?.aborted, true);
            assert.equal(timers.size, 0);
        });
    }
}


test("Profile presets load and cancel without AbortSignal instance helpers", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/profileSets/utils/profile.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const writes: unknown[] = [];
    const modules: Record<string, unknown> = {
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => null }) },
        "@webpack": { findStoreLazy: () => ({ getPendingChanges: () => ({}) }) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            UserProfileStore: { getUserProfile: () => ({ bio: "before" }) },
            FluxDispatcher: { dispatch: (value: unknown) => writes.push(value) }
        }
    };
    const api = runInNewContext(`${source};exports`, { exports: {}, DOMException, require: (name: string) => modules[name] ?? {} });
    const controller = new AbortController();
    Object.defineProperties(controller.signal, { throwIfAborted: { value: undefined }, reason: { value: undefined } });
    assert.equal((await api.getCurrentProfile(undefined, { signal: controller.signal })).bio, "before");
    await api.loadPresetAsPending({ bio: "after" }, undefined, { signal: controller.signal });
    assert.equal(writes.length, 1);
    controller.abort();
    await assert.rejects(api.getCurrentProfile(undefined, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(api.loadPresetAsPending({ bio: "cancelled" }, undefined, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(writes.length, 1);
});

test("GIF fonts load without AbortSignal instance helpers and reject cancelled loads", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/gifMaker/fonts.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const fonts = new Set<unknown>();
    const urls = new Set<string>();
    const load = runInNewContext(`${source};loadFontFace`, {
        exports: {}, DOMException, AbortController,
        require: () => ({ Logger: class { warn() {} } }),
        fetch: async () => ({ ok: true, blob: async () => new Blob(["font"]) }),
        URL: { createObjectURL: () => { urls.add("font"); return "font"; }, revokeObjectURL: (url: string) => urls.delete(url) },
        FontFace: class { async load() { return this; } }, document: { fonts }
    });
    const controller = new AbortController();
    Object.defineProperties(controller.signal, { throwIfAborted: { value: undefined }, reason: { value: undefined } });
    assert.equal(await load("Fixture", "https://fonts.gstatic.com/font.woff2", {}, controller.signal), true);
    assert.equal(fonts.size, 1);
    controller.abort();
    assert.equal(await load("Cancelled", "https://fonts.gstatic.com/font.woff2", {}, controller.signal), false);
    assert.equal(fonts.size, 1);
    assert.equal(urls.size, 0);
});

test("GitHub errors and cancellation work without AbortSignal instance helpers", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/githubRepos/githubApi.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(`${source};exports`, {
        exports: {}, DOMException, require: () => ({ Logger: class { error() {} } }),
        fetch: async () => { throw new Error("Offline"); }
    });
    const controller = new AbortController();
    Object.defineProperties(controller.signal, { throwIfAborted: { value: undefined }, reason: { value: undefined } });
    assert.equal(await api.fetchUserInfo("fixture", controller.signal), null);
    assert.equal(await api.fetchReposByUserId("fixture", 30, controller.signal), null);
    controller.abort();
    await assert.rejects(api.fetchUserInfo("fixture", controller.signal), { name: "AbortError" });
    await assert.rejects(api.fetchReposByUserId("fixture", 30, controller.signal), { name: "AbortError" });
});
