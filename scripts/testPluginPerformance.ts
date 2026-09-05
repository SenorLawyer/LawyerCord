/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { proxyLazy, SYM_LAZY_GET } from "../src/utils/lazy";

function loadComponent(path: string, hooks: Record<string, unknown> = {}, additionalMocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@webpack/common": { React, TextInput: "input", ...hooks },
        "@components/BaseText": { BaseText: "div" },
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "./Common": { SettingsSection: "section", resolveError: (result: boolean | string) => result === true ? null : result || "Invalid input provided" },
        "@utils/css": { classNameFactory: (prefix: string) => (...names: string[]) => names.map(name => prefix + name).join(" ") },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") },
        ...additionalMocks
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

function decorFixture() {
    const scheduled = new Map<() => Promise<void>, number>();
    const requests: { ids: string[]; signal?: AbortSignal; resolve: (result: Record<string, string | null>) => void; reject: (error: Error) => void; }[] = [];
    const errors: unknown[] = [];
    const clock = { now: 1_000 };
    const module = loadComponent("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal?: AbortSignal) => new Promise<Record<string, string | null>>((resolve, reject) => requests.push({ ids, signal, resolve, reject })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 10_000, SKU_ID: "decor" },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }, {
        AbortController, Date: class extends Date { static now() { return clock.now; } },
        setTimeout(callback: () => Promise<void>, delay: number) {
            scheduled.set(callback, clock.now + delay);
            return callback;
        },
        clearTimeout(callback: () => Promise<void>) { scheduled.delete(callback); }
    });
    const store = module.useUsersDecorationsStore;
    function flush() {
        const callback = scheduled.keys().next().value;
        assert.ok(callback);
        scheduled.delete(callback);
        return callback();
    }
    function advance(milliseconds: number) {
        clock.now += milliseconds;
        const work: Promise<void>[] = [];
        for (const [callback, due] of scheduled) {
            if (due <= clock.now) {
                scheduled.delete(callback);
                work.push(callback());
            }
        }
        return work;
    }
    return { store, requests, scheduled, flush, advance, errors, clock };
}

test("random mentions use the destination channel and preserve text when no members are loaded", () => {
    const plugin = loadComponent("src/equicordplugins/atSomeone/index.ts", {
        ChannelStore: { getChannel: (id: string) => ({
            guild: { guild_id: "destination" }, dm: { recipients: ["recipient"] }, empty: { guild_id: "empty" }
        })[id] },
        GuildMemberStore: { getMembers: (id: string) => id === "destination" ? [{ userId: "member" }] : [] }
    }, {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    assert.equal(plugin.start, undefined);
    for (const [channel, expected] of [["guild", "<@member> <@member>"], ["dm", "<@recipient> <@recipient>"], ["empty", "@someone @someone"], ["missing", "@someone @someone"]]) {
        const message = { content: "@someone @someone" };
        plugin.onBeforeMessageSend(channel, message);
        assert.equal(message.content, expected);
    }
});

test("clip file reads share the size cap and selected files reuse the byte writer", async () => {
    const footer = Buffer.from([0x75, 0x75, 0x69, 0x64, 0xA1, 0xC8, 0x52, 0x99, 0x33, 0x46, 0x4D, 0xB8, 0x88, 0xF0, 0x83, 0xF5, 0x7A, 0x75, 0xA5, 0xEF]);
    const payload = Buffer.concat([Buffer.from([1, 2, 3]), footer, Buffer.from('{"applicationName":"Fixture"}')]);
    let oversized = false;
    let id = 0;
    let reads = 0;
    const writes: Buffer[] = [];
    const native = loadComponent("src/equicordplugins/clipUpload.desktop/native.ts", {}, {
        "@main/ipcMain": { ensureSafePath: () => true },
        "@main/utils/constants": { DATA_DIR: "fixture" },
        crypto: { randomUUID: () => String(++id) },
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["clip.mp4"], canceled: false }) } },
        fs: { createReadStream: (_path: string, options: { end: number; }) => {
            assert.equal(options.end, 500 * 1024 * 1024);
            reads++;
            return Readable.from([payload]);
        } },
        "fs/promises": { mkdir: async () => {}, writeFile: async (_path: string, data: Buffer) => { writes.push(data); } },
        path,
        "stream/consumers": { buffer: async (stream: Readable) => oversized ? { length: 500 * 1024 * 1024 + 1 } : buffer(stream) }
    }, { Buffer, Uint8Array });
    const picked = await native.chooseVideoFile({});
    const metadata = await native.parseClipFileMetadata({}, picked.token);
    assert.equal(metadata[0].applicationName, "Fixture");
    const temp = await native.createTempVideoFile({}, picked.token);
    assert.equal(typeof temp, "string");
    assert.deepEqual(Array.from(writes[0]), [1, 2, 3]);
    assert.deepEqual(Array.from(await native.readVideoFile({}, temp)), Array.from(payload));
    oversized = true;
    const large = await native.chooseVideoFile({});
    assert.equal(await native.parseClipFileMetadata({}, large.token), null);
    assert.equal(await native.createTempVideoFile({}, large.token), null);
    assert.equal(await native.readVideoFile({}, temp), null);
    assert.equal(writes.length, 1);
    assert.equal(reads, 6);
});

