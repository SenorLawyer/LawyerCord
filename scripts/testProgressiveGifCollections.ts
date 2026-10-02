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

function fixture() {
    let writes = 0;
    let dispatches = 0;
    let release: (() => void) | undefined;
    let gated = false;
    const gifs = Array.from({ length: 100 }, (_, i) => ({ id: String(i), src: `old${i}`, url: `old${i}`, width: 1, height: 1 }));
    const collections = [{ name: "gc:test", gifs, src: "old99" }];
    const settings = { store: { collectionPrefix: "gc:", itemPrefix: "gc-item:" } };
    const load = (path: string, require: (name: string) => unknown) => runInNewContext(transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText + "\nexports;", { exports: {}, require });
    const manager = load("src/equicordplugins/gifCollections/utils/collectionManager.ts", name => {
        if (name === "@api/index") return { DataStore: { get: async () => collections, set: async () => { writes++; } } };
        if (name === "../settings") return { settings };
        return { getFormat: () => "image", logger: { warn() {} } };
    });
    const plugin = load("src/equicordplugins/gifCollections/index.tsx", name => {
        if (name === "./utils/collectionManager") return manager;
        if (name === "./settings") return { settings, SortingOptions: {} };
        if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value };
        if (name === "@webpack/common") return { FluxDispatcher: { dispatch() { dispatches++; } } };
        if (name === "./utils/refreshUrl") return { batchRefreshAttachmentUrls: async (urls: string[]) => {
            if (gated) await new Promise<void>(resolve => { release = resolve; });
            return Object.fromEntries(urls.map(url => [url, url.replace("old", "new")]));
        } };
        return { EquicordDevs: {}, logger: { error() {} } };
    }).default;
    return { plugin, manager, gifs, counts: () => ({ writes, dispatches }), gate: () => { gated = true; }, release: () => release?.() };
}

test("GIF URL refresh writes the complete collection history once", async () => {
    const f = fixture();
    await f.manager.refreshCacheCollection();
    await f.plugin.refreshExpiredUrls(f.gifs.map(gif => gif.url), f.gifs, "gc:test");
    assert.equal(f.counts().writes, 1);
    assert.equal(f.manager.getGifById("99").url, "new99");
});

test("GIF refresh cannot write or dispatch after stop or account change", async () => {
    for (const changeAccount of [false, true]) {
        const f = fixture();
        await f.manager.refreshCacheCollection();
        f.gate();
        const pending = f.plugin.refreshExpiredUrls(["old0"], [f.gifs[0]], "gc:test");
        if (changeAccount) f.plugin.flux?.CONNECTION_OPEN();
        else f.plugin.stop?.();
        f.release();
        await pending;
        assert.deepEqual(f.counts(), { writes: 0, dispatches: 0 });
    }
});
