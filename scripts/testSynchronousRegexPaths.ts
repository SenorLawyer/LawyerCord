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

import { SettingsStore } from "../src/shared/SettingsStore";

interface Rule { find: string; replace: string; onlyIfIncludes: string; scope: string; }
interface Message { content: string; embeds: object[]; channel_id: string; author: { id: string; bot?: boolean }; mentions: object[]; }
function message(content = "no"): Message { return { content, embeds: [], channel_id: "channel", author: { id: "self" }, mentions: [] }; }
function fixture(path: string, store: object | (() => object), entries: unknown = []) {
    const counts = { compiled: 0, errors: 0, reads: 0, tests: 0, interceptors: 0 };
    class CountedRegex extends RegExp {
        constructor(pattern: string, flags?: string) { counts.compiled++; super(pattern, flags); }
        test(value: string) { counts.tests++; return super.test(value); }
    }
    const settings = { get store() { return typeof store === "function" ? store() : store; } };
    let checks: Record<string, { isValid?(this: typeof settings, value: unknown): boolean | string }> = {};
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: (_definitions: unknown, validation: typeof checks) => { checks = validation ?? {}; return settings; } },
        "@api/index": { DataStore: { get: async (key: string) => key.endsWith("keywordEntries") ? entries : [] } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {}, SUPPORT_CHANNEL_IDS: [] },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/index": { classNameFactory: () => () => "" },
        "@utils/Logger": { Logger: class { error() { counts.errors++; } warn() { counts.errors++; } } },
        "@webpack": { findByCodeLazy: () => () => ({}), findCssClassesLazy: () => ({}) },
        "@webpack/common": { ChannelStore: { getChannel: () => { counts.reads++; return { guild_id: "guild" }; } }, UserStore: { getCurrentUser: () => ({ id: "self" }) }, FluxDispatcher: { addInterceptor() { counts.interceptors++; }, _interceptors: [] } }
    };
    const source = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const api = runInNewContext(`${source};({plugin:exports.default,apply:typeof applyRules === "function" ? applyRules : undefined,cacheSize:()=>typeof compiledRules === "undefined" ? 0 : compiledRules.size})`, { exports: {}, require: (name: string) => modules[name] ?? {}, crypto, RegExp: CountedRegex }) as {
        plugin: { start(): void | Promise<void>; stop(): void; containsBlockedKeywords(message: Message): boolean; applyKeywordEntries(message: Message): void };
        apply(content: string, scope: string): string;
        cacheSize(): number;
    };
    return { ...api, counts, validate: (key: string, value: unknown) => checks[key].isValid?.call(settings, value) };
}

test("BlockKeywords skips invalid patterns, retains valid ones and clears empty or stopped matchers", () => {
    const store = { blockedWords: "[,word", useRegex: true, caseSensitive: false };
    const f = fixture("src/equicordplugins/blockKeywords/index.tsx", store);
    assert.doesNotThrow(() => f.plugin.start());
    assert.equal(f.plugin.containsBlockedKeywords(message("word")), true);
    assert.equal(f.counts.errors, 1);
    f.plugin.start();
    assert.equal(f.counts.errors, 1);
    assert.equal(typeof f.validate("blockedWords", "["), "string");
    assert.equal(f.validate("blockedWords", "word"), true);
    store.useRegex = false;
    assert.equal(f.validate("blockedWords", "["), true);
    assert.equal(typeof f.validate("useRegex", true), "string");
    store.useRegex = true;
    store.blockedWords = "";
    f.plugin.start();
    assert.equal(f.plugin.containsBlockedKeywords(message("word")), false);
    store.blockedWords = "word";
    f.plugin.start();
    f.plugin.stop();
    assert.equal(f.plugin.containsBlockedKeywords(message("word")), false);
});

test("TextReplace compiles unchanged settings once and reports an invalid pattern once", () => {
    const store = new SettingsStore({ stringRules: [], regexRules: [{ find: "hello", replace: "world", onlyIfIncludes: "", scope: "allMessages" }] });
    const f = fixture("src/plugins/textReplace/index.tsx", () => store.store);
    for (let i = 0; i < 1000; i++) assert.equal(f.apply("hello", "othersMessages"), "world");
    assert.equal(f.counts.compiled, 1);
    store.store.regexRules[0].find = "[";
    for (let i = 0; i < 1000; i++) assert.equal(f.apply("hello", "othersMessages"), "hello");
    assert.equal(f.counts.errors, 1);
});

