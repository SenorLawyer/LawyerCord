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

import { ChannelUnreadState, reconcileUnreadFallbackCache } from "../src/equicordplugins/channelTabs/util/unreadState";

type Fallbacks = Record<string, Record<string, number>>;

function state(channelId: string, unreadCount: number, hasUnread = true): ChannelUnreadState {
    return { channelId, unreadCount, hasUnread, mentionCount: 0 };
}

function fixture() {
    let persisted: Fallbacks = { other: { saved: 9 } };
    let failLoad = false;
    let reads = 0;
    let loadGate: Promise<void> | undefined;
    let failSave = false;
    const writes: (() => void)[] = [];
    const errors: unknown[] = [];
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/channelTabs/util/unread.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const mocks: Record<string, unknown> = {
        "@api/index": { DataStore: {
            get: async () => { reads++; await loadGate; if (failLoad) throw new Error("Storage unavailable"); return persisted; },
            update: (_key: string, updater: (old: Fallbacks) => Fallbacks) => new Promise<void>((resolve, reject) => {
                writes.push(() => {
                    if (failSave) { reject(new Error("Storage unavailable")); return; }
                    persisted = updater(persisted); resolve();
                });
            })
        } },
        "@equicordplugins/channelTabs/util/unreadState": { reconcileUnreadFallbackCache },
        "./constants": { logger: { error: (...args: unknown[]) => errors.push(args) } }
    };
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    }) as {
        ensureUnreadFallbackCountsLoaded(userId: string): Promise<Record<string, number>>;
        updateUnreadFallbackCounts(userId: string, states: ChannelUnreadState[]): void;
        getUnreadFallbackCounts(userId: string): Record<string, number>;
    };
    return {
        api, writes, errors, stored: () => persisted, reads: () => reads,
        failLoad: (value: boolean) => { failLoad = value; }, failSave: (value: boolean) => { failSave = value; },
        delayLoad: (gate: Promise<void>) => { loadGate = gate; }
    };
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("unread fallback reconciliation keeps the same snapshot when nothing changes", () => {
    const cached = { a: 4, b: 2 };
    assert.equal(reconcileUnreadFallbackCache(cached, [state("a", 4), state("b", 0)]), cached);
    const updated = reconcileUnreadFallbackCache(cached, [state("a", 5), state("b", 0, false)]);
    assert.deepEqual(updated, { a: 5 });
    assert.deepEqual(cached, { a: 4, b: 2 });
});

test("unread fallback writes coalesce bursts and preserve other accounts", async () => {
    const f = fixture();
    await f.api.ensureUnreadFallbackCountsLoaded("self");
    f.api.updateUnreadFallbackCounts("self", [state("a", 1)]);
    await flush();
    assert.equal(f.writes.length, 1);
    for (let count = 2; count <= 100; count++) f.api.updateUnreadFallbackCounts("self", [state("a", count)]);
    await flush();
    f.writes.shift()?.();
    await flush();
    assert.equal(f.writes.length, 1);
    f.writes.shift()?.();
    await flush();
    assert.equal(f.writes.length, 0);
    assert.equal(f.stored().self.a, 100);
    assert.equal(f.stored().other.saved, 9);
    f.api.updateUnreadFallbackCounts("self", [state("a", 100)]);
    await flush();
    assert.equal(f.writes.length, 0);
});

test("failed unread fallback loads allow retry", async () => {
    const f = fixture();
    f.failLoad(true);
    await assert.rejects(f.api.ensureUnreadFallbackCountsLoaded("self"), /Storage unavailable/);
    f.failLoad(false);
    await f.api.ensureUnreadFallbackCountsLoaded("self");
    assert.equal(f.reads(), 2);
});

test("a failed load with live updates retries without discarding saved channels", async () => {
    const f = fixture();
    f.failLoad(true);
    f.api.updateUnreadFallbackCounts("other", [state("live", 3)]);
    await flush();
    assert.equal(f.errors.length, 1);
    assert.equal(f.writes.length, 0);
    f.failLoad(false);
    await f.api.ensureUnreadFallbackCountsLoaded("other");
    assert.equal(f.api.getUnreadFallbackCounts("other").saved, 9);
    assert.equal(f.api.getUnreadFallbackCounts("other").live, 3);
});

