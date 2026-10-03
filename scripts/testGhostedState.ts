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

interface GhostSettings {
    showDmIcons: boolean;
    ignoreBots: boolean;
    ignoreGroupDms: boolean;
    exemptedChannels: string;
    maxInactiveTimeMs: number;
    clearedChannels?: Record<string, string>;
    clearedChannelsByUser?: Record<string, Record<string, string>>;
}

function fixture(saved?: GhostSettings) {
    let userId = "self";
    const channel = (id: string) => ({ id, lastMessageId: "200", recipients: ["peer"], isGroupDM: () => id === "group" });
    const channels = [channel("offscreen"), channel("answered"), channel("group")];
    const message = (id: string, authorId = "peer") => ({ id, content: "Hello?", author: { id: authorId, bot: false }, timestamp: new Date() });
    const messages = new Map(channels.map(c => [c.id, message("200", c.id === "answered" ? "self" : "peer")]));
    const settingsStore = new SettingsStore<GhostSettings>(saved ?? { showDmIcons: true, ignoreBots: true, ignoreGroupDms: false, exemptedChannels: "", maxInactiveTimeMs: 0, clearedChannels: {} });
    const { store } = settingsStore;
    const changes: string[] = [];
    settingsStore.addGlobalChangeListener((_values, path) => changes.push(path));
    const react = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
    const modules: Record<string, unknown> = {
        "@webpack": { findCssClassesLazy: () => ({ wrapper: "native" }), findByPropsLazy: () => ({ selectPrivateChannel() {} }), findComponentByCodeLazy: () => "group-icon" },
        "@webpack/common": {
            SnowflakeUtils: { compare: (first: string, second: string) => BigInt(first) < BigInt(second) ? -1 : BigInt(first) > BigInt(second) ? 1 : 0 },
            ChannelStore: { getSortedPrivateChannels: () => channels, getChannel: (id: string) => channels.find(channel => channel.id === id) },
            MessageStore: { getLastMessage: (id: string) => messages.get(id), getMessages: (id: string) => ({ last: () => messages.get(id) }) },
            UserStore: { getCurrentUser: () => userId ? { id: userId } : null, getUser: () => ({ username: "Peer", getAvatarURL: () => "avatar" }) },
            React: react, Modal: "modal", Avatar: "avatar", Text: "text", lodash: {},
            Button: Object.assign(() => {}, { Sizes: { SMALL: "small" }, Colors: { PRIMARY: "primary" } }),
            useStateFromStores: (_stores: unknown[], select: () => unknown) => select(),
            useState: () => assert.fail("Message-derived state must not be mirrored."),
            useEffect: () => assert.fail("Rendering must not own global counts.")
        },
        ".": { cl: () => "ghost", settings: { store, get plain() { return settingsStore.plain; }, use: () => store } },
        "./IconGhost": { IconGhost: "icon" },
        "@utils/css": { classNameFactory: () => () => "ghost" }
    };
    const code = transpileModule(readFileSync("src/equicordplugins/ghosted/Boo.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(`${code}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        React: react
    });
    modules["./Boo"] = api;
    const modalCode = transpileModule(readFileSync("src/equicordplugins/ghosted/GhostedUsersModal.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const modalApi = runInNewContext(`${modalCode}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }
    });
    return { api, store, messages, channels, changes, modal: (clear = api.clearChannelFromGhost) => modalApi.GhostedUsersModal({ modalProps: { onClose() {} }, onClearGhost: clear }), save: () => structuredClone(settingsStore.plain), setUser: (id: string) => { userId = id; } };
}

test("ghost counts include offscreen DMs without mounting their rows", () => {
    const { api, store, channels, setUser } = fixture();
    assert.deepEqual(Array.from(api.getGhostedChannels()), ["offscreen", "group"]);
    store.ignoreGroupDms = true;
    assert.deepEqual(Array.from(api.getGhostedChannels()), ["offscreen"]);
    store.exemptedChannels = " offscreen ";
    assert.equal(api.getGhostedChannels().length, 0);
    store.exemptedChannels = "";
    setUser("peer");
    assert.deepEqual(Array.from(api.getGhostedChannels()), ["answered"]);
    channels.length = 0;
    assert.equal(api.getGhostedChannels().length, 0);
});

test("ghost rows derive current messages and saved clear markers without effect updates", () => {
    const { api, store, messages, channels, setUser } = fixture();
    const render = () => api.Boo({ channel: channels[0] });
    assert.ok(render());
    api.clearChannelFromGhost("offscreen");
    assert.equal(render(), null);
    const previous = messages.get("offscreen");
    assert.ok(previous);
    messages.set("offscreen", { ...previous, id: "300", content: "New message" });
    assert.ok(render());
    store.showDmIcons = false;
    assert.equal(render(), null);
    store.showDmIcons = true;
    setUser("");
    assert.equal(render(), null);
});

