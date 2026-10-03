/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    let finishSettings: (value: object) => void = () => assert.fail("Settings request not initialized");
    const nativeSettings = new Promise<object>(resolve => { finishSettings = resolve; });
    const store: Record<string, unknown> = { cacheLimit: 5 };
    let settingsWrites = 0;
    let downloadStops = 0;
    let nativeCancellations = 0;
    let converted = 0;
    let finishQuery: (value: object[]) => void = () => assert.fail("Query not initialized");
    const query = new Promise<object[]>(resolve => { finishQuery = resolve; });
    const original = () => ({ id: "original" });
    const MessageStore = { getMessage: original };
    const cachedMessages = new Map();
    const settings = { store: new Proxy(store, { set(target, key, value) { settingsWrites++; target[String(key)] = value; return true; } }) };
    const mocks: Record<string, unknown> = {
        "./styles.css": {}, "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack": { findByPropsLazy: () => ({}) }, "@webpack/common": { MessageStore, UserStore: { getUser: () => undefined, getCurrentUser: () => undefined } },
        "./components/LogsButton": {}, "./components/LogsModal": {},
        "./db": { DBMessageStatus: { DELETED: "DELETED", GHOST_PINGED: "GHOST_PINGED" }, initIDB: async () => {}, cachedMessages, clearMessageCache: () => cachedMessages.clear(), getMessagesByChannelAndAfterTimestampIDB: () => query },
        "./LoggedMessageManager": {}, "./settings": { settings },
        "./utils": { getNative: () => ({ init: async () => {}, getSettings: () => nativeSettings, cancelNativeLogExports: async () => {}, closeNativeLogImports: async () => {}, cancelNativeAttachmentDownloads: async () => { nativeCancellations++; } }),
            messageJsonToMessageClass: () => { converted++; return { id: "logged" }; } },
        "./utils/contextMenu": {}, "./utils/index": {}, "./utils/parseQuery": {},
        "./utils/saveImage/backlog": { startAttachmentBacklog() {}, stopAttachmentBacklog() { nativeCancellations++; } },
        "./utils/saveImage": {}, "./utils/saveImage/ImageManager": { stopDownloads: () => { downloadStops++; } }
    };
    function load(source: string, moduleMocks = mocks) {
        const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
        return runInNewContext(`${outputText}\nexports;`, { exports: {},
            require: (name: string) => { assert.ok(name in moduleMocks, name); return moduleMocks[name]; } });
    }
    mocks["./utils/LimitedMap"] = load(readFileSync("src/equicordplugins/messageLoggerEnhanced/utils/LimitedMap.ts", "utf8"), { "../index": { settings } });
    const source = readFileSync(process.env.AUDIT_LOGGER_LIFETIME_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/index.tsx", "utf8");
    const api = load(source.replace("export const Native = getNative();", "") + "\nexport const Native = getNative();") as {
        default: { start(): Promise<void>; stop(): void; flux: { LOGOUT(): void; CONNECTION_OPEN(): void; }; processMessageFetch(response: { ok: boolean; body: object[]; }): Promise<void>; };
        cacheSentMessages: Map<string, unknown>;
    };
    return { api, MessageStore, cachedMessages, original, finishSettings, finishQuery, get settingsWrites() { return settingsWrites; }, get converted() { return converted; }, get downloadStops() { return downloadStops; }, get nativeCancellations() { return nativeCancellations; } };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("Logger shutdown clears both message caches and rejects late settings hydration", async () => {
    const f = fixture();
    const starting = f.api.default.start();
    await flush();
    f.cachedMessages.set("cached", { id: "cached", channel_id: "channel" });
    f.api.cacheSentMessages.set("sent", {});
    f.api.default.stop();
    f.finishSettings({ logsDir: "old", imageCacheDir: "old", attachmentFileExtensions: "png" });
    await starting;
    assert.equal(f.settingsWrites, 0);
    assert.equal(f.cachedMessages.size, 0);
    assert.equal(f.api.cacheSentMessages.size, 0);
    assert.equal(f.downloadStops, 1);
    assert.equal(f.nativeCancellations, 1);
    assert.equal(f.MessageStore.getMessage, f.original);
});

test("Stopping the logger preserves a later MessageStore wrapper and makes retained logger callbacks inert", async () => {
    const f = fixture();
    const starting = f.api.default.start();
    await flush();
    const loggerWrapper = f.MessageStore.getMessage;
    const externalWrapper = () => loggerWrapper();
    f.MessageStore.getMessage = externalWrapper;
    f.api.default.stop();
    f.cachedMessages.set("cached", { id: "cached", channel_id: "channel", deleted: true });
    assert.equal(f.MessageStore.getMessage, externalWrapper);
    assert.equal(externalWrapper().id, "original");
    assert.equal(f.converted, 0);
    f.finishSettings({});
    await starting;
});

test("Saved messages cannot be returned from a different channel", async () => {
    const f = fixture();
    const starting = f.api.default.start();
    await flush();
    f.cachedMessages.set("cached", { id: "cached", channel_id: "actual", deleted: true });
    const getMessage = f.MessageStore.getMessage as (channel: string, id: string) => { id: string; };
    assert.equal(getMessage("different", "cached").id, "original");
    assert.equal(f.converted, 0);
    f.api.default.stop();
    f.finishSettings({});
    await starting;
});

test("A logger fetch from the previous connection cannot publish saved records into a new session", async () => {
    const f = fixture();
    const body: object[] & { extra?: object[]; } = [{ channel_id: "channel", timestamp: "now", author: { id: "new" } }];
    const pending = f.api.default.processMessageFetch({ ok: true, body });
    f.api.default.flux.LOGOUT();
    f.api.default.flux.CONNECTION_OPEN();
    f.finishQuery([{ message_id: "old", status: "DELETED", message: { id: "old", mentions: [], author: { id: "old" } } }]);
    await pending;
    assert.equal(body.extra, undefined);
});
