/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";

function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, suffix = "exports"): T {
    const source = ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React }
    }).outputText;
    return runInNewContext(source + "\n" + suffix, {
        exports: {}, Map, ...globals,
        require: (name: string) => {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`);
            return mocks[name];
        }
    });
}

interface TestUser {
    id: string;
    username: string;
    avatar: string;
    globalName?: string;
    guildMemberAvatars: Record<string, string>;
}

interface ReactionSnapshot {
    userIds: string[];
    users: (Pick<TestUser, "id" | "username" | "avatar" | "globalName"> & { discriminator?: string; guildAvatar?: string })[];
    guildId: string;
    generation: number;
    userId: string;
}

test("WhoReacted ignores unrelated user changes but updates reactor snapshots and conversation state", () => {
    const selectors: (() => ReactionSnapshot)[] = [];
    const effects: (() => void)[] = [];
    let account = "account";
    let guildId = "guild";
    let version = 0;
    let queued = 0;
    let anchors = 0;
    const users = new Map<string, TestUser>([
        ["reactor", { id: "reactor", username: "Before", avatar: "old", guildMemberAvatars: { guild: "old-guild" } }],
        ["other", { id: "other", username: "Unrelated", avatar: "other", guildMemberAvatars: {} }]
    ]);
    let compare: (a: ReactionSnapshot, b: ReactionSnapshot) => boolean = () => false;
    const module = load<{
        plugin: { reactions: Record<string, { fetched: boolean; users: Map<string, TestUser> }> };
        ReactionUsers(props: { message: { id: string; channel_id: string }; emoji: { name: string }; type: number }): void;
    }>("src/plugins/whoReacted/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ use: () => ({ avatarClick: false }) }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/lazy": { makeLazy: (factory: () => unknown) => factory },
        "@utils/misc": {},
        "@utils/Queue": { Queue: class { unshift() { queued++; } } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack": { findStoreLazy: () => ({}) },
        "@webpack/common": {
            React: {
                createContext: () => ({}), createElement: () => null,
                useContext: () => ({ scrollCounter: 1, setAutomaticAnchor: () => anchors++ })
            },
            UserStore: { getCurrentUser: () => ({ id: account }), getUser: (id: string) => users.get(id), getUserStoreVersion: () => version },
            ChannelStore: { getChannel: () => ({ guild_id: guildId }) },
            lodash: { isEqual: isDeepStrictEqual },
            useStateFromStores: (_stores: unknown[], select: () => ReactionSnapshot, _deps: unknown[], equal: typeof compare) => {
                selectors.push(select);
                compare = equal;
                return select();
            },
            useEffect: (effect: () => void) => effects.push(effect),
            useLayoutEffect: (effect: () => void) => effect()
        }
    }, {}, "({ plugin: exports.default, ReactionUsers })");
    const reactor = users.get("reactor");
    assert.ok(reactor);
    Object.defineProperty(reactor, "unrelatedPayload", {
        enumerable: true,
        get: () => assert.fail("Selectors must not copy or inspect unrelated User properties")
    });
    const cache = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}:wave::0`, { fetched: true, users: new Map([[reactor.id, reactor]]) }]));
    module.plugin.reactions = cache;
    for (let i = 0; i < 50; i++) module.ReactionUsers({ message: { id: `m${i}`, channel_id: "channel" }, emoji: { name: "wave" }, type: 0 });
    const initial = selectors.map(select => select());
    const other = users.get("other");
    assert.ok(other);
    other.username = "Changed";
    version++;
    assert.equal(selectors.filter((select, i) => !compare(initial[i], select())).length, 0);
    reactor.username = "Renamed";
    assert.equal(compare(initial[0], selectors[0]()), false);
    let previous = selectors[0]();
    reactor.avatar = "new";
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    reactor.guildMemberAvatars.guild = "new-guild";
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    reactor.guildMemberAvatars.unrelated = "another-guild";
    assert.equal(compare(previous, selectors[0]()), true);
    reactor.globalName = "Display";
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    guildId = "replacement";
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    account = "replacement";
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    cache["m0:wave::0"].users.clear();
    assert.equal(compare(previous, selectors[0]()), false);
    previous = selectors[0]();
    module.plugin.reactions = {};
    assert.notEqual(previous.generation, selectors[0]().generation);
    assert.equal(queued, 0);
    assert.equal(anchors, 50);
    assert.equal(effects.length, 50);
});

interface SavedSession { name: string; isNew: boolean }
interface SessionApi {
    savedSessionsCache: Map<string, SavedSession>;
    fetchSessionFromDataStore(id: string): Promise<SavedSession | undefined>;
    saveSessionsToDataStore(update: (sessions: Map<string, SavedSession>) => void): Promise<void>;
}

function sessionsFixture() {
    let account: string | undefined = "first";
    let writes = 0;
    const requests: { key: string; resolve(value: unknown): void; reject(error: Error): void }[] = [];
    const api = load<SessionApi>("src/plugins/betterSessions/utils.ts", {
        "@api/DataStore": {
            get: (key: string) => new Promise<unknown>((resolve, reject) => requests.push({ key, resolve, reject })),
            update: async () => { writes++; }
        },
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": { UserStore: { getCurrentUser: () => account ? { id: account } : undefined } },
        "./components/icons": {}
    });
    return { api, requests, switchAccount: (id?: string) => { account = id; }, writes: () => writes };
}