test("favourite attachment downloads validate IPC input and bound network responses", async () => {
    let requests = 0;
    let cancelled = 0;
    let mode = "success";
    const { fetchAttachment } = loadComponent("src/equicordplugins/favouriteAnything/native.ts", {}, {}, {
        URL, Buffer, AbortSignal,
        fetch: async (_url: URL, options: RequestInit) => {
            requests++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            if (mode === "network") throw new Error("Private path or network details");
            let read = false;
            return {
                ok: true,
                headers: { get: (name: string) => name === "content-length" ? (mode === "header" ? "524288001" : null) : "text/plain" },
                body: {
                    cancel: async () => { cancelled++; },
                    getReader: () => ({
                        read: async () => {
                            if (read) return { done: true };
                            read = true;
                            return { done: false, value: mode === "stream" ? { byteLength: 524288001 } : new Uint8Array([1, 2, 3]) };
                        },
                        cancel: async () => { cancelled++; },
                        releaseLock() {}
                    })
                }
            };
        }
    });
    const attachment = { filename: "file.txt", url: "https://cdn.discordapp.com/attachments/file.txt" };
    for (const invalid of [null, {}, { ...attachment, filename: 1 }, ...["http://cdn.discordapp.com/file", "https://cdn.discordapp.com:444/file", "https://user@cdn.discordapp.com/file", "https://example.com/file"].map(url => ({ ...attachment, url }))]) {
        const result = await fetchAttachment({}, invalid);
        assert.equal(result.success, false);
    }
    assert.equal(requests, 0);
    const success = await fetchAttachment({}, attachment);
    assert.equal(success.success, true);
    assert.deepEqual(Array.from(success.data), [1, 2, 3]);
    assert.equal(success.filename, "file.txt");
    assert.equal(success.type, "text/plain");
    for (mode of ["header", "stream", "network"]) {
        const result = await fetchAttachment({}, attachment);
        assert.equal(result.success, false);
        assert.equal(result.error.includes("Private"), false);
    }
    assert.equal(cancelled, 2);
});

test("favourite attachment base64url encoding preserves bytes and rejects malformed input", () => {
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/polyfills.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { encode, decode } = runInNewContext(`Uint8Array.fromBase64 = undefined; Uint8Array.prototype.toBase64 = undefined;\n${outputText}\n({ encode: bytes => uint8ArrayToBase64(new Uint8Array(bytes)), decode: base64ToUint8Array });`, {
        exports: {}, atob, btoa
    });
    for (let length = 0; length < 260; length++) {
        const bytes = Array.from({ length }, (_, index) => (index * 37 + length) % 256);
        const expected = Buffer.from(bytes).toString("base64url");
        assert.equal(encode(bytes), expected);
        assert.deepEqual(Array.from(decode(expected)), bytes);
    }
    assert.deepEqual(Array.from(decode(" A Q I =\r\n")), [1, 2]);
    assert.deepEqual(Array.from(decode("AQ==")), [1]);
    for (const invalid of ["A", "A=", "AQ=", "AQ===", "AQ=A", "AAAA=", "+w", "/w", "AA!", "AA\u00a0"])
        assert.throws(() => decode(invalid), invalid);
});

test("linked message previews reject neighboring messages returned by an around lookup", async () => {
    const source = readFileSync("src/plugins/messageLinkEmbeds/index.tsx", "utf8");
    const code = transpileModule(source.slice(source.indexOf("async function fetchMessage("), source.indexOf("function getImages(")), {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText;
    for (const id of ["neighbor", "requested"]) {
        const message = { id, channel_id: "channel" };
        let stored = 0;
        const cache = new Map();
        const fetchMessage = runInNewContext(`${code}\nfetchMessage;`, {
            messageCache: cache,
            setMessageCache: (key: string, value: unknown) => cache.set(key, value),
            RestAPI: { get: async () => ({ body: [message] }) },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } },
            MessageStore: { getMessages: () => ({ receiveMessage: () => { stored++; return { get: () => message }; } }) }
        });
        assert.equal(await fetchMessage("channel", "requested"), id === "requested" ? message : undefined);
        assert.equal(stored, id === "requested" ? 1 : 0);
    }
});