test("TextReplace cache observes proxy edits, splice/reorder and stateful regex flags", () => {
    const rules: Rule[] = [{ find: "/a/y", replace: "b", onlyIfIncludes: "", scope: "allMessages" }, { find: "/b/g", replace: "$&x", onlyIfIncludes: "", scope: "allMessages" }];
    const store = new SettingsStore({ stringRules: [], regexRules: rules });
    const f = fixture("src/plugins/textReplace/index.tsx", () => store.store);
    for (let i = 0; i < 3; i++) assert.equal(f.apply("aaa", "othersMessages"), "bxaa");
    store.store.regexRules[0].replace = "c";
    assert.equal(f.apply("aaa", "othersMessages"), "caa");
    store.store.regexRules[0].find = "/a/g";
    assert.equal(f.apply("aaa", "othersMessages"), "ccc");
    store.store.regexRules.splice(0, 2, { find: "c", replace: "z", onlyIfIncludes: "", scope: "allMessages" }, { find: "a", replace: "c", onlyIfIncludes: "", scope: "allMessages" });
    assert.equal(f.apply("a", "othersMessages"), "c");
    store.store.regexRules.reverse();
    assert.equal(f.apply("a", "othersMessages"), "z");
});

test("KeywordNotify reads guild once only when lists need it and stops after matching a field", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ regex: `never${i}`, listIds: ["other"], listType: "BlackList", ignoreCase: false }));
    const f = fixture("src/equicordplugins/keywordNotify/index.tsx", { ignoreBots: false }, entries);
    await f.plugin.start();
    f.plugin.applyKeywordEntries(message());
    assert.equal(f.counts.reads, 1);
    const g = fixture("src/equicordplugins/keywordNotify/index.tsx", { ignoreBots: false }, [{ regex: "hit", listIds: [], listType: "BlackList", ignoreCase: false }]);
    await g.plugin.start();
    const m = message();
    m.embeds = [{ fields: [{ name: "hit", value: "no" }] }, ...Array.from({ length: 9 }, () => ({ description: "no", title: "no" }))];
    g.plugin.applyKeywordEntries(m);
    assert.equal(g.counts.tests, 3);
    assert.equal(g.counts.reads, 0);
    assert.equal(m.mentions.length, 1);
});

test("KeywordNotify stored null entries do not prevent valid rules or interceptor startup", async () => {
    const f = fixture("src/equicordplugins/keywordNotify/index.tsx", { ignoreBots: false }, [null, { regex: "hit", listIds: [], listType: "BlackList", ignoreCase: false }]);
    await f.plugin.start();
    const m = message("hit");
    f.plugin.applyKeywordEntries(m);
    assert.equal(m.mentions.length, 1);
    assert.equal(f.counts.interceptors, 1);
});


test("TextReplace releases removed patterns and preserves scope, guards and replacement tokens", () => {
    const store = new SettingsStore({ stringRules: [], regexRules: [{ find: "(a)", replace: "$1\\n$&", onlyIfIncludes: "trigger", scope: "myMessages" }] });
    const f = fixture("src/plugins/textReplace/index.tsx", () => store.store);
    assert.equal(f.apply("a trigger", "othersMessages"), "a trigger");
    assert.equal(f.apply("a", "myMessages"), "a");
    assert.equal(f.counts.compiled, 0);
    assert.equal(f.apply("a trigger", "myMessages"), "a\na trigger");
    for (let i = 0; i < 100; i++) {
        store.store.regexRules[0].find = String(i);
        f.apply("trigger", "myMessages");
        assert.equal(f.cacheSize(), 1);
    }
    store.store.regexRules[0].find = "(a)";
    const before = f.counts.compiled;
    f.apply("a trigger", "myMessages");
    assert.equal(f.counts.compiled, before + 1);
    store.setData({ stringRules: [], regexRules: [{ find: "a", replace: "b", onlyIfIncludes: "", scope: "allMessages" }, { find: "a", replace: "c", onlyIfIncludes: "", scope: "allMessages" }] });
    assert.equal(f.apply("a", "myMessages"), "b");
    assert.equal(f.cacheSize(), 1);
    f.plugin.stop();
    assert.equal(f.cacheSize(), 0);
    assert.equal(f.apply("a", "myMessages"), "b");
    store.store.regexRules.splice(0);
    f.apply("trigger", "myMessages");
    assert.equal(f.cacheSize(), 0);
    f.plugin.stop();
    assert.equal(f.cacheSize(), 0);
});
