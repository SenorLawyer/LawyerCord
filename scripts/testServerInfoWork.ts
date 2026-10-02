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
    let icons = 0;
    let enumerations = 0;
    const guilds = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), { id: String(i), icon: "icon", name: `Guild ${i}` }]));
    const members = new Map(Object.keys(guilds).map(id => [id, new Set(["self", "a", "b"])]));
    const subscriptions: { stores: unknown[]; select(): unknown; equal?: (left: unknown, right: unknown) => boolean; }[] = [];
    const requests: object[] = [];
    const GuildMemberStore = { isMember: (guild: string, id: string) => members.get(guild)?.has(id), getMemberIds: (guild: string) => [...(members.get(guild) ?? [])] };
    const GuildStore = { getGuilds: () => { enumerations++; return guilds; } };
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
    const common = {
        GuildStore, GuildMemberStore,
        UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: (id: string) => ({ id, username: id }) },
        RelationshipStore: { getFriendIDs: () => ["missing"], getBlockedIDs: () => [], getIgnoredIDs: () => [] },
        PresenceStore: { getStatus: () => "offline" },
        IconUtils: { getGuildIconURL: () => { icons++; return "icon"; } },
        FluxDispatcher: { dispatch: (request: object) => requests.push(request) },
        useStateFromStores: (stores: unknown[], select: () => unknown, _deps: unknown, equal: (left: unknown, right: unknown) => boolean) => {
            subscriptions.push({ stores, select, equal });
            return select();
        },
        useState: (value: unknown) => [value, () => {}], useEffect: (effect: () => void) => effect()
    };
    const mocks: Record<string, unknown> = {
        "./styles.css": {}, "@components/Heading": {}, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/discord": {}, "@utils/misc": {}, "@utils/react": {},
        "@webpack": { findComponentByCodeLazy: () => "row", findCssClassesLazy: () => ({}) },
        "@webpack/common": common, ".": { settings: { store: { sorting: "none" } } }
    };
    const source = readFileSync(process.env.AUDIT_SERVER_INFO_SOURCE ?? "src/plugins/serverInfo/GuildInfoModal.tsx", "utf8");
    const { outputText } = transpileModule(source + "\nexport const audit = { getMutualGuilds, MutualMembersTab, FriendsTab };", {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\nexports.audit;`, {
        exports: {}, React, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    }) as {
        getMutualGuilds(id: string, guilds: object[]): { id: string; mutualCount: number; mutualGuilds: object[]; };
        MutualMembersTab(props: object): unknown; FriendsTab(props: object): unknown;
    };
    return { api, guilds, members, subscriptions, requests, GuildMemberStore, GuildStore, work: () => ({ icons, enumerations }) };
}

test("Mutual guild summaries retain all counts while creating only three displayed icons", () => {
    const f = fixture();
    const summary = f.api.getMutualGuilds("a", Object.values(f.guilds));
    assert.equal(summary.mutualCount, 100);
    assert.equal(summary.mutualGuilds.length, 3);
    assert.equal(f.work().icons, 3);
});

test("Mutual members read joined guilds once, skip self and react to membership replacements", () => {
    const f = fixture();
    f.api.MutualMembersTab({ guild: f.guilds["0"], setCount() {} });
    assert.deepEqual(f.work(), { icons: 6, enumerations: 1 });
    const subscription = f.subscriptions.find(entry => entry.stores.includes(f.GuildMemberStore) && entry.stores.includes(f.GuildStore));
    assert.ok(subscription);
    const previous = subscription.select();
    assert.equal(subscription.equal?.(previous, subscription.select()), true);
    for (const members of f.members.values()) { members.delete("a"); members.add("c"); }
    const current = subscription.select() as { id: string; }[];
    assert.deepEqual(Array.from(current, member => member.id), ["b", "c"]);
    assert.equal(subscription.equal?.(previous, current), false);
});

test("Separate server info modals independently request missing relationship members", () => {
    const f = fixture();
    for (const id of ["0", "1"]) f.api.FriendsTab({ guild: f.guilds[id], setCount() {} });
    assert.equal(f.requests.length, 2);
});