test("queued task failures are reported without interrupting ordered work", async () => {
    const errors: unknown[][] = [];
    const { Queue } = loadComponent("src/utils/Queue.ts", {}, {
        "./Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    });
    const queue = new Queue(2);
    const calls: string[] = [];
    queue.push(() => { calls.push("first"); throw new Error("Synchronous failure"); });
    queue.push(() => calls.push("discarded"));
    queue.unshift(async () => { calls.push("urgent"); throw new Error("Asynchronous failure"); });
    queue.unshift(() => calls.push("newest"));
    await setImmediate();
    assert.deepEqual(calls, ["first", "newest", "urgent"]);
    assert.equal(errors.length, 2);
    assert.equal(queue.size, 0);
    queue.push(() => calls.push("resumed"));
    await setImmediate();
    assert.equal(calls.at(-1), "resumed");
});

test("audio player preserves zero volume and clamps explicit values", () => {
    const plugin = loadComponent("src/equicordplugins/_api/audioPlayer.ts", {}, {
        "@api/AudioPlayer": { audioProcessorFunctions: {}, AudioType: {}, identifyAudioType: () => "url" },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }, { structuredClone }).default;
    for (const [volume, internalVolume, expected] of [
        [0, null, 0], [undefined, 0, 0], [undefined, undefined, 1],
        [50, null, 0.5], [100, 0.25, 0.25], [-10, null, 0], [200, null, 1]
    ] as const) {
        const player = { _volume: -1, destroyAudio() {} };
        plugin.buildPlayer(player, { volume }, "https://example.com/sound.mp3", null, internalVolume, "default");
        assert.equal(player._volume, expected);
    }
});

test("Decor continuous arrivals cannot postpone the first batch and stopped timers cannot fetch", async () => {
    const f = decorFixture();
    f.store.getState().start();
    f.store.getState().fetch("a");
    f.advance(100); f.store.getState().fetch("b");
    f.advance(100); f.store.getState().fetch("c");
    assert.equal(f.requests.length, 0);
    const first = f.advance(100);
    assert.equal(f.requests.length, 1);
    assert.deepEqual([...f.requests[0].ids], ["a", "b", "c"]);
    f.store.getState().fetch("d");
    f.advance(299);
    assert.equal(f.requests.length, 1);
    const second = f.advance(1);
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ d: "new" }); await Promise.all(second);
    f.requests[0].resolve({ a: null, b: "b", c: null }); await Promise.all(first);
    assert.equal(f.store.getState().usersDecorations.get("d").asset, "new");
    f.store.getState().fetch("cancelled");
    f.store.getState().stop();
    await Promise.all(f.advance(300));
    assert.equal(f.requests.length, 2);
    f.store.getState().start(); f.store.getState().fetch("restarted");
    const restarted = f.advance(300);
    assert.equal(f.requests.length, 3);
    f.requests[2].resolve({ restarted: null }); await Promise.all(restarted);
});

test("Decor lookups preserve newer local and unrelated decoration updates", async () => {
    const { store, requests, flush } = decorFixture();
    store.getState().start?.();
    store.getState().fetch("a");
    const first = flush();
    store.getState().set("a", "local");
    store.getState().fetch("b");
    const second = flush();
    requests[1].resolve({ b: "remote-b" }); await second;
    requests[0].resolve({ a: "old-a" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "local");
    assert.equal(store.getState().usersDecorations.get("b").asset, "remote-b");
});

test("Decor lookups deduplicate pending IDs and prefer the latest forced request", async () => {
    const { store, requests, scheduled, flush } = decorFixture();
    store.getState().start();
    store.getState().fetch("a"); store.getState().fetch("a");
    const first = flush();
    assert.deepEqual([...requests[0].ids], ["a"]);
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0);
    store.getState().fetch("a", true);
    const second = flush();
    requests[1].resolve({ a: "new" }); await second;
    requests[0].resolve({ a: "old" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "new");
});

test("Decor stop cancels queued requests and old failures cannot erase restarted work", async () => {
    const { store, requests, scheduled, flush, errors } = decorFixture();
    store.getState().fetch("inactive");
    assert.equal(scheduled.size, 0);
    store.getState().start(); store.getState().fetch("a");
    const old = flush();
    store.getState().fetch("queued"); store.getState().stop();
    assert.equal(scheduled.size, 0);
    assert.equal(requests[0].signal?.aborted, true);
    store.getState().start(); store.getState().fetch("a");
    const current = flush();
    requests[0].reject(new Error("Old failure")); await old;
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0, "the old cleanup must preserve the new in-flight marker");
    requests[1].resolve({ a: "current" }); await current;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    store.getState().fetch("a", true); const failed = flush();
    requests[2].reject(new Error("Retryable failure")); await failed;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    assert.equal(errors.length, 1);
    store.getState().fetch("a", true); const retry = flush();
    store.getState().stop(); requests[3].resolve({ a: "late" }); await retry;
    assert.equal(store.getState().usersDecorations.size, 0);
});

