/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const JSONParserModule = createRequire(import.meta.url)("@streamparser/json/jsonparser.js");

interface LogMessage { id: string; channel_id: string; timestamp: string; deleted: boolean; content: string; }
interface LogRecord { message_id: string; message: LogMessage; }
const message = (id: string, content = id): LogMessage => ({ id, content, channel_id: "channel", timestamp: "2026-10-01T00:00:00.000Z", deleted: true });

function load(path: string, mocks: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    return runInNewContext(`${outputText}\nexports;`, { exports: {}, ...extra,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
}

async function fixture(chunks: string[] = []) {
    const saved = new Map<string, LogRecord>([["saved", { message_id: "saved", message: message("saved", "original") }]]);
    let failureId: string | undefined;
    let transactions = 0;
    let closed = 0;
    let cleared = 0;
    const notices: { message: string; type: string; }[] = [];
    const database = {
        transaction(_store: string, mode: string) {
            assert.equal(mode, "readwrite");
            transactions++;
            const pending = new Map(saved);
            let failure: Error | undefined;
            return {
                done: new Promise<void>((resolve, reject) => setImmediate(() => {
                    if (failure) return reject(failure);
                    saved.clear();
                    for (const [key, record] of pending) saved.set(key, record);
                    resolve();
                })),
                store: {
                    put: async (record: LogRecord) => { pending.set(record.message_id, structuredClone(record)); return record.message_id; },
                    getKey: async (key: string) => pending.has(key) ? key : undefined,
                    add: async (record: LogRecord) => {
                        if (record.message_id === failureId || pending.has(record.message_id)) {
                            failure = new Error("Request failed");
                            throw failure;
                        }
                        pending.set(record.message_id, structuredClone(record));
                        return record.message_id;
                    }
                }
            };
        }
    };
    const toast = { genId: () => "toast", show: (notice: { message: string; type: string; }) => notices.push(notice), Type: { FAILURE: "failure", SUCCESS: "success" } };
    const db = load(process.env.AUDIT_LOG_IMPORT_DB_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/db.ts", {
        "@webpack/common": { Toasts: toast }, idb: { openDB: async () => database },
        "./utils/LimitedMap": load("src/equicordplugins/messageLoggerEnhanced/utils/LimitedMap.ts", { "../index": { settings: { store: { cacheLimit: 1000 } } } }),
        "./utils": { getMessageStatus: (value: LogMessage) => { if (!value.deleted) throw new Error("Unknown status"); return "DELETED"; } },
        "./utils/cleanUp": { stripTransientRenderState() {} }, "./utils/constants": {}, "./utils/saveImage": {}
    }) as { importMessagesIDB?: (messages: LogMessage[]) => Promise<number>; addMessagesBulkIDB(messages: LogMessage[]): Promise<void>; cachedMessages: Map<string, LogMessage>; };
    await Promise.resolve();
    const settings = load(process.env.AUDIT_LOG_IMPORT_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/utils/settingsUtils.ts", {
        "@streamparser/json/jsonparser.js": JSONParserModule, "@utils/web": {}, "native-file-system-adapter": {},
        "@webpack/common": { Toasts: toast }, "../db": db,
        "..": { clearLogs: async () => { cleared++; saved.clear(); }, Native: {
            getSettings: async () => ({}), startNativeLogImport: async () => "file",
            readNativeLogChunk: async () => chunks.shift() ?? null, closeNativeLogImport: async () => { closed++; }
        } }
    }, { IS_WEB: false, console: { error() {} } }) as { importLogs(): Promise<void>; };
    return { saved, db, settings, notices, failAt(id: string) { failureId = id; },
        counts: () => ({ cleared, closed, transactions }) };
}

test("Malformed log imports keep every previously saved log", async () => {
    const f = await fixture(['{"messages":[' + JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ message: message(String(i)) }))) + ',', 'broken']);
    await f.settings.importLogs();
    assert.equal(f.saved.get("saved")?.message.content, "original");
    assert.equal(f.counts().cleared, 0);
    assert.equal(f.counts().closed, 1);
    assert.equal(f.notices.at(-1)?.type, "failure");
});

test("Valid streamed imports preserve saved logs and ignore duplicates within and across batches", async () => {
    const values = [message("saved", "replacement"), ...Array.from({ length: 60 }, (_, i) => message(String(i))), message("0", "duplicate")];
    const f = await fixture([JSON.stringify({ messages: [values.slice(0, 30).map(value => ({ message: value })), values.slice(30).map(value => ({ message: value }))] })]);
    await f.settings.importLogs();
    assert.equal(f.saved.size, 61);
    assert.equal(f.saved.get("saved")?.message.content, "original");
    assert.equal(f.saved.get("0")?.message.content, "0");
    assert.equal(f.counts().cleared, 0);
    assert.equal(f.counts().closed, 1);
    assert.equal(f.notices.at(-1)?.message, "Successfully imported 60 logs");
});

test("Import batches expose neither partial writes nor cache entries when a request fails", async () => {
    const f = await fixture();
    f.failAt("bad");
    assert.ok(f.db.importMessagesIDB);
    await assert.rejects(f.db.importMessagesIDB([message("new"), message("bad")]), /Request failed/);
    assert.equal(f.saved.size, 1);
    assert.equal(f.db.cachedMessages.size, 0);
});

test("Repeated imports count only committed new records and keep saved cache entries intact", async () => {
    const f = await fixture();
    assert.ok(f.db.importMessagesIDB);
    f.db.cachedMessages.set("saved", message("saved", "cached original"));
    assert.equal(await f.db.importMessagesIDB([message("saved", "replacement"), message("new"), message("new", "duplicate")]), 1);
    assert.equal(await f.db.importMessagesIDB([message("new")]), 0);
    assert.equal(f.db.cachedMessages.get("saved")?.content, "cached original");
    assert.equal(f.db.cachedMessages.get("new")?.content, "new");
});

test("Bulk deletion logging updates already edited records without aborting the other deletions", async () => {
    const f = await fixture();
    await f.db.addMessagesBulkIDB([message("saved", "deleted replacement"), message("new")]);
    assert.equal(f.saved.get("saved")?.message.content, "deleted replacement");
    assert.equal(f.saved.get("new")?.message.content, "new");
});