test("BetterSessions shares only pending account reads and validates once without changing discovery state", async () => {
    const { api, requests, writes } = sessionsFixture();
    let validated = 0;
    class CountedMap extends Map<string, SavedSession> {
        *[Symbol.iterator](): Generator<[string, SavedSession], undefined, unknown> {
            for (const entry of super[Symbol.iterator]()) { validated++; yield entry; }
            return undefined;
        }
    }
    const stored = new CountedMap(Array.from({ length: 20 }, (_, i) => [String(i), { name: `Device ${i}`, isNew: false }]));
    const discovery = { name: "Discovery", isNew: true };
    api.savedSessionsCache.set("0", discovery);
    const pending = Array.from({ length: 20 }, (_, i) => api.fetchSessionFromDataStore(String(i)));
    assert.equal(requests.length, 1);
    requests[0].resolve(stored);
    assert.deepEqual((await Promise.all(pending)).map(value => value?.name), Array.from({ length: 20 }, (_, i) => `Device ${i}`));
    assert.equal(validated, 20);
    assert.equal(api.savedSessionsCache.get("0"), discovery);
    const reopened = api.fetchSessionFromDataStore("0");
    assert.equal(requests.length, 2);
    requests[1].resolve(new Map([["0", { name: "External rename", isNew: false }]]));
    assert.equal((await reopened)?.name, "External rename");
    assert.equal(writes(), 0);
});

test("BetterSessions isolates concurrent accounts and ignores logout or account changes", async () => {
    const { api, requests, switchAccount } = sessionsFixture();
    const first = api.fetchSessionFromDataStore("session");
    switchAccount("second");
    const second = api.fetchSessionFromDataStore("session");
    assert.deepEqual(requests.map(request => request.key), ["BetterSessions_savedSessions_first", "BetterSessions_savedSessions_second"]);
    requests[0].resolve(new Map([["session", { name: "First", isNew: false }]]));
    requests[1].resolve(new Map([["session", { name: "Second", isNew: false }]]));
    assert.equal(await first, undefined);
    assert.equal((await second)?.name, "Second");
    const logout = api.fetchSessionFromDataStore("session");
    switchAccount();
    requests[2].resolve(new Map([["session", { name: "Second", isNew: false }]]));
    assert.equal(await logout, undefined);
});

test("BetterSessions shared failures preserve malformed records and allow fresh retries", async () => {
    for (const malformed of [null, [], new Map([["session", { name: 42, isNew: false }]])]) {
        const { api, requests, writes } = sessionsFixture();
        const first = assert.rejects(api.fetchSessionFromDataStore("session"), /invalid/);
        const second = assert.rejects(api.fetchSessionFromDataStore("session"), /invalid/);
        assert.equal(requests.length, 1);
        requests[0].resolve(malformed);
        await Promise.all([first, second]);
        assert.equal(writes(), 0);
        assert.equal(api.savedSessionsCache.size, 0);
        const retry = api.fetchSessionFromDataStore("session");
        assert.equal(requests.length, 2);
        requests[1].resolve(new Map([["session", { name: "Recovered", isNew: false }]]));
        assert.equal((await retry)?.name, "Recovered");
        const failed = assert.rejects(api.fetchSessionFromDataStore("session"), /Unavailable/);
        requests[2].reject(new Error("Unavailable"));
        await failed;
        const recovered = api.fetchSessionFromDataStore("session");
        requests[3].resolve(undefined);
        assert.equal(await recovered, undefined);
    }
});

test("CallTimer mounts ticking work only while visible and keeps settings reactive", () => {
    const source = readFileSync("src/utils/react.tsx", "utf8");
    const ast = ts.createSourceFile("react.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useFixedTimer");
    assert.ok(hook);
    const intervals = new Map<number, () => void>();
    const cleanups: (() => void)[] = [];
    let id = 0;
    const useFixedTimer = runInNewContext(ts.transpileModule(hook.getText(ast).replace("export ", ""), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText + "\nuseFixedTimer", {
        useState: (value: number) => [value, () => {}],
        useEffect: (effect: () => () => void) => cleanups.push(effect()),
        setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 1000); intervals.set(++id, callback); return id; },
        clearInterval: (key: number) => intervals.delete(key)
    });
    const store = { trackSelf: false, format: "human", showSeconds: true, showRoleColor: true, showWithoutHover: true };
    const selected: string[][] = [];
    interface Element { type: (props: Record<string, unknown>) => unknown; props: Record<string, unknown> }
    const module = load<{ Timer(props: { time: number; userId: string }): Element | null }>("src/plugins/callTimer/Timer.tsx", {
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@utils/react": { useFixedTimer },
        "@utils/text": { formatDurationMs: () => "duration" },
        "@webpack": { findCssClassesLazy: () => ({ username: "username", usernameFont: "font" }) },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) } },
        "./index": { settings: { store, use: (keys: string[]) => { selected.push(keys); return store; } } },
        "./TimerIcon": {}
    }, { React: { createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }) } });
    assert.equal(module.Timer({ time: 1, userId: "me" }), null);
    assert.equal(intervals.size, 0);
    store.trackSelf = true;
    const visible = module.Timer({ time: 1, userId: "me" });
    assert.ok(visible);
    visible.type(visible.props);
    assert.equal(intervals.size, 1);
    store.format = "stopwatch";
    store.showSeconds = false;
    store.showRoleColor = false;
    const changed = module.Timer({ time: 1, userId: "me" });
    assert.ok(changed);
    assert.equal(changed.type, visible.type);
    assert.equal(changed.props.format, "stopwatch");
    assert.equal(changed.props.showSeconds, false);
    assert.equal(changed.props.showRoleColor, false);
    store.trackSelf = false;
    assert.equal(module.Timer({ time: 1, userId: "me" }), null);
    for (const cleanup of cleanups) cleanup();
    assert.equal(intervals.size, 0);
    assert.ok(module.Timer({ time: 1, userId: "other" }));
    assert.equal(selected[0], selected[1]);
    assert.ok(selected[0].includes("trackSelf"));
});