test("Decor cached absence expires and expired entries are released", async () => {
    const { store, requests, scheduled, flush, clock } = decorFixture();
    store.getState().start(); store.getState().fetch("a");
    const first = flush(); requests[0].resolve({ a: null }); await first;
    store.getState().fetch("a"); assert.equal(scheduled.size, 0);
    clock.now += 10_000;
    store.getState().fetch("b"); const second = flush(); requests[1].resolve({ b: "b" }); await second;
    assert.equal(store.getState().usersDecorations.has("a"), false);
    store.getState().fetch("a"); assert.equal(scheduled.size, 1);
    store.getState().stop();
});

test("Decor public lookups check HTTP and response shapes and never request the entire user list", async () => {
    const requests: { url: string; signal?: AbortSignal; }[] = [];
    const response: { ok: boolean; body: unknown; } = { ok: true, body: { a: "asset", b: null, unrelated: "ignored" } };
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": { API_URL: "https://decor.invalid/api" },
        "./stores/AuthorizationStore": {},
        "./utils/decoration": {},
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    }, { URL, fetch: async (url: URL, options: { signal?: AbortSignal; }) => {
        requests.push({ url: String(url), signal: options.signal });
        return { ok: response.ok, json: async () => response.body };
    } });
    assert.deepEqual(structuredClone(await api.getUsersDecorations([])), {});
    assert.equal(requests.length, 0);
    const controller = new AbortController();
    assert.deepEqual(structuredClone(await api.getUsersDecorations(["a", "b", "missing"], controller.signal)), { a: "asset", b: null, missing: null });
    assert.equal(requests[0].signal, controller.signal);
    assert.deepEqual(JSON.parse(new URL(requests[0].url).searchParams.get("ids") ?? "null"), ["a", "b", "missing"]);
    response.ok = false; await assert.rejects(api.getUsersDecorations(["a"]), /Could not load/);
    response.ok = true;
    for (const body of [null, [], { a: 123 }, { a: {} }]) {
        response.body = body; await assert.rejects(api.getUsersDecorations(["a"]), /Invalid decoration response/);
    }
});

test("Decor lifecycle keeps initialization and connection work obsolete after logout or stop", async () => {
    const { store, scheduled } = decorFixture();
    const pending: ((configured: boolean) => void)[] = [];
    const account = { id: "first", clears: 0, authInits: 0 };
    const authorizationListeners = new Set<(state: object, previous: object) => void>();
    const plugin = loadComponent("src/plugins/decor/index.tsx", { UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined } }, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { setBaseUrl: () => new Promise<boolean>(resolve => pending.push(resolve)), cancelConfiguration: () => undefined },
        "./lib/stores/AuthorizationStore": { useAuthorizationStore: {
            getState: () => ({ init: () => account.authInits++, clear: () => undefined }),
            subscribe(listener: (state: object, previous: object) => void) {
                authorizationListeners.add(listener);
                return () => authorizationListeners.delete(listener);
            }
        } },
        "./lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: { getState: () => ({ clear: () => account.clears++ }) } },
        "./lib/stores/UsersDecorationsStore": { useUsersDecorationsStore: store },
        "./settings": { settings: { store: { baseUrl: "https://decor.invalid" } } },
        "./ui/components": {}, "./ui/components/DecorSection": {}
    }).default;
    const first = plugin.start();
    plugin.stop(); pending.shift()?.(true); await first;
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    const second = plugin.start();
    const connection = plugin.flux.CONNECTION_OPEN();
    account.id = ""; plugin.flux.LOGOUT(); pending.shift()?.(true); await Promise.all([second, connection]);
    assert.equal(store.getState().session, null);
    account.id = "second"; await plugin.flux.CONNECTION_OPEN();
    assert.equal(typeof store.getState().session, "symbol");
    assert.equal(scheduled.size, 1);
    plugin.stop(); await plugin.flux.CONNECTION_OPEN();
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    assert.ok(account.clears >= 4);
    assert.equal(account.authInits, 2);
    plugin.stop();
});

