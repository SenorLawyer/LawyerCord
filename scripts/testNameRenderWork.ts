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

interface Element { type: unknown; props: Record<string, unknown>; children: unknown[]; }
interface User { id: string; username: string; globalName: string; nick?: string; bot?: boolean; discriminator?: string; }

function fixture(sourcePath = process.env.AUDIT_NAME_SOURCE ?? "src/plugins/showMeYourName/index.tsx") {
    let reads = 0;
    let wraps = 0;
    let elements = 0;
    let friend = "";
    const users = new Map<string, User>();
    const store: Record<string, unknown> = {};
    const streamer = { enabled: false };
    const modules: Record<string, unknown> = {
        "./style.css": {}, "@api/ContextMenu": {}, "@api/index": { DataStore: { get: async () => ({}) } },
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/Settings": { definePluginSettings(definitions: Record<string, { default: unknown; }>) {
            for (const [key, value] of Object.entries(definitions)) store[key] = value.default;
            return { store, use: () => store };
        } },
        "@components/Button": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Heading": {}, "@plugins/ircColors": { __esModule: true, default: { name: "IRCColors" } },
        "@plugins/mentionAvatars": { __esModule: true, default: { name: "MentionAvatars" } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/index": { classNameFactory: () => () => "names" },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack": { findStoreLazy: (name: string) => name === "UserStore" ? { getUser: (id: string) => users.get(id) } : { useReducedMotion: false },
            findByCodeLazy: (code: string) => code === "lastIndex;return" ? (name: string) => { wraps++; return name; } : () => ({}) },
        "@webpack/common": { ChannelStore: { getChannel: () => ({ id: "channel", guild_id: "guild", isDM: () => false, isGroupDM: () => false }) },
            GuildMemberStore: { getMember: (_guild: string, id: string) => ({ id, nick: users.get(id)?.nick }) },
            GuildStore: { getGuild: () => ({ premiumFeatures: { features: [] } }) },
            MessageStore: { getMessage: () => null }, RelationshipStore: { getNickname: () => friend }, StreamerModeStore: streamer }
    };
    const { outputText } = transpileModule(readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\nexports.default;`, { exports: {},
        React: { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]): Element => { elements++; return { type, props, children }; } },
        document: { documentElement: {} },
        getComputedStyle: () => { reads++; return { getPropertyValue: (name: string) => name === "--text-strong" ? "#ffffff" : "#72767d" }; },
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }
    }) as { getMessageNameText(props: object): string | null; getMessageNameElement(props: object): Element | null;
        getTypingMemberListProfilesReactionsVoiceNameText(props: object): string | null; };
    const user: User = { id: "user", username: "username", globalName: "Display", nick: "Nickname" };
    store.animateGradients = true;
    store.ignoreGradients = false;
    users.set(user.id, user);
    const message = { id: "message", channel_id: "channel", author: user };
    return { api, store, user, streamer, message,
        text: () => api.getMessageNameText({ message }), element: () => api.getMessageNameElement({ message }),
        friend: (name: string) => friend = name, counts: () => ({ reads, wraps, elements }) };
}

test("Disabled name surfaces return before style reads, emoji wrapping or element allocation", () => {
    const f = fixture();
    f.store.messages = false;
    for (let i = 0; i < 100; i++) assert.equal(f.element(), null);
    assert.deepEqual(f.counts(), { reads: 0, wraps: 0, elements: 0 });
});

test("Text-only name getters preserve selection while skipping all visual work", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) {
        assert.equal(f.text(), "Nickname Display username");
        assert.equal(f.api.getTypingMemberListProfilesReactionsVoiceNameText({ user: f.user, type: "typingIndicator" }), "Nickname");
    }
    assert.deepEqual(f.counts(), { reads: 0, wraps: 0, elements: 0 });
});

test("Visual names resolve theme properties once and retain the text result", () => {
    const f = fixture();
    assert.ok(f.element());
    assert.equal(f.counts().reads, 1);
    assert.ok(f.counts().elements > 0);
    assert.equal(f.text(), "Nickname Display username");
    assert.equal(f.counts().reads, 1);
});

test("Name selection retains fallbacks, duplicate precedence, streamer mode and bot suffixes", () => {
    const f = fixture();
    f.friend("Friend"); assert.equal(f.text(), "Friend Display username");
    f.friend("username"); assert.equal(f.text(), "Display username");
    f.friend("Display"); assert.equal(f.text(), "Display username");
    f.store.removeDuplicates = false; assert.equal(f.text(), "Display Display username");
    f.streamer.enabled = true; assert.equal(f.text(), "D... D... u...");
    f.streamer.enabled = false; f.user.bot = true; f.user.discriminator = "1234";
    assert.equal(f.text(), "Display username username#1234");
    f.store.includedNames = "{custom}"; assert.equal(f.text(), "username#1234");
});

if (process.env.AUDIT_NAME_REFERENCE_SOURCE) test("Selected name text and visual output match the preceding implementation", () => {
    const actual = fixture();
    const reference = fixture(process.env.AUDIT_NAME_REFERENCE_SOURCE);
    for (const includedNames of ["{custom, friend, nick} [{display}] (@{user})", "{user} {display} {nick}", "{user} {user} {display} {display} {nick}", "{custom}"]) {
        for (const removeDuplicates of [false, true]) for (const animateGradients of [false, true]) for (const ignoreGradients of [false, true]) {
            for (const friend of ["", "Display", "username"]) {
                for (const f of [actual, reference]) {
                    Object.assign(f.store, { includedNames, removeDuplicates, animateGradients, ignoreGradients });
                    f.friend(friend);
                }
                assert.equal(actual.text(), reference.text());
                assert.equal(JSON.stringify(actual.element()), JSON.stringify(reference.element()));
            }
        }
    }
});
