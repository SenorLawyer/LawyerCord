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
    let userId = "self";
    const channel = (id: string) => ({ id, isGroupDM: () => id === "group" });
    const channels = [channel("offscreen"), channel("answered"), channel("group")];
    const message = (id: string, authorId = "peer") => ({ id, content: "Hello?", author: { id: authorId, bot: false }, timestamp: new Date() });
    const messages = new Map(channels.map(c => [c.id, message(c.id, c.id === "answered" ? "self" : "peer")]));
    const store = { showDmIcons: true, ignoreBots: true, ignoreGroupDms: false, exemptedChannels: "", maxInactiveTimeMs: 0, clearedChannels: {} as Record<string, string> };
    const modules: Record<string, unknown> = {
        "@webpack": { findCssClassesLazy: () => ({ wrapper: "native" }) },
        "@webpack/common": {
            ChannelStore: { getSortedPrivateChannels: () => channels },
            MessageStore: { getLastMessage: (id: string) => messages.get(id), getMessages: (id: string) => ({ last: () => messages.get(id) }) },
            UserStore: { getCurrentUser: () => userId ? { id: userId } : null },
            useStateFromStores: (_stores: unknown[], select: () => unknown) => select(),
            useState: () => assert.fail("Message-derived state must not be mirrored."),
            useEffect: () => assert.fail("Rendering must not own global counts.")
        },
        ".": { cl: () => "ghost", settings: { store, plain: store, use: () => store } },
        "./IconGhost": { IconGhost: "icon" }
    };
    const code = transpileModule(readFileSync("src/equicordplugins/ghosted/Boo.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(`${code}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) }
    });
    return { api, store, messages, channels, setUser: (id: string) => { userId = id; } };
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
    messages.set("offscreen", { ...previous, id: "new", content: "New message" });
    assert.ok(render());
    store.showDmIcons = false;
    assert.equal(render(), null);
    store.showDmIcons = true;
    setUser("");
    assert.equal(render(), null);
});