function loadShortcuts() {
    const state = { resolutions: 0, opens: 0, roots: 0, unmounts: 0, renders: [] as unknown[], blocked: false, failRoot: false };
    const module = Object.freeze({ value: "lazy module", nested: Object.freeze({ value: 1 }) });
    const lazy = proxyLazy(() => { state.resolutions++; return module; });
    const modules: Record<string, unknown>[] = [];
    const fluxStores = new Map<string, object>();
    const popups: ReturnType<typeof makePopup>[] = [];
    function makePopup() {
        let pagehide: (() => void) | undefined;
        return {
            closed: false, closes: 0, focus() {},
            document: {
                head: { append() {} },
                body: { style: {}, appendChild: (element: object) => element },
                createElement: () => ({})
            },
            addEventListener(event: string, callback: () => void) { assert.equal(event, "pagehide"); pagehide = callback; },
            close() { this.closes++; this.closed = true; pagehide?.(); },
            leave() { this.closed = true; pagehide?.(); }
        };
    }
    const window = {
        open() {
            state.opens++;
            if (state.blocked) return null;
            const popup = makePopup();
            popups.push(popup);
            return popup;
        }
    };
    const byProps = (...keys: string[]) => (value: Record<string, unknown>) => keys.every(key => Object.hasOwn(value, key));
    const webpack = {
        fluxStores,
        filters: { byProps, byCode: byProps, componentByCode: byProps, byClassNames: byProps },
        findAll: (filter: (value: object) => boolean) => modules.filter(filter),
        findStore: (name: string) => { const store = fluxStores.get(name); if (!store) throw new Error("Missing store"); return store; },
        findModuleId: (code: string) => code === "present" ? 0 : null,
        extract: (id: number) => { assert.equal(id, 0); return "source"; },
        search() {}
    };
    const plugin = loadComponent("src/plugins/consoleShortcuts/index.ts", {
        LazyModule: lazy,
        createRoot: () => {
            if (state.failRoot) throw new Error("Root unavailable");
            state.roots++;
            return { render: (element: unknown) => state.renders.push(element), unmount: () => state.unmounts++ };
        }
    }, {
        "@debug/loadLazyChunks": { loadLazyChunks() { assert.fail("Automatic chunk loading"); } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentChannel: () => null, getCurrentGuild: () => null },
        "@utils/intlHash": { runtimeHashMessageKey() {} },
        "@utils/lazy": { SYM_LAZY_GET },
        "@utils/native": { relaunch() { assert.fail("Unexpected relaunch"); } },
        "@utils/patches": { canonicalizeMatch() {}, canonicalizeReplace() {}, canonicalizeReplacement() {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, StartAt: {} },
        "@webpack": webpack
    }, {
        window, document: { querySelectorAll: () => [] },
        IS_WEB: false, IS_VESKTOP: false, IS_EQUIBOP: false
    }).default;
    return { plugin, window, state, module, modules, fluxStores, popups };
}

test("console aliases resolve lazies only on access without mutating module exports", async () => {
    const { plugin, window, state, module } = loadShortcuts();
    plugin.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.resolutions, 0);
    const shortcuts = Reflect.get(window, "shortcutList");
    assert.equal(Reflect.get(window, "LazyModule"), module);
    assert.equal(shortcuts.LazyModule, module);
    assert.equal(state.resolutions, 1);
    assert.deepEqual(module.nested, { value: 1 });
    plugin.stop();
    assert.equal(Object.hasOwn(window, "LazyModule"), false);
});

test("console aliases restore owned descriptors and preserve collisions and external replacements", () => {
    const { plugin, window } = loadShortcuts();
    const previous = { value: "previous", writable: false, configurable: true, enumerable: false };
    Object.defineProperty(window, "wp", previous);
    Object.defineProperty(window, "find", { value: "reserved", configurable: false });
    const previousList = { value: "previous list", writable: true, configurable: true, enumerable: false };
    Object.defineProperty(window, "shortcutList", previousList);
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    plugin.start();
    assert.equal(Reflect.get(window, "shortcutList"), shortcuts);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(shortcuts.find(() => true), null);
    Object.defineProperty(window, "reload", { value: "external", configurable: true });
    plugin.stop();
    plugin.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "wp"), previous);
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "shortcutList"), previousList);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(Reflect.get(window, "reload"), "external");
    plugin.start();
    plugin.stop();
    assert.equal(Reflect.get(window, "reload"), "external");
});

test("console searches distinguish identical-looking closures and reflect replaced modules and stores", () => {
    const { plugin, window, modules, fluxStores } = loadShortcuts();
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    const first = { id: 1 }, second = { id: 2 };
    modules.push(first, second);
    const byId = (id: number) => (module: { id: number }) => module.id === id;
    assert.equal(String(byId(1)), String(byId(2)));
    assert.equal(shortcuts.find(byId(1)), first);
    assert.equal(shortcuts.find(byId(2)), second);
    const replacement = { id: 1 };
    modules.splice(0, 1, replacement);
    assert.equal(shortcuts.find(byId(1)), replacement);
    assert.equal(shortcuts.findExportedComponent("absent"), undefined);
    assert.equal(shortcuts.wpexs("absent"), null);
    assert.equal(shortcuts.wpexs("present"), "source");
    assert.equal(shortcuts.findStore("Sample"), null);
    assert.equal(shortcuts.Stores.Sample, undefined);
    fluxStores.set("Sample", first);
    assert.equal(shortcuts.Stores.Sample, first);
    assert.equal(shortcuts.findStore("Sample"), first);
    fluxStores.set("Sample", second);
    assert.equal(shortcuts.findStore("Sample"), second);
    assert.equal(shortcuts.Stores.Sample, second);
    plugin.stop();
});

