/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { Queue } from "../src/utils/Queue";

function load<T>(path: string, modules: object, globals: object = {}, extra = "") {
    const source = readFileSync(`src/plugins/${path}`, "utf8") + extra;
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const identity = Object.assign((value: unknown) => value, { wrap: (value: unknown) => value });
    const defaults = { __esModule: true, default: identity, Devs: {}, EquicordDevs: {}, OptionType: {},
        classNameFactory: () => () => "", findByPropsLazy: () => ({}), findByCodeLazy: () => identity,
        migratePluginSettings() {}, migratePluginSetting() {}, Logger: class { error() {} warn() {} },
        definePluginSettings: (defs: Record<string, { default?: unknown; }>) => ({ store: Object.fromEntries(Object.entries(defs).map(([key, value]) => [key, value.default])) }), ...modules };
    return runInNewContext(`${code}\nexports;`, { exports: {}, require: () => defaults, ...globals }) as T;
}

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test("FavoriteEmojiFirst cannot register callbacks after stopped startup across 100 cycles", async () => {
    const reads: ReturnType<typeof deferred<object>>[] = [];
    const callbacks = new Set<unknown>();
    const api = load<{ default: { start(): Promise<void>; stop(): void; }; }>("favEmojiFirst/index.tsx", {
        DataStore: { get: () => { const read = deferred<object>(); reads.push(read); return read.promise; } },
        addGlobalContextMenuPatch: (callback: unknown) => callbacks.add(callback),
        removeGlobalContextMenuPatch: (callback: unknown) => callbacks.delete(callback)
    });
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) { pending.push(api.default.start()); api.default.stop(); }
    for (const read of reads) read.resolve({});
    await Promise.all(pending);
    assert.equal(callbacks.size, 0);
    const started = api.default.start();
    reads.at(-1)?.resolve({});
    await started;
    assert.equal(callbacks.size, 1);
    api.default.stop();
    assert.equal(callbacks.size, 0);
});

test("SilentTyping keeps only the latest expiry per channel and clears timers on stop", () => {
    let id = 0;
    const timers = new Map<number, () => void>();
    const api = load<{ default: { stop?(): void; flux: { MESSAGE_CREATE(event: unknown): void; LOGOUT?(): void; }; }; settings: { store: Record<string, unknown>; }; }>("silentTyping/index.tsx", {
        ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, UserStore: { getCurrentUser: () => ({ id: "self" }) }
    }, { setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; }, clearTimeout: (key: number) => timers.delete(key) }, "\nexport { settings };");
    api.settings.store.temporaryEnableThresholdServers = 60;
    for (let i = 0; i < 100; i++) api.default.flux.MESSAGE_CREATE({ message: { author: { id: "self" }, guild_id: "guild", channel_id: "channel" } });
    assert.equal(timers.size, 1);
    api.default.flux.MESSAGE_CREATE({ message: { author: { id: "self" }, guild_id: "guild", channel_id: "other" } });
    assert.equal(timers.size, 2);
    api.default.stop?.();
    assert.equal(timers.size, 0);
});

test("HideMedia discards stopped storage loads and leaves restarted load ownership intact", async () => {
    const reads: ReturnType<typeof deferred<string[]>>[] = [];
    const api = load<{ default: { start(): Promise<void>; stop(): void; shouldHide(id: string): boolean; }; }>("hideAttachments/index.tsx", {
        get: () => { const read = deferred<string[]>(); reads.push(read); return read.promise; }
    });
    for (let i = 0; i < 100; i++) {
        const old = api.default.start();
        api.default.stop();
        const current = api.default.start();
        reads[reads.length - 2].resolve(["stale"]);
        await old;
        assert.equal(api.default.shouldHide("stale"), false);
        const duplicate = api.default.start();
        assert.equal(reads.length, (i + 1) * 2);
        reads.at(-1)?.resolve(["current"]);
        await Promise.all([current, duplicate]);
        assert.equal(api.default.shouldHide("current"), true);
        api.default.stop();
    }
});

test("ValidReply discards replies completed after account teardown", async () => {
    const request = deferred<{ body: object[]; }>();
    const writes: unknown[] = [];
    const api = load<{ default: { setReplyStore(store: object): void; fetchReply(reply: unknown): Promise<void>; stop?(): void; }; }>("validReply/index.ts", {
        UserStore: { getCurrentUser: () => ({ id: "self" }) },
        Constants: { Endpoints: { MESSAGES: (id: string) => id } },
        RestAPI: { get: () => request.promise }, FluxDispatcher: { dispatch: (event: unknown) => writes.push(event) }
    });
    api.default.setReplyStore({ set: (...args: unknown[]) => writes.push(args) });
    await api.default.fetchReply({ baseMessage: { messageReference: { channel_id: "channel", message_id: "reply" } } });
    api.default.stop?.();
    request.resolve({ body: [{ id: "reply", channel_id: "channel" }] });
    await setImmediate();
    assert.equal(writes.length, 0);
});

