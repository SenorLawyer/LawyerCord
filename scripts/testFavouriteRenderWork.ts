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
import { deflateSync, inflateSync } from "fflate";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("favourite picker decodes changed metadata only and retains removed items until the query changes", () => {
    let inflations = 0;
    let cursor = 0;
    const hooks: { value: unknown; deps?: unknown[]; select?: () => unknown; equal?: (a: unknown, b: unknown) => boolean; }[] = [];
    const gifs: Record<string, { src: string; format: number; width: number; height: number; order: number; }> = {};
    const protoStore = { frecencyWithoutFetchingLatest: { favoriteGifs: { gifs } } };
    const mocks: Record<string, unknown> = {
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
        "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() },
        "@utils/Queue": { Queue: class {} }, "@utils/react": {},
        "@webpack": { findByCodeLazy: () => ({}), findByPropsLazy: () => ({}) },
        "@webpack/common": {
            UserSettingsProtoStore: protoStore, UserSettingsActionCreators: {}, lodash: { isEqual: isDeepStrictEqual },
            useEffect: () => { cursor++; },
            useStateFromStores: (_stores: unknown[], select: () => unknown, deps: unknown[], equal = Object.is) => {
                const index = cursor++;
                const next = select();
                const previous = hooks[index];
                const value = previous && equal(previous.value, next) ? previous.value : next;
                hooks[index] = { value, select, equal, deps };
                return value;
            },
            useMemo: (factory: () => unknown, deps: unknown[]) => {
                const index = cursor++;
                const previous = hooks[index];
                if (!previous || !previous.deps?.every((dep, i) => Object.is(dep, deps[i]))) hooks[index] = { value: factory(), deps };
                return hooks[index].value;
            }
        },
        "fflate": { deflateSync, inflateSync: (...args: Parameters<typeof inflateSync>) => { inflations++; return inflateSync(...args); } },
        "./polyfills": {
            uint8ArrayToBase64: (data: Uint8Array) => Buffer.from(data).toString("base64url"),
            base64ToUint8Array: (data: string) => new Uint8Array(Buffer.from(data, "base64url"))
        },
        "./types": { FavouriteItemFormat: { NONE: 0 }, CustomItemFormat: { ATTACHMENT: 0 } }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/utils.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { defs, useFavourites } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, TextEncoder, TextDecoder, URL, Uint8Array, VencordNative: { pluginHelpers: {} },
        window: { GLOBAL_ENV: { CDN_HOST: "cdn.discordapp.com", MEDIA_PROXY_ENDPOINT: "media.discordapp.net", IMAGE_PROXY_ENDPOINTS: "images-ext-1.discordapp.net" } },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const encoded = defs.encode(0, { id: "1", filename: "file.txt", size: 1, url: "https://cdn.discordapp.com/attachments/1/file.txt" });
    gifs.file = { src: `https://media.discordapp.net/thumbnail#${encoded}`, format: 0, width: 100, height: 100, order: 1 };
    const render = (query = "") => { cursor = 0; return useFavourites(0, query); };
    const first = render();
    assert.equal(first.length, 1);
    assert.equal(first[0].data.filename, "file.txt");
    assert.equal(inflations, 1);
    for (let i = 0; i < 100; i++) {
        for (const hook of hooks) if (hook?.select) {
            const next = hook.select();
            if (!hook.equal?.(hook.value, next)) hook.value = next;
        }
        assert.equal(render(), first);
    }
    assert.equal(inflations, 1);
    gifs.file.src = `https://media.discordapp.net/thumbnail#${defs.encode(0, { id: "1", filename: "changed.txt", size: 2, url: "https://cdn.discordapp.com/attachments/1/file.txt" })}`;
    render();
    assert.equal(inflations, 2);
    assert.equal(render("changed")[0].data.filename, "changed.txt");
    delete gifs.file;
    const retained = render("changed");
    assert.equal(retained.length, 1);
    assert.equal(render("absent").length, 0);
});