test("console previews report blocked popups and reuse one root until close or stop", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    const component = () => null;
    state.blocked = true;
    assert.throws(() => fakeRender(component), /Could not open/);
    assert.equal(state.roots, 0);
    state.blocked = false;
    fakeRender(component, { value: 1 });
    fakeRender(component, { value: 2 });
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 2);
    popups[0].leave();
    assert.equal(state.unmounts, 1);
    fakeRender(component);
    assert.equal(state.roots, 2);
    plugin.stop();
    plugin.stop();
    assert.equal(state.unmounts, 2);
    assert.equal(popups[1].closed, true);
    assert.equal(popups[1].closes, 1);
});

test("console previews can retry after root creation fails", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    state.failRoot = true;
    assert.throws(() => fakeRender(() => null), /Root unavailable/);
    assert.equal(popups[0].closed, true);
    state.failRoot = false;
    fakeRender(() => null);
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 1);
    plugin.stop();
    assert.equal(state.unmounts, 1);
});

test("member counts subscribe to scalar values and tooltip renders skip channel work", () => {
    const selectors: { select: () => unknown; value: unknown; stores: unknown[]; deps: unknown[]; }[] = [];
    let channelReads = 0;
    let groups = [{ id: "online", count: 3 }, { id: "offline", count: 20 }];
    const module = loadComponent("src/plugins/memberCount/MemberCount.tsx", {
        ChannelStore: { getChannel: () => ({}) },
        GuildMemberCountStore: { getMemberCount: () => 23 },
        PermissionStore: { can: () => true }, PermissionsBits: { VIEW_CHANNEL: 1 },
        VoiceStateStore: { getVoiceStates: () => ({}) }, SelectedChannelStore: {},
        useEffect() {},
        useStateFromStores(stores: unknown[], select: () => unknown, deps: unknown[] = []) {
            const value = select(); selectors.push({ stores, select, value, deps }); return value;
        }
    }, {
        "@utils/discord": { getCurrentChannel: () => { channelReads++; return { id: "channel", guild_id: "guild" }; } },
        "@utils/misc": { isObjectEmpty: (value: object) => Object.keys(value).length === 0 },
        ".": { ChannelMemberStore: { getProps: () => ({ groups }) }, ThreadMemberListStore: { getMemberListSections: () => ({}) }, cl: () => "", numberFormat: String, settings: { use: () => ({ voiceActivity: true }) } },
        "./OnlineMemberCountStore": { OnlineMemberCountStore: { getCount: () => 5 } },
        "./CircleIcon": {}, "./VoiceIcon": {}
    });
    module.MemberCount({});
    assert.equal(selectors[4].value, 3);
    groups = [{ id: "online", count: 3 }, { id: "offline", count: 99 }];
    assert.equal(selectors[4].select(), selectors[4].value);
    assert.deepEqual([...selectors[4].deps], [undefined, "guild", "channel"]);
    selectors.length = 0;
    module.MemberCount({ isTooltip: true, tooltipGuildId: "guild" });
    assert.equal(channelReads, 1);
    assert.equal(selectors[4].value, null);
    assert.equal(selectors[5].value, null);
});

test("APNG failed worker loads terminate and concurrent conversions share the retry", async () => {
    const workers: { loaded: boolean; terminated: boolean; }[] = [];
    let loads = 0;
    const module = loadComponent("src/equicordplugins/fileUpload/utils/apngToGif.ts", {}, {
        "@ffmpeg/ffmpeg": { FFmpeg: class {
            loaded = false;
            terminated = false;
            constructor() { workers.push(this); }
            terminate() { this.terminated = true; }
            async writeFile() {}
            async exec() {}
            async readFile() { return new Uint8Array([1]); }
            async deleteFile() {}
        } },
        "@utils/ffmpeg": { loadFFmpeg: async (worker: { loaded: boolean; }) => { if (++loads === 1) throw new Error("Load failed"); worker.loaded = true; } }
    }, { Blob, console: { error() {} } });
    assert.equal(await module.convertApngToGif(new Blob()), null);
    assert.equal(workers[0].terminated, true);
    const results = await Promise.all([module.convertApngToGif(new Blob()), module.convertApngToGif(new Blob())]);
    assert.equal(loads, 2);
    assert.equal(results.every(result => result instanceof Blob), true);
});