test("saved clears remain cleared after reload with an older cached message and only new messages restore ghosts", () => {
    const original = fixture();
    original.api.clearChannelFromGhost("offscreen");
    assert.ok(original.changes.length > 0, "clearing must notify the persistence layer immediately");
    const restored = fixture(original.save());
    const message = restored.messages.get("offscreen");
    assert.ok(message);
    restored.messages.set("offscreen", { ...message, id: "100" });
    assert.equal(restored.api.getGhostedChannels().includes("offscreen"), false);
    restored.api.clearChannelFromGhost("offscreen");
    restored.messages.set("offscreen", { ...message, id: "200" });
    assert.equal(restored.api.getGhostedChannels().includes("offscreen"), false, "an older cached clear cannot lower the saved high water mark");
    restored.messages.set("offscreen", { ...message, id: "300" });
    assert.equal(restored.api.getGhostedChannels().includes("offscreen"), true);
});

test("clearing a shared group DM belongs to the current account and survives switching back", () => {
    const f = fixture();
    f.api.clearChannelFromGhost("group");
    assert.equal(f.api.getGhostedChannels().includes("group"), false);
    f.setUser("other-self");
    assert.equal(f.api.getGhostedChannels().includes("group"), true);
    f.setUser("self");
    assert.equal(f.api.getGhostedChannels().includes("group"), false);
    const restored = fixture(f.save());
    assert.equal(restored.api.getGhostedChannels().includes("group"), false);
});

test("multiple immediate clears persist together without waiting for another message", () => {
    const f = fixture();
    f.api.clearChannelFromGhost("offscreen");
    f.api.clearChannelFromGhost("group");
    assert.equal(f.api.getGhostedChannels().length, 0);
    assert.equal(fixture(f.save()).api.getGhostedChannels().length, 0);
    f.setUser("");
    const before = f.changes.length;
    f.api.clearChannelFromGhost("group");
    assert.equal(f.changes.length, before);
});

test("legacy saved clears migrate once to the active account without discarding the old saved format", () => {
    const f = fixture();
    f.store.clearedChannels = { group: "200" };
    f.api.migrateClearedChannels();
    assert.equal(f.api.getGhostedChannels().includes("group"), false);
    f.setUser("other-self");
    f.api.migrateClearedChannels();
    assert.equal(f.api.getGhostedChannels().includes("group"), true);
    f.api.clearChannelFromGhost("group");
    assert.equal(f.api.getGhostedChannels().includes("group"), false);
    assert.equal(f.save().clearedChannels?.group, "200");
    assert.equal(f.save().clearedChannelsByUser?.self.group, "200");
    assert.equal(f.save().clearedChannelsByUser?.["other-self"].group, "200");
});

test("clearing an unloaded DM persists its latest channel message marker", () => {
    const f = fixture();
    f.messages.delete("offscreen");
    f.api.clearChannelFromGhost("offscreen");
    const restored = fixture(f.save());
    assert.equal(restored.api.getGhostedChannels().includes("offscreen"), false);
});

test("clearing a partially loaded DM covers its latest known message through hydration and reload", () => {
    const f = fixture();
    const message = f.messages.get("offscreen");
    assert.ok(message);
    f.messages.set("offscreen", { ...message, id: "100" });
    f.channels[0].lastMessageId = "300";
    f.api.clearChannelFromGhost("offscreen");
    const restored = fixture(f.save());
    for (const id of ["200", "300"]) {
        restored.messages.set("offscreen", { ...message, id });
        assert.equal(restored.api.getGhostedChannels().includes("offscreen"), false);
    }
    restored.messages.set("offscreen", { ...message, id: "400" });
    assert.equal(restored.api.getGhostedChannels().includes("offscreen"), true);
});

test("the open modal follows current saved clears, incoming messages and account switches", () => {
    const f = fixture();
    assert.equal(f.modal().props.title, "Ghosted Users (2)");
    f.api.clearChannelFromGhost("offscreen");
    assert.equal(f.modal().props.title, "Ghosted Users (1)");
    const message = f.messages.get("offscreen");
    assert.ok(message);
    f.messages.set("offscreen", { ...message, id: "300" });
    assert.equal(f.modal().props.title, "Ghosted Users (2)");
    f.modal().props.actions[0].onClick();
    assert.equal(f.modal().props.title, "Ghosted Users (0)");
    assert.equal(fixture(f.save()).api.getGhostedChannels().length, 0);
    f.setUser("other-self");
    assert.equal(f.modal().props.title, "Ghosted Users (3)");
});

test("the modal cannot pretend Clear All was saved when its clear callback makes no change", () => {
    const f = fixture();
    const modal = f.modal(() => {});
    modal.props.actions[0].onClick();
    assert.equal(f.modal().props.title, "Ghosted Users (2)");
});
