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

interface RecordValue { message_id: string; message: { id: string; channel_id: string; attachments: { id: string; }[]; content: string; }; }

async function fixture() {
    const records: RecordValue[] = Array.from({ length: 30 }, (_, i) => ({ message_id: String(i), message: {
        id: String(i), channel_id: i % 2 ? "dm" : "guild", attachments: [{ id: String(i) }], content: i % 3 ? "other" : "match"
    } }));
    const images: string[] = [];
    let visits = 0;
    let cacheLimit = 5;
    let opens = 0;
    function cursor(values: RecordValue[]) {
        return values.length ? { async *[Symbol.asyncIterator]() { for (const value of values) { visits++; yield { value }; } } } : null;
    }
    const database = {
        transaction() { return { store: { index: () => ({
            openCursor: async (_range: unknown, direction: string) => cursor(direction === "prev" ? records.toReversed() : records),
            count: async () => records.length
        }) } }; },
        getAllFromIndex: async (_store: string, _index: string, _range: unknown, limit: number) => records.slice(0, limit),
        countFromIndex: async () => records.length
    };
    const mocks: Record<string, unknown> = {
        "@webpack/common": { ChannelStore: { getChannel: (id: string) => ({ guild_id: id === "guild" ? "server" : undefined }) } },
        idb: { openDB: async () => { opens++; return database; } }, "./utils": {}, "./utils/cleanUp": { stripTransientRenderState() {} },
        "./utils/constants": {}, "./utils/saveImage": { clearAttachmentBlobUrlCache() {}, getAttachmentBlobUrl: async (a: { id: string; }) => { images.push(a.id); return "blob:test"; } },
        "../index": { settings: { store: { get cacheLimit() { return cacheLimit; } } } }
    };
    function load(path: string) {
        const { outputText } = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, DOMException, IDBKeyRange: { only: (x: unknown) => x, upperBound: (x: unknown) => x },
            require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
    }
    mocks["./utils/LimitedMap"] = load("src/equicordplugins/messageLoggerEnhanced/utils/LimitedMap.ts");
    const db = load(process.env.AUDIT_LOG_QUERY_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/db.ts") as {
        initIDB(): Promise<void>;
        clearMessageCache(): void;
        cachedMessages: Map<string, RecordValue["message"]>;
        getOldestMessagesIDB(limit: number): Promise<RecordValue[]>;
        getOlderThanTimestampForGuildsIDB(time: string, channel?: string, preserve?: boolean): Promise<RecordValue[]>;
        getMessagesPageIDB?: (newest: boolean, limit: number, status: string, matches?: (record: RecordValue) => boolean, signal?: AbortSignal) => Promise<{ messages: RecordValue[]; total: number; }>;
    };
    const coldOpens = opens;
    await Promise.all([db.initIDB(), db.initIDB(), db.initIDB()]);
    return { db, records, images, coldOpens, get opens() { return opens; }, get visits() { return visits; }, setLimit(value: number) { cacheLimit = value; } };
}

test("Log cleanup reads records without loading attachments or retaining deletion candidates", async () => {
    const f = await fixture();
    assert.equal((await f.db.getOldestMessagesIDB(5)).length, 5);
    assert.equal((await f.db.getOlderThanTimestampForGuildsIDB("cutoff")).length, 15);
    assert.equal(f.images.length, 0);
    assert.equal(f.db.cachedMessages.size, 0);
});

test("Log search counts all matches but hydrates only its visible page", async () => {
    const f = await fixture();
    assert.ok(f.db.getMessagesPageIDB);
    const page = await f.db.getMessagesPageIDB(false, 3, "DELETED", r => r.message.content === "match");
    assert.equal(page.total, 10);
    assert.deepEqual(Array.from(page.messages, r => r.message_id), ["0", "3", "6"]);
    assert.deepEqual(f.images, ["0", "3", "6"]);
    assert.equal(f.db.cachedMessages.size, 3);
});

test("Unfiltered log pages stop reading once their visible limit is reached", async () => {
    const f = await fixture();
    assert.ok(f.db.getMessagesPageIDB);
    const page = await f.db.getMessagesPageIDB(true, 3, "DELETED");
    assert.equal(page.total, 30);
    assert.deepEqual(Array.from(page.messages, r => r.message_id), ["29", "28", "27"]);
    assert.equal(f.visits, 3);
});

test("Cancelled log queries skip hydration and stop traversing records", async () => {
    const f = await fixture();
    assert.ok(f.db.getMessagesPageIDB);
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
    await assert.rejects(f.db.getMessagesPageIDB(false, 3, "DELETED", () => { controller.abort(); return true; }, controller.signal), { name: "AbortError" });
    assert.ok(f.visits >= 1);
    assert.ok(f.visits <= 2);
    assert.equal(f.images.length, 0);
});

test("Both message caches honor reduced limits without evicting unrelated entries on replacement", async () => {
    const f = await fixture();
    const cache = f.db.cachedMessages;
    for (const record of f.records) cache.set(record.message_id, record.message);
    assert.equal(cache.size, 5);
    cache.set("29", f.records[29].message);
    assert.equal(cache.size, 5);
    assert.ok(cache.has("25"));
    f.setLimit(2);
    cache.set("29", f.records[29].message);
    assert.equal(cache.size, 2);
});

test("Disabled loggers do not open their database and concurrent first reads share one initialization", async () => {
    const f = await fixture();
    assert.equal(f.coldOpens, 0);
    assert.equal(f.opens, 1);
});

test("Clearing a logger session prevents an older query from refilling the cache", async () => {
    const f = await fixture();
    assert.ok(f.db.getMessagesPageIDB);
    const page = await f.db.getMessagesPageIDB(false, 3, "DELETED", () => { f.db.clearMessageCache(); return true; });
    assert.equal(page.messages.length, 3);
    assert.equal(f.images.length, 0);
    assert.equal(f.db.cachedMessages.size, 0);
});