test("DevCompanion replacement closes the old socket and ignores its late events", () => {
    class Socket {
        static OPEN = 1;
        readyState = 1;
        closed = false;
        sent: string[] = [];
        listeners = new Map<string, (event: object) => void>();
        constructor() { sockets.push(this); }
        close() { this.closed = true; this.readyState = 3; }
        send(message: string) { this.sent.push(message); }
        addEventListener(type: string, listener: (event: object) => void) { this.listeners.set(type, listener); }
    }
    const sockets: Socket[] = [];
    const module = loadComponent("src/plugins/devCompanion.dev/initWs.tsx", {
        Toasts: { show() {}, genId: () => "toast", Type: { SUCCESS: 1, FAILURE: 2 }, Position: { TOP: 1 } }
    }, {
        "@api/Settings": {}, "@debug/loadLazyChunks": {}, "@debug/reporterData": {},
        "@utils/discord": {}, "@utils/patches": {}, "@webpack": { wreq: { m: {} } },
        ".": { CLIENT_VERSION: [0, 1, 2], PORT: 8485, settings: { store: {} }, logger: { info() {}, error() {}, debug() {} } },
        "./types": {}, "./types/send": {}, "./util": {}
    }, { WebSocket: Socket, IS_COMPANION_TEST: false });
    module.initWs();
    module.initWs();
    assert.equal(sockets[0].closed, true);
    sockets[0].listeners.get("open")?.({});
    assert.equal(sockets[0].sent.length, 0);
    sockets[1].listeners.get("open")?.({});
    assert.equal(sockets[1].sent.length, 1);
    module.stopWs();
    assert.equal(sockets[1].closed, true);
    sockets[1].listeners.get("message")?.({ data: "invalid" });
    assert.equal(sockets[1].sent.length, 1);
});

function loadSource(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}, result = "exports") {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

function response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
}

function loadGlobalBadges() {
    const store: Record<string, string | boolean> = { apiUrl: "https://fixture.invalid", showModStyle: "none", showAero: true };
    const requests: { url: string; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const errors: unknown[][] = [];
    const intervals = new Map<number, () => Promise<void>>();
    const toasts: { type: string; }[] = [];
    const mocks = {
        "./settings": { settings: { store } },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    };
    const utils = loadSource("src/equicordplugins/globalBadges/utils.ts", mocks, {
        fetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }))
    });
    const { default: plugin } = loadSource("src/equicordplugins/globalBadges/index.tsx", {
        ...mocks,
        "./utils": utils,
        "@api/Badges": { BadgePosition: { START: 0 } },
        "@components/Button": {},
        "@plugins/_api/badges": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { Toasts: { genId: () => "toast", show: (toast: { type: string; }) => toasts.push(toast), Type: { SUCCESS: "success", FAILURE: "failure" } } }
    }, {
        setInterval: (callback: () => Promise<void>) => { intervals.set(1, callback); return 1; },
        clearInterval: (id: number) => intervals.delete(id)
    });
    return { utils, plugin, store, requests, errors, intervals, toasts };
}

test("global badge display settings use existing data and unknown service names remain readable", async () => {
    const { utils, plugin, requests, store } = loadGlobalBadges();
    const pending = utils.loadBadges();
    requests[0].resolve(response({ users: { fixture: [
        { mod: "aero", badge: "aero.png", tooltip: "Contributor" },
        { mod: "newmod", badge: "new.png", tooltip: "Developer" },
        { mod: "vencord", badge: "vencord.png", tooltip: "Donor" },
        { mod: "", badge: "empty.png", tooltip: "Empty" }
    ] } }));
    await pending;
    assert.equal(plugin.getGlobalBadges("fixture").length, 2);
    store.showAero = false;
    store.showModStyle = "prefix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "newmod - Developer");
    assert.equal(plugin.getGlobalBadges("fixture").length, 1);
    store.showAero = true;
    store.showModStyle = "suffix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "Contributor - Aero");
    assert.equal(requests.length, 1);
});

test("global badge loads discard stale responses and stop invalidates pending data", async () => {
    const { utils, plugin, requests, store, intervals } = loadGlobalBadges();
    const first = utils.loadBadges();
    store.apiUrl = "https://new-fixture.invalid/";
    const second = utils.loadBadges();
    assert.equal(requests[1].url, "https://new-fixture.invalid/users");
    requests[1].resolve(response({ users: { current: [] } }));
    await second;
    requests[0].resolve(response({ users: { stale: [] } }));
    await first;
    assert.equal(plugin.getGlobalBadges("current")?.length, 0);
    assert.equal(plugin.getGlobalBadges("stale"), undefined);
    plugin.start();
    assert.equal(intervals.size, 1);
    plugin.stop();
    requests[2].resolve(response({ users: { stopped: [] } }));
    await setImmediate();
    assert.equal(intervals.size, 0);
    assert.equal(plugin.getGlobalBadges("stopped"), undefined);
});

