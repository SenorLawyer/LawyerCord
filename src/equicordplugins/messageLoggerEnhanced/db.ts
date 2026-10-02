/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, Toasts } from "@webpack/common";
import { DBSchema, IDBPDatabase, openDB } from "idb";

import { LoggedMessageJSON } from "./types";
import { getMessageStatus } from "./utils";
import { stripTransientRenderState } from "./utils/cleanUp";
import { DB_NAME, DB_VERSION } from "./utils/constants";
import { LimitedMap } from "./utils/LimitedMap";
import { clearAttachmentBlobUrlCache, getAttachmentBlobUrl } from "./utils/saveImage";

export enum DBMessageStatus {
    DELETED = "DELETED",
    EDITED = "EDITED",
    GHOST_PINGED = "GHOST_PINGED",
}

export interface DBMessageRecord {
    message_id: string;
    channel_id: string;
    status: DBMessageStatus;
    message: LoggedMessageJSON;
}

export interface MLIDB extends DBSchema {
    messages: {
        key: string;
        value: DBMessageRecord;
        indexes: {
            by_channel_id: string;
            by_status: DBMessageStatus;
            by_timestamp: string;
            by_timestamp_and_message_id: [string, string];
        };
    };

}

export let db: IDBPDatabase<MLIDB>;
let dbPromise: Promise<IDBPDatabase<MLIDB>> | undefined;
let cacheGeneration = 0;
export const cachedMessages = new LimitedMap<string, LoggedMessageJSON>();

export function clearMessageCache() {
    cacheGeneration++;
    cachedMessages.clear();
    clearAttachmentBlobUrlCache();
}

// this is probably not the best way to do this
async function cacheRecords(records: DBMessageRecord[], signal?: AbortSignal, generation = cacheGeneration) {
    for (const r of records) {
        if (signal?.aborted) throw new DOMException("Log query canceled.", "AbortError");
        if (generation !== cacheGeneration) break;
        cacheRecord(r);

        for (const att of r.message.attachments) {
            const blobUrl = await getAttachmentBlobUrl(att);
            if (signal?.aborted) throw new DOMException("Log query canceled.", "AbortError");
            if (generation !== cacheGeneration) return records;
            if (blobUrl) {
                att.url = blobUrl + "#";
                att.proxy_url = blobUrl + "#";
            }
        }
    }
    return records;
}

function cacheRecord(record?: DBMessageRecord | null) {
    if (!record) return record;

    stripTransientRenderState(record.message);
    cachedMessages.set(record.message_id, record.message);
    return record;
}

export async function initIDB() {
    if (db) return;
    db = await (dbPromise ??= openDB<MLIDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
            const messageStore = db.createObjectStore("messages", { keyPath: "message_id" });
            messageStore.createIndex("by_channel_id", "channel_id");
            messageStore.createIndex("by_status", "status");
            messageStore.createIndex("by_timestamp", "message.timestamp");
            messageStore.createIndex("by_timestamp_and_message_id", ["channel_id", "message.timestamp"]);
        }
    }).catch(error => {
        dbPromise = undefined;
        throw error;
    }));
}

export async function countMessagesIDB() {
    await initIDB();
    return db.count("messages");
}

export async function getMessageIDB(message_id: string) {
    const generation = cacheGeneration;
    await initIDB();
    const record = await db.get("messages", message_id);
    return generation === cacheGeneration ? cacheRecord(record) : record;
}

export async function getOldestMessagesIDB(limit: number) {
    await initIDB();
    return db.getAllFromIndex("messages", "by_timestamp", undefined, limit);
}

export async function* iterateAllMessagesIDB(batchSize = 100) {
    await initIDB();
    let lastId: string | undefined;
    while (true) {
        const batch: DBMessageRecord[] = [];
        // new transaction for each batch to avoid timeouts during yield
        const tx = db.transaction("messages");
        const range = lastId ? IDBKeyRange.lowerBound(lastId, true) : undefined;
        let cursor = await tx.store.openCursor(range);

        while (cursor && batch.length < batchSize) {
            batch.push(cursor.value);
            cursor = await cursor.continue();
        }

        if (batch.length === 0) break;

        lastId = batch[batch.length - 1].message_id;

        yield batch;

        if (batch.length < batchSize) break;
    }
}

export async function getOlderThanTimestampIDB(timestamp: string) {
    await initIDB();
    const tx = db.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_timestamp");

    const cursor = await index.openCursor(IDBKeyRange.upperBound(timestamp));

    if (!cursor) {
        return [];
    }

    const messages: DBMessageRecord[] = [];
    for await (const c of cursor) {
        messages.push(c.value);
    }

    return messages;
}

