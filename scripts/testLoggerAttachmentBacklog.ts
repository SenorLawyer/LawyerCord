/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Attachment { id: string; url: string; fileExtension?: string; oldUrl?: string; path?: string; }
interface Message { id: string; channel_id: string; content: string; attachments: Attachment[]; }
interface Work { ownerId: string; revision: string; pendingIds: string[]; }
interface Row { message_id: string; channel_id: string; status: string; message: Message; attachmentWork?: Work; }
interface Job { messageId: string; ownerId: string; revision: string; attachment: Attachment; }
interface Database {
    initIDB(): Promise<void>;
    cachedMessages: Map<string, Message>;
    addMessageIDB(message: Message, status: string, work?: Work): Promise<void>;
    addMessagesBulkIDB(messages: Message[], status: string): Promise<void>;
    importMessagesIDB(messages: Message[]): Promise<number>;
    deleteMessageIDB(id: string): Promise<void>;
    deleteMessagesBulkIDB(ids: string[]): Promise<void>;
    clearMessagesIDB(toast: boolean): Promise<void>;
    getAttachmentWorkPage(owner: string, from?: string): Promise<{ job?: Job; nextId?: string; }>;
    completeAttachmentWork(job: Job, path?: string, signal?: AbortSignal): Promise<void>;
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
    for (let i = 0; i < 2000 && !check(); i++) await flush();
    assert.ok(check(), "Expected work to settle");
}
const message = (id: string): Message => ({ id, channel_id: "channel", content: "message", attachments: [{ id: `att${id}`, url: `https://cdn.discordapp.com/${id}.png`, fileExtension: ".png" }] });