test("unread changes wait for hydration and retain saved channels in that account", async () => {
    const f = fixture();
    let release: () => void = () => assert.fail("Load not started");
    f.delayLoad(new Promise<void>(resolve => { release = resolve; }));
    const loading = f.api.ensureUnreadFallbackCountsLoaded("other");
    f.api.updateUnreadFallbackCounts("other", [state("live", 3)]);
    await flush();
    assert.equal(f.writes.length, 0);
    release();
    await loading;
    await flush();
    f.writes.shift()?.();
    await flush();
    assert.equal(f.stored().other.saved, 9);
    assert.equal(f.stored().other.live, 3);
});

test("unread fallback writes recover after failure and keep concurrent accounts separate", async () => {
    const f = fixture();
    await f.api.ensureUnreadFallbackCountsLoaded("self");
    await f.api.ensureUnreadFallbackCountsLoaded("other");
    f.failSave(true);
    f.api.updateUnreadFallbackCounts("self", [state("a", 1)]);
    await flush();
    f.writes.shift()?.();
    await flush();
    assert.equal(f.errors.length, 1);
    f.failSave(false);
    f.api.updateUnreadFallbackCounts("self", [state("a", 2)]);
    f.api.updateUnreadFallbackCounts("other", [state("b", 4)]);
    await flush();
    assert.equal(f.writes.length, 2);
    for (const write of f.writes.splice(0)) write();
    await flush();
    assert.equal(f.stored().self.a, 2);
    assert.equal(f.stored().other.b, 4);
    assert.equal(f.stored().other.saved, 9);
});

test("badge subscriptions compare derived values and follow channel and account changes", () => {
    const subscriptions: { stores: unknown[]; mapper: () => unknown; deps?: unknown[]; equal?: (a: unknown, b: unknown) => boolean; }[] = [];
    const store = { getCurrentUser: () => ({ id: "self" }) };
    const channels = { getChannel: () => undefined };
    const unread = { getUnreadCount: () => 2, hasUnread: () => true, getMentionCount: () => 0 };
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const mocks: Record<string, unknown> = {
        "@components/BaseText": {},
        "@equicordplugins/channelTabs/util": {
            settings: { use: () => ({ persistUnreadCountFallback: false }) }, getUnreadFallbackCounts: () => ({}),
            getNotificationDotState: () => ({ shouldShow: false })
        },
        "@equicordplugins/channelTabs/util/icons": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {}, "@utils/misc": {},
        "@webpack": { findComponentByCodeLazy: () => () => null, findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            UserStore: store, ChannelStore: channels, ReadStateStore: unread, ActiveJoinedThreadsStore: {},
            useState: () => [0, () => {}], useEffect: () => {}, lodash: { isEqual: equal },
            useStateFromStores: (stores: unknown[], mapper: () => unknown, deps?: unknown[], equal?: (a: unknown, b: unknown) => boolean) => {
                subscriptions.push({ stores, mapper, deps, equal }); return mapper();
            }
        }, "./ContextMenus": {}
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/channelTabs/components/ChannelTab.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    api.NotificationDot({ channelIds: ["a"] });
    assert.equal(subscriptions[0].stores.length, 1);
    assert.equal(subscriptions[0].stores[0], store);
    const badge = subscriptions[1];
    assert.ok(badge.stores.includes(channels));
    assert.equal(badge.deps?.[0], "a");
    const previous = badge.mapper();
    assert.equal(badge.equal?.(previous, badge.mapper()), true);
    unread.getUnreadCount = () => 3;
    assert.equal(badge.equal?.(previous, badge.mapper()), false);
    api.NotificationDot({ channelIds: ["b"] });
    assert.equal(subscriptions[3].deps?.[0], "b");
});
