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

function fixture() {
    const source = readFileSync(process.env.AUDIT_HUSK_SOURCE ?? "src/equicordplugins/husk/index.tsx", "utf8");
    const { outputText } = transpileModule(source.slice(source.indexOf("function getEmojiIdThatShouldBeUsed")), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    let reads = 0;
    let visits = 0;
    let channelReads = 0;
    let warnings = 0;
    let fail = false;
    const urls: string[] = [];
    const emojis = Array.from({ length: 10_000 }, (_, i) => ({ get name() { visits++; return i >= 9998 ? "husk" : "other"; }, id: String(i) }));
    const exports: { default?: { messagePopoverButton: { render(msg: { channel_id: string; id: string; }): { onClick(): Promise<void> | void; }; }; }; } = {};
    runInNewContext(outputText, {
        exports, settings: { store: { findInServer: true, get emojiName() { reads++; return "husk"; }, emojiID: 123n } },
        EmojiStore: { getGuildEmoji: () => emojis },
        ChannelStore: { getChannel() { channelReads++; return { guild_id: "guild" }; } },
        RestAPI: { put({ url }: { url: string; }) { urls.push(url); return fail ? Promise.reject(new Error("Unavailable")) : Promise.resolve(); } },
        Constants: { Endpoints: { REACTION: (channel: string, message: string, emoji: string, user: string) => `/channels/${channel}/messages/${message}/reactions/${emoji}/${user}` } },
        logger: { warn() { warnings++; } }, showToast() {}, Toasts: { Type: { FAILURE: 2 } },
        definePlugin: (p: unknown) => p, Devs: { nin0dev: {} }, Husk() {}
    });
    const plugin = exports.default;
    assert.ok(plugin);
    return { click: () => plugin.messagePopoverButton.render({ channel_id: "channel", id: "message" }).onClick(),
        reads: () => reads, visits: () => visits, channelReads: () => channelReads, warnings: () => warnings, urls,
        fail() { fail = true; }, fallback() { emojis.length = 0; }
    };
}

test("Husk retains the last matching emoji without reading settings per server emoji", async () => {
    const f = fixture(); await f.click();
    assert.match(f.urls[0], /husk:9999\/\@me$/);
    assert.ok(f.reads() <= 2);
    assert.equal(f.visits(), 1);
    assert.equal(f.channelReads(), 1);
    f.fallback(); await f.click();
    assert.match(f.urls[1], /husk:123\/\@me$/);
});

test("Husk handles rejected reaction requests", async () => {
    const f = fixture(); f.fail(); await f.click();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(f.warnings(), 1);
});
