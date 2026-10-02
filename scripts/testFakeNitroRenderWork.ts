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

interface Node { type: string; props: { children?: unknown; href?: string; trusted?: boolean; }; }
const link = (href: string): Node => ({ type: "link", props: { href, trusted: true } });
const wrapper = (type: string, children: unknown): Node => ({ type, props: { children } });

function fixture() {
    let clones = 0;
    const store = { transformEmojis: true, transformStickers: true, transformCompoundSentence: true };
    const modules: Record<string, unknown> = {
        "@api/MessageEvents": {}, "@api/Settings": { definePluginSettings: () => ({ store }) }, "@components/Paragraph": {},
        "@equicordplugins/fileUpload/request": { readResponseBody: () => assert.fail("Rendering must not download stickers") },
        "@equicordplugins/fileUpload/utils/apngToGif": { convertApngToGif: () => assert.fail("Rendering must not convert stickers") },
        "@utils/apng": {}, "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({}), findByCodeLazy: () => () => undefined, proxyLazyWebpack: () => ({}) },
        "@webpack/common": { lodash: { cloneDeep: (value: unknown) => { clones++; return structuredClone(value); } },
            EmojiStore: { getCustomEmojiById: () => undefined }, StickersStore: { getStickerById: (id: string) => id === "42" ? { name: "Saved sticker" } : undefined },
            Parser: { defaultRules: { customEmoji: { react: (props: unknown, _state: unknown, options: object) => ({ type: "emoji", props, ...options }) } } } },
        "@vencord/discord-types/enums": { StickerFormatType: {} }, gifenc: {}
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_FAKE_NITRO_SOURCE ?? "src/plugins/fakeNitro/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const plugin = runInNewContext(`${outputText}\nexports.default;`, { exports: {}, URL,
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } }) as {
            patchFakeNitroEmojisOrRemoveStickersLinks(content: unknown[], inline: boolean): unknown[];
        };
    return { store, clones: () => clones, render: (content: unknown[], inline = false) => plugin.patchFakeNitroEmojisOrRemoveStickersLinks(content, inline) };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("Ordinary parsed message trees skip deep cloning and keep their original identity", () => {
    const f = fixture();
    const content = [wrapper("div", Array.from({ length: 1000 }, (_, i) => wrapper("strong", `text ${i}`))), link("https://example.com/page")];
    for (let i = 0; i < 100; i++) assert.equal(f.render(content), content);
    assert.equal(f.clones(), 0);
});

test("No-transform messages preserve whitespace and unknown GIF attachment links", () => {
    const f = fixture();
    for (const content of [["  ordinary text  "], [link("https://cdn.discordapp.com/attachments/1/2/99.gif")]]) {
        assert.equal(f.render(content), content);
    }
    assert.equal(f.clones(), 0);
});

test("Fake emoji conversion preserves metadata, numbering, nesting and input immutability", () => {
    const f = fixture();
    const content = [link("https://cdn.discordapp.com/emojis/123.gif?name=Wave")];
    const original = structuredClone(content);
    assert.deepEqual(plain(f.render(content)), [{ type: "emoji", props: { jumboable: false, animated: true, emojiId: "123", name: "Wave", fake: true }, key: "1" }]);
    assert.deepEqual(content, original);
    const nested = [wrapper("ul", [wrapper("li", [link("https://cdn.discordapp.com/emojis/456.webp?animated=true&name=Nested")])])];
    const result = plain(f.render(nested, true));
    assert.equal(result[0].props.children[0].props.children[0].props.name, "Nested");
    assert.equal(result[0].props.children[0].props.children[0].props.jumboable, false);
    assert.equal(f.clones(), 2);
});

test("Known fake sticker links remove empty lists and preserve unrelated links with settings gates", () => {
    const f = fixture();
    const sticker = link("https://media.discordapp.net/stickers/42.png");
    const gif = link("https://cdn.discordapp.com/attachments/1/2/42.gif");
    assert.deepEqual(plain(f.render([wrapper("ul", [wrapper("li", [sticker, gif])])])), []);
    assert.deepEqual(plain(f.render(["  before  ", sticker, "  after  "])), ["before  ", "  after"]);
    f.store.transformStickers = false;
    assert.equal(f.render([sticker])[0], sticker);
    f.store.transformEmojis = false;
    const emoji = link("https://cdn.discordapp.com/emojis/123.gif");
    assert.equal(f.render([emoji])[0], emoji);
    f.store.transformCompoundSentence = false;
    const mixed = ["text", emoji];
    assert.equal(f.render(mixed), mixed);
});