async function fixture() {
    const rows = new Map<string, Row>();
    let ordered: string[] | undefined;
    let scans = 0;
    let hydrated = 0;
    let active = 0;
    let maxActive = 0;
    let cancelFailures = 0;
    let pageCalls = 0;
    let nextPage: Promise<void> | undefined;
    const requests: { attachment: Attachment; finish(path?: string): void; }[] = [];
    const errors: unknown[] = [];
    const settings = { store: { saveImages: true, messageLimit: 0, timeBasedCleanupMinutes: 0 } };
    const database = {
        async put(_name: string, row: Row) { rows.set(row.message_id, structuredClone(row)); ordered = undefined; },
        async delete(_name: string, id: string) { rows.delete(id); ordered = undefined; },
        async clear() { rows.clear(); ordered = undefined; },
        async count() { return rows.size; },
        transaction() {
            const store = {
                async get(id: string) { return structuredClone(rows.get(id)); },
                async getKey(id: string) { return rows.has(id) ? id : undefined; },
                put: (row: Row) => database.put("messages", row),
                add: (row: Row) => database.put("messages", row),
                delete: (id: string) => database.delete("messages", id),
                async openCursor(range?: { from: string; through?: string; }) {
                    pageCalls++;
                    const pending = nextPage;
                    nextPage = undefined;
                    await pending;
                    ordered ??= Array.from(rows.keys()).sort();
                    const through = range?.through;
                    const keys = through ? ordered.filter(key => key <= through) : ordered;
                    let i = range ? keys.findIndex(key => key >= range.from) : 0;
                    const cursor = () => i < 0 || i >= keys.length ? null : {
                        get value() { scans++; return structuredClone(rows.get(keys[i])); },
                        get primaryKey() { return keys[i]; },
                        async continue() { i++; return cursor(); }
                    };
                    return cursor();
                }
            };
            return { store, done: Promise.resolve() };
        }
    };
    const mocks: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "A" }) } },
        idb: { openDB: async (_name: string, version: number) => { assert.equal(version, 1); return database; } },
        "./utils": { getMessageStatus: () => "DELETED", cleanupMessage: (value: Message) => structuredClone(value) },
        "./utils/cleanUp": { stripTransientRenderState() {} },
        "./utils/constants": { DB_VERSION: 1 }, "./utils/LimitedMap": { LimitedMap: Map },
        "./utils/saveImage": { clearAttachmentBlobUrlCache() {}, getAttachmentBlobUrl() { hydrated++; }, invalidateAttachmentBlobUrl() {}, prepareMessageImages: (value: Message) => value.attachments.map(a => a.id) },
        ".": { settings },
        "../..": { Flogger: { error: (...values: unknown[]) => errors.push(values) }, Native: { cancelNativeAttachmentDownloads: async () => { if (cancelFailures-- > 0) throw new Error("IPC unavailable"); } } },
        "@utils/misc": { sleep: flush },
        "./ImageManager": { downloadAttachment: (attachment: Attachment, signal: AbortSignal) => new Promise<string | undefined>(resolve => {
            active++;
            maxActive = Math.max(active, maxActive);
            let done = false;
            const finish = (path?: string) => {
                if (done) return;
                done = true;
                active--;
                resolve(path);
            };
            signal.addEventListener("abort", () => finish(), { once: true });
            requests.push({ attachment, finish });
        }) }
    };
    function load(file: string) {
        const { outputText } = transpileModule(readFileSync(`src/equicordplugins/messageLoggerEnhanced/${file}`, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, AbortController, AbortSignal, DOMException, crypto: { randomUUID },
            IDBKeyRange: { lowerBound: (from: string) => ({ from }), bound: (from: string, through: string) => ({ from, through }) }, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
    }
    const db = load("db.ts") as Database;
    mocks["./db"] = mocks["../../db"] = db;
    const manager = load("LoggedMessageManager.ts") as { addMessage(message: Message, status: string): Promise<void>; };
    const backlog = load("utils/saveImage/backlog.ts") as { startAttachmentBacklog(owner: string): void; stopAttachmentBacklog(): void; };
    await db.initIDB();
    return { rows, db, manager, backlog, requests, errors, settings,
        failCancel() { cancelFailures = 1; },
        holdPage(promise: Promise<void>) { nextPage = promise; },
        get pageCalls() { return pageCalls; }, get scans() { return scans; }, get hydrated() { return hydrated; }, get maxActive() { return maxActive; }, get active() { return active; } };
}

test("Stalled downloads leave all sixteen messages durable and only one compact job active", async () => {
    const f = await fixture();
    f.backlog.startAttachmentBacklog("A");
    await Promise.all(Array.from({ length: 16 }, (_, i) => f.manager.addMessage(message(String(i)), "DELETED")));
    await until(() => f.requests.length === 1);
    assert.equal(f.rows.size, 16);
    assert.equal(f.maxActive, 1);
    assert.ok(Array.from(f.rows.values()).every(row => row.attachmentWork?.ownerId === "A"));
    assert.deepEqual(Object.keys(f.requests[0].attachment).sort(), ["fileExtension", "id", "oldUrl", "url"]);
    f.backlog.stopAttachmentBacklog();
    await until(() => f.active === 0);
});

test("Interrupted jobs resume for their owner across A B A and preserve message content", async () => {
    const f = await fixture();
    await f.manager.addMessage(message("1"), "DELETED");
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.requests.length === 1);
    f.backlog.stopAttachmentBacklog();
    f.backlog.startAttachmentBacklog("B");
    await until(() => f.active === 0);
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(f.requests.length, 1);
    assert.ok(f.rows.get("1")?.attachmentWork);
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.requests.length === 2);
    const cached = f.db.cachedMessages.get("1");
    f.requests[1].finish("saved.png");
    await until(() => !f.rows.get("1")?.attachmentWork);
    assert.equal(f.rows.get("1")?.message.attachments[0].path, "saved.png");
    assert.equal(f.rows.get("1")?.message.content, "message");
    assert.equal(f.db.cachedMessages.get("1"), cached);
    assert.equal(cached?.attachments[0].path, "saved.png");
    f.backlog.stopAttachmentBacklog();
});

