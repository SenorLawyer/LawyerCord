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

interface Element { type: () => Element; props: Record<string, unknown>; }
interface Subscription { stores: unknown[]; select: () => unknown; equal: (a: unknown, b: unknown) => boolean; }

function fixture(relative: string, override: string) {
    const path = process.env[override] ?? `src/equicordplugins/hideServers/${relative}`;
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    const hidden = { hiddenGuilds: new Set(["first"]) };
    const guilds = new Set(["first"]);
    const guildStore = { getGuild: (id: string) => guilds.has(id) ? { id } : undefined };
    const subscriptions: Subscription[] = [];
    const modules: Record<string, unknown> = {
        "@api/ContextMenu": {}, "@api/ServerList": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@utils/css": { classNameFactory: () => () => "" }, "@webpack": { findStoreLazy: () => ({}) },
        "@webpack/common": { Button: { Looks: {}, Sizes: {} }, GuildStore: guildStore,
            useStateFromStores: (stores: unknown[], select: () => unknown, _deps?: unknown[], equal = Object.is) => { subscriptions.push({ stores, select, equal }); return select(); } },
        "./HiddenServersStore": { HiddenServersStore: hidden }, "@equicordplugins/hideServers/HiddenServersStore": { HiddenServersStore: hidden },
        "./components/HiddenServersButton": {}, "./settings": {}, "./HiddenServersMenu": {}, "./style.css": {},
        "react/jsx-runtime": { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) }
    };
    const exports: Record<string, unknown> = {};
    runInNewContext(outputText, { exports, Set, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    return { plugin: exports.default as { useStore(): void; useFilteredGuilds(guilds: object[]): object[]; },
        component: exports.default as () => Element, hidden, guilds, guildStore, subscriptions };
}

test("HideServers updates the guild list when one hidden guild replaces another with the same count", () => {
    const f = fixture("index.tsx", "AUDIT_HIDDEN_GUILDS_SOURCE");
    const guilds = [{ type: "guild", id: "first", children: [] }, { type: "guild", id: "second", children: [] }];
    assert.deepEqual(f.plugin.useFilteredGuilds(guilds).map(guild => (guild as { id: string; }).id), ["second"]);
    f.plugin.useStore();
    const previous = f.hidden.hiddenGuilds;
    f.hidden.hiddenGuilds = new Set(["second"]);
    for (const subscription of f.subscriptions) {
        assert.equal(subscription.equal(previous, subscription.select()), false);
        assert.equal(subscription.equal(previous, previous), true);
    }
    assert.deepEqual(f.plugin.useFilteredGuilds(guilds).map(guild => (guild as { id: string; }).id), ["first"]);
});

test("HideServers counts joined hidden guilds inside a selector subscribed to both stores", () => {
    const f = fixture("components/HiddenServersButton.tsx", "AUDIT_HIDDEN_COUNT_SOURCE");
    const render = f.component().type;
    render();
    const [subscription] = f.subscriptions;
    assert.ok(subscription.stores.includes(f.guildStore));
    assert.equal(subscription.select(), 1);
    f.guilds.delete("first");
    assert.equal(subscription.select(), 0);
    f.hidden.hiddenGuilds = new Set(["folder-42", "second"]);
    f.guilds.add("second");
    assert.equal(subscription.select(), 1);
});
