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

test("Navidrome retains bounded cover lookups through 1000 distinct tracks", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/richPresence/services/navidrome.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    let track = 0;
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 } },
        "../settings": { settings: { store: { nd_serverUrl: "https://example.com", nd_username: "test", nd_password: "test", nd_albumArtMode: "lastfm" } } },
        "md5": { __esModule: true, default: () => "hash" },
        "./assetCache": { getCachedApplicationAsset: async () => "image" }
    };
    const api = runInNewContext(`${source};({getActivity,count:()=>lastFmCache.size})`, {
        exports: {}, require: (name: string) => modules[name] ?? {},
        fetch: async (url: string) => ({ ok: true, json: async () => url.includes("getNowPlaying") ? { "subsonic-response": { nowPlaying: { entry: [{ id: String(track), username: "test", artist: "artist", album: String(track) }] } } } : { album: { image: [{ "#text": "https://example.com/cover" }] } } })
    });
    for (; track < 1000; track++) await api.getActivity();
    assert.ok(api.count() <= 200, `Retained ${api.count()} cover lookups`);
});