test("Music presence polling does not accumulate pending work over 100 timer ticks", async () => {
    const request = deferred<null>();
    let calls = 0;
    const intervals: (() => void)[] = [];
    const updates: unknown[] = [];
    const api = load<{ default: { start(): void; stop(): void; getActivity(signal?: AbortSignal): Promise<null>; updatePresence(): Promise<void>; }; }>("musicRichPresence/index.tsx", {
        ActivityType: {}, ActivityFlags: {}, ActivityStatusDisplayType: {},
        AuthenticationStore: { getId: () => "self" }, clearListenBrainzCache() {},
        FluxDispatcher: { dispatch: (event: unknown) => updates.push(event) }
    }, { AbortController, setTimeout, clearTimeout, setInterval: (callback: () => void) => { intervals.push(callback); return 1; }, clearInterval() {} });
    api.default.getActivity = () => { calls++; return request.promise; };
    api.default.start();
    for (let i = 0; i < 100; i++) intervals[0]();
    api.default.stop();
    request.resolve(null);
    await setImmediate();
    assert.equal(calls, 1);
    assert.equal(updates.length, 1, "Only the stop reset may publish after teardown.");
    api.default.start();
    await setImmediate();
    api.default.stop();
    assert.equal(calls, 2);
});

test("Message link render storms bound queued work and stop suppresses late fetch publication", async () => {
    const request = deferred<{ body: object[]; }>();
    let requests = 0;
    let publications = 0;
    const channel = { isPrivate: () => true };
    const api = load<{ default: { start(): void; stop(): void; }; MessageEmbedAccessory(props: unknown): unknown; messageFetchQueue: Queue; messageCache: Map<string, unknown>; }>("messageLinkEmbeds/index.tsx", {
        Queue, getUserSettingLazy: () => ({}), findComponentLazy: () => () => {}, findComponentByCodeLazy: () => () => {}, findCssClassesLazy: () => ({}),
        addMessageAccessory() {}, removeMessageAccessory() {}, updateMessage: () => publications++,
        ChannelStore: { getChannel: () => channel }, UserStore: { getCurrentUser: () => ({ id: "self" }) },
        MessageStore: { getMessage: () => undefined, getMessages: () => ({ receiveMessage: (message: object) => { publications++; return { get: () => message }; } }) },
        Constants: { Endpoints: { MESSAGES: (id: string) => id } }, RestAPI: { get: () => { requests++; return request.promise; } }
    }, {}, "\nexport { MessageEmbedAccessory, messageFetchQueue, messageCache };");
    api.default.start();
    for (let i = 0; i < 1000; i++) api.MessageEmbedAccessory({ message: { id: "parent", channel_id: "parent-channel", author: { id: "author" }, content: "https://discord.com/channels/@me/12345678901234567/12345678901234568" } });
    await setImmediate();
    assert.ok(api.messageFetchQueue.size <= 100, `Queued ${api.messageFetchQueue.size} callbacks.`);
    api.default.stop();
    request.resolve({ body: [{ id: "12345678901234568", channel_id: "12345678901234567" }] });
    await setImmediate();
    assert.equal(requests, 1);
    assert.equal(publications, 0);
    assert.equal(api.messageCache.size, 0);
});

test("Decor clears ownership of pending account data across repeated sessions", async () => {
    const request = deferred<object[]>();
    let selectedReads = 0;
    const api = load<{ useCurrentUserDecorationsStore: { getState(): { fetch(): Promise<void>; clear(): void; decorations: object[]; }; }; }>("decor/lib/stores/CurrentUserDecorationsStore.ts", {
        proxyLazy: (callback: () => unknown) => callback(),
        getUserDecorations: () => request.promise,
        getUserDecoration: async () => { selectedReads++; return null; },
        UserStore: { getCurrentUser: () => ({ id: "self" }) },
        zustandCreate: (create: (set: (value: object) => void, get: () => object) => object) => {
            const state = create(value => Object.assign(state, value), () => state);
            return { getState: () => state };
        }
    });
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) { pending.push(api.useCurrentUserDecorationsStore.getState().fetch()); api.useCurrentUserDecorationsStore.getState().clear(); }
    request.resolve([{ hash: "old-account" }]);
    await Promise.all(pending);
    assert.equal(api.useCurrentUserDecorationsStore.getState().decorations.length, 0);
    assert.equal(selectedReads, 0, "An old fetch must not request the new account's selected decoration.");
});
