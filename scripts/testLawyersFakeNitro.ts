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

test("Lawyer's Fake Nitro restores Discord's favorite limit", () => {
    const source = readFileSync("src/equicordplugins/lawyersFakeNitro/index.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const modules: Record<string, unknown> = {
        "@api/index": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value }, "@webpack/common": {}
    };
    const plugin = runInNewContext(`${outputText}\nexports.default;`, {
        exports: {}, require: (name: string) => modules[name]
    }) as { patches: { find: string; replacement: { match: RegExp; replace: string; }; }[]; };
    const patch = plugin.patches.find(item => item.find === "canUpsellFavoriteLimit:!");
    assert.ok(patch);
    const discord = "function u(e){return{favoriteLimit:e?200:3,canUpsellFavoriteLimit:!e}}";
    const match = new RegExp(patch.replacement.match.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"));
    const patched = discord.replace(match, patch.replacement.replace);
    assert.notEqual(patched, discord);
    const getLimit = runInNewContext(`${patched};u`) as (premium: boolean) => { favoriteLimit: number; canUpsellFavoriteLimit: boolean; };
    const access = getLimit(false);
    assert.equal(access.favoriteLimit, 200);
    assert.equal(access.canUpsellFavoriteLimit, false);
    const channels = new Set(["one", "two", "three"]);
    const add = (channel: string) => {
        if (channels.size >= access.favoriteLimit) return false;
        channels.add(channel);
        return true;
    };
    assert.equal(add("four"), true);
    assert.equal(channels.delete("four"), true);
    assert.equal(add("four"), true);
    while (channels.size < 200) channels.add(String(channels.size));
    assert.equal(add("over-limit"), false);
});

test("Local favorites survive add, remove, and reload", async () => {
    const source = readFileSync("src/equicordplugins/lawyersFakeNitro/index.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    let saved: Record<string, unknown> | undefined;
    const state = { favorites: { favoriteChannels: {} as Record<string, unknown> } };
    const modules: Record<string, unknown> = {
        "@api/index": { DataStore: { get: async () => saved, set: async (_key: string, value: Record<string, unknown>) => { saved = structuredClone(value); } } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": { lodash: { isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }, UserSettingsProtoStore: { getFullState: () => state } }
    };
    const plugin = runInNewContext(`${outputText}\nexports.default;`, { exports: {}, require: (name: string) => modules[name] }) as {
        start(): void; stop(): void; applyLocalFavorites(value: unknown): void;
        flux: { USER_SETTINGS_PROTO_UPDATE(event: unknown): void; };
    };
    plugin.start();
    await new Promise(resolve => setImmediate(resolve));
    state.favorites.favoriteChannels = { one: { position: 1 }, two: { position: 2 } };
    plugin.flux.USER_SETTINGS_PROTO_UPDATE({ local: true, settings: { proto: state } });
    assert.deepEqual(saved, state.favorites.favoriteChannels);
    delete state.favorites.favoriteChannels.one;
    plugin.flux.USER_SETTINGS_PROTO_UPDATE({ local: true, settings: { proto: state } });
    assert.deepEqual(saved, { two: { position: 2 } });
    plugin.stop();
    state.favorites.favoriteChannels = {};
    plugin.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(state.favorites.favoriteChannels)), { two: { position: 2 } });
});