for (const action of ["delete", "clear", "retention", "replace"] as const) test(`An active ${action} cannot resurrect or overwrite its row`, async () => {
    const f = await fixture();
    await f.manager.addMessage(message("1"), "DELETED");
    const { job } = await f.db.getAttachmentWorkPage("A");
    assert.ok(job);
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.requests.length === 1);
    if (action === "delete") await f.db.deleteMessageIDB("1");
    if (action === "clear") await f.db.clearMessagesIDB(false);
    if (action === "retention") await f.db.deleteMessagesBulkIDB(["1"]);
    if (action === "replace") await f.db.addMessageIDB({ ...message("1"), content: "replacement" }, "EDITED");
    await f.db.completeAttachmentWork(job, "stale.png");
    await until(() => f.active === 0);
    assert.equal(f.rows.size, action === "replace" ? 1 : 0);
    assert.equal(f.rows.get("1")?.message.attachments[0].path, undefined);
    f.backlog.stopAttachmentBacklog();
});

test("Imports never create work and duplicate imports preserve pending live messages", async () => {
    const f = await fixture();
    await f.manager.addMessage(message("1"), "DELETED");
    const work = structuredClone(f.rows.get("1")?.attachmentWork);
    assert.equal(await f.db.importMessagesIDB([message("1"), message("2")]), 1);
    assert.deepEqual(f.rows.get("1")?.attachmentWork, work);
    assert.equal(f.rows.get("2")?.attachmentWork, undefined);
    await f.db.addMessagesBulkIDB([message("3")], "DELETED");
    await f.manager.addMessage(message("4"), "EDITED");
    await f.manager.addMessage(message("5"), "GHOST_PINGED");
    f.settings.store.saveImages = false;
    await f.manager.addMessage(message("6"), "DELETED");
    assert.equal(Array.from(f.rows.values()).filter(row => row.attachmentWork).length, 1);
});

test("A 10000 row history scans once in bounded pages with no image hydration or later full rescans", async () => {
    const f = await fixture();
    for (let i = 0; i < 10000; i++) await f.db.addMessageIDB(message(String(i).padStart(5, "0")), "DELETED");
    f.db.cachedMessages.clear();
    const start = performance.now();
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.scans >= 10000);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(f.scans, 10000);
    assert.equal(f.hydrated, 0);
    assert.equal(f.db.cachedMessages.size, 0);
    await f.manager.addMessage(message("99999"), "DELETED");
    await until(() => f.requests.length === 1);
    assert.equal(f.scans, 10001);
    f.requests[0].finish("saved.png");
    await until(() => !f.rows.get("99999")?.attachmentWork);
    for (let i = 0; i < 5; i++) await flush();
    const before = f.scans;
    for (let i = 0; i < 3; i++) {
        const id = String(i).padStart(5, "0");
        await f.manager.addMessage(message(id), "DELETED");
        await until(() => f.requests.length === i + 2);
        f.requests[i + 1].finish("saved.png");
        await until(() => !f.rows.get(id)?.attachmentWork);
        for (let n = 0; n < 5; n++) await flush();
    }
    assert.equal(f.scans - before, 6);
    console.log(`Scanned 10000 historical rows in ${(performance.now() - start).toFixed(1)} ms across 100 yielded pages.`);
    f.backlog.stopAttachmentBacklog();
});


test("A failed cancellation does not poison later sessions", async () => {
    const f = await fixture();
    await f.manager.addMessage(message("1"), "DELETED");
    f.failCancel();
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.requests.length === 1);
    assert.equal(f.errors.length, 1);
    f.backlog.stopAttachmentBacklog();
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.requests.length === 2);
    f.backlog.stopAttachmentBacklog();
});

test("An old session page rejection cannot mark the new owner exhausted", async () => {
    const f = await fixture();
    let rejectPage: (error: Error) => void = () => assert.fail("Missing page");
    f.holdPage(new Promise<void>((_resolve, reject) => rejectPage = reject));
    f.backlog.startAttachmentBacklog("A");
    await until(() => f.pageCalls === 1);
    f.backlog.startAttachmentBacklog("B");
    rejectPage(new Error("Old read failed"));
    await until(() => f.pageCalls === 2);
    assert.equal(f.errors.length, 0);
    f.backlog.stopAttachmentBacklog();
});