test("global badge refresh retries failures, rejects malformed data and reports manual errors", async () => {
    const { utils, plugin, requests, intervals, errors, toasts } = loadGlobalBadges();
    plugin.start();
    assert.equal(intervals.size, 1);
    requests[0].reject(new Error("offline"));
    await setImmediate();
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0]();
    requests[1].resolve(response({ users: { good: [] } }));
    await retry;
    for (const invalid of [null, {}, { users: [] }, { users: { broken: {} } }, { users: { broken: [null] } }, { users: { broken: [{ mod: "aero", badge: "a.png" }] } }]) {
        const offset = requests.length;
        const pending = utils.refreshBadges();
        requests[offset].resolve(response(invalid));
        await pending;
        assert.equal(plugin.getGlobalBadges("good")?.length, 0);
    }
    const offset = requests.length;
    const manual = plugin.toolboxActions["Refetch Global Badges"]();
    requests[offset].resolve(response({}, 503));
    await manual;
    assert.equal(toasts.at(-1)?.type, "failure");
    plugin.stop();
});

test("chat badge classes stay lazy until rendering and sibling badge keys are unique", () => {
    let ready = false;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { CheckBadge } = loadSource("src/equicordplugins/showBadgesInChat/index.tsx", {
        "@plugins/_api/badges": { __esModule: true, default: {
            getDonorBadges: () => [{ id: "one" }, { id: "two" }], getEquicordDonorBadges: () => [{ id: "one" }, { id: "two" }]
        } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": {
            findComponentByCodeLazy: () => "role-icon",
            findCssClassesLazy: () => new Proxy({}, { get() { assert.equal(ready, true, "Discord classes are unavailable during module initialization"); return "role-icon"; } })
        },
        "./settings": { __esModule: true, default: { store: {} } }
    }, { React }, "({ CheckBadge })");
    ready = true;
    for (const badge of ["EquicordDonor", "VencordDonor", "DiscordProfile"]) {
        const rendered = CheckBadge({ badge, author: { id: "fixture", flags: 3 } });
        const keys = rendered.props.children[0].map((child: { props: { key: string; }; }) => child.props.key);
        assert.equal(keys.length, 2);
        assert.equal(new Set(keys).size, 2);
    }
});

test("animation preferences gate every patch and expose their restart requirement", () => {
    const store: Record<string, boolean> = {};
    const { default: plugin } = loadSource("src/plugins/alwaysAnimate/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } }
    });
    for (const [key, option] of Object.entries(plugin.settings.def) as [string, { restartNeeded?: boolean; }][]) {
        store[key] = false;
        assert.equal(option.restartNeeded, true, key);
    }
    const active = () => plugin.patches.filter((patch: { predicate?(): boolean; }) => !patch.predicate || patch.predicate());
    assert.equal(active().length, 0);
    store.roleGradients = true;
    assert.equal(active().length, 3);
});

test("emoji copy menus keep the real webpack proxy lazy until the Unicode action is used", () => {
    let lookups = 0;
    const copied: string[] = [];
    const plugin = loadComponent("src/plugins/copyEmojiMarkdown/index.tsx", {
        Menu: { MenuGroup: "group", MenuItem: "item" }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: { copyUnicode: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: (text: string) => copied.push(text) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => proxyLazy(() => { lookups++; return { convertNameToSurrogate: () => "🛒" }; }) }
    }).default;
    assert.equal(lookups, 0);
    const children: { props: { children: { props: { action: () => void; }; }[]; }; }[] = [];
    plugin.contextMenus["expression-picker"](children, { target: { dataset: { type: "emoji", name: "cart" } } });
    assert.equal(lookups, 0);
    children[0].props.children[0].props.action();
    assert.equal(lookups, 1);
    assert.deepEqual(copied, ["🛒"]);
});

test("sticker pack metadata updates preserve concurrent packs without holding a storage mutex", async () => {
    const entries = new Map<string, unknown>();
    let updates = 0;
    const module = loadComponent("src/equicordplugins/moreStickers/stickers.ts", {}, {
        "@api/DataStore": {
            async set(key: string, value: unknown) { entries.set(key, value); },
            async get(key: string) { return entries.get(key); },
            async del(key: string) { entries.delete(key); },
            async update(key: string, change: (value: unknown) => unknown) { updates++; entries.set(key, change(entries.get(key))); }
        },
        "./components": { async removeRecentStickerByPackId() {} }, "./utils": {}
    });
    await Promise.all([module.saveStickerPack({ id: "a", title: "A" }), module.saveStickerPack({ id: "b", title: "B" })]);
    assert.equal(updates, 2);
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["a", "b"]);
    await module.deleteStickerPack("a");
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["b"]);
});