export async function getOlderThanTimestampForGuildsIDB(timestamp: string, currentChannelId?: string, preserveCurrentChannel?: boolean) {
    const allOldMessages = await getOlderThanTimestampIDB(timestamp);
    return allOldMessages.filter(record => {
        const { message } = record;
        const channel = ChannelStore.getChannel(message.channel_id);
        const isGuildMessage = channel?.guild_id != null;
        const isCurrentChannel = preserveCurrentChannel && currentChannelId && message.channel_id === currentChannelId;
        return isGuildMessage && !isCurrentChannel;
    });
}

export async function getMessagesPageIDB(newest: boolean, limit: number, status: DBMessageStatus, matches?: (record: DBMessageRecord) => boolean, signal?: AbortSignal) {
    const generation = cacheGeneration;
    await initIDB();
    if (signal?.aborted) throw new DOMException("Log query canceled.", "AbortError");
    const tx = db.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_status");

    const direction = newest ? "prev" : "next";
    const [cursor, statusTotal] = await Promise.all([
        index.openCursor(IDBKeyRange.only(status), direction),
        matches ? 0 : index.count(status)
    ]);

    const messages: DBMessageRecord[] = [];
    let total = matches ? 0 : statusTotal;
    if (cursor) for await (const c of cursor) {
        if (signal?.aborted) throw new DOMException("Log query canceled.", "AbortError");
        if (matches && !matches(c.value)) continue;
        if (matches) total++;
        if (messages.length < limit) messages.push(c.value);
        if (!matches && messages.length >= limit) break;
    }
    if (signal?.aborted) throw new DOMException("Log query canceled.", "AbortError");
    return { messages: await cacheRecords(messages, signal, generation), total };
}

export async function getMessagesByChannelAndAfterTimestampIDB(channel_id: string, start: string) {
    const generation = cacheGeneration;
    await initIDB();
    const tx = db.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_timestamp_and_message_id");

    const cursor = await index.openCursor(IDBKeyRange.bound([channel_id, start], [channel_id, "\uffff"]));

    if (!cursor) {
        return [];
    }

    const messages: DBMessageRecord[] = [];
    for await (const c of cursor) {
        messages.push(c.value);
    }

    return cacheRecords(messages, undefined, generation);
}

export async function addMessageIDB(message: LoggedMessageJSON, status: DBMessageStatus) {
    const generation = cacheGeneration;
    stripTransientRenderState(message);

    if (!db) await initIDB();
    await db.put("messages", {
        channel_id: message.channel_id,
        message_id: message.id,
        status,
        message,
    });

    if (generation === cacheGeneration) cachedMessages.set(message.id, message);
}

export async function addMessagesBulkIDB(messages: LoggedMessageJSON[], status?: DBMessageStatus) {
    const generation = cacheGeneration;
    await initIDB();
    messages.forEach(stripTransientRenderState);

    const tx = db.transaction("messages", "readwrite");
    const { store } = tx;

    await Promise.all([
        ...messages.map(message => store.put({
            channel_id: message.channel_id,
            message_id: message.id,
            status: status ?? getMessageStatus(message),
            message,
        })),
        tx.done
    ]);

    if (generation === cacheGeneration) messages.forEach(message => cachedMessages.set(message.id, message));
}

export async function importMessagesIDB(messages: LoggedMessageJSON[]) {
    const generation = cacheGeneration;
    await initIDB();
    const records = messages.map(message => {
        stripTransientRenderState(message);
        return { channel_id: message.channel_id, message_id: message.id, status: getMessageStatus(message), message };
    });
    const tx = db.transaction("messages", "readwrite");
    const imported: LoggedMessageJSON[] = [];
    await Promise.all([
        tx.done,
        (async () => {
            for (const record of records) {
                if (await tx.store.getKey(record.message_id) !== undefined) continue;
                await tx.store.add(record);
                imported.push(record.message);
            }
        })()
    ]);
    if (generation === cacheGeneration) for (const message of imported) cachedMessages.set(message.id, message);
    return imported.length;
}

export async function deleteMessageIDB(message_id: string) {
    await initIDB();
    await db.delete("messages", message_id);

    cachedMessages.delete(message_id);
}

export async function deleteMessagesBulkIDB(message_ids: string[]) {
    await initIDB();
    const tx = db.transaction("messages", "readwrite");
    const { store } = tx;

    await Promise.all([...message_ids.map(id => store.delete(id)), tx.done]);
    message_ids.forEach(id => cachedMessages.delete(id));
}

export async function clearMessagesIDB(showToast = true) {
    await initIDB();
    clearMessageCache();
    await db.clear("messages");
    if (!showToast) return;

    Toasts.show({
        type: Toasts.Type.MESSAGE,
        message: "Cleared message log database and cache.",
        id: Toasts.genId()
    });
}
