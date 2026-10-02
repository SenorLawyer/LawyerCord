/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const { outputText } = transpileModule(readFileSync("src/api/DataStore/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});
const { delMany, entries, keys, values, setMany, update, updateMany } = runInNewContext(`${outputText}\nexports;`, { exports: {}, structuredClone });

test("DataStore multi-key updates share one transaction and abort partial writes", async () => {
    for (const outcome of ["get-error", "read-error", "updater-error", "put-error", "abort", "commit"] as const) {
        const error = new Error(outcome);
        const saved = new Map<string, number>([["first", 1], ["second", 2]]);
        const pendingWrites = new Map<string, number>();
        const requests: { result: number | undefined; onsuccess?: () => void; }[] = [];
        let aborts = 0;
        let transactions = 0;
        let settled = false;
        const transaction: { error: Error | null; abort(): void; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; } = {
            error: null,
            abort() { aborts++; pendingWrites.clear(); this.error = error; this.onabort?.(); }
        };
        const pending = updateMany([
            ["first", (value: number) => value + 10],
            ["second", (value: number) => { if (outcome === "updater-error") throw error; return value + 20; }]
        ], async (mode: string, callback: (store: object) => unknown) => {
            transactions++;
            assert.equal(mode, "readwrite");
            return callback({
                transaction,
                get(key: string) {
                    if (key === "second" && outcome === "get-error") throw error;
                    const request = { result: saved.get(key) };
                    requests.push(request);
                    return request;
                },
                put(value: number, key: string) {
                    if (key === "second" && outcome === "put-error") throw error;
                    pendingWrites.set(key, value);
                }
            });
        }).finally(() => { settled = true; });
        const checked = outcome === "commit" ? pending : assert.rejects(pending, (reason: unknown) => reason === error);
        if (outcome !== "get-error") {
            requests[0].onsuccess?.();
            if (outcome === "read-error" || outcome === "abort") {
                transaction.error = error;
                pendingWrites.clear();
                if (outcome === "read-error") transaction.onerror?.();
                else transaction.onabort?.();
            } else {
                requests[1].onsuccess?.();
                if (outcome === "commit") {
                    await setImmediate();
                    assert.equal(settled, false);
                    for (const [key, value] of pendingWrites) saved.set(key, value);
                    transaction.oncomplete?.();
                }
            }
        }
        await checked;
        assert.equal(transactions, 1);
        assert.deepEqual([...saved.values()], outcome === "commit" ? [11, 22] : [1, 2]);
        assert.equal(aborts, ["get-error", "updater-error", "put-error"].includes(outcome) ? 1 : 0);
    }
});

test("DataStore updates settle on read failure, abort, write failure, and commit", async () => {
    for (const outcome of ["read-error", "abort", "write-error", "updater-error", "commit"] as const) {
        const error = new Error(outcome);
        const request: { result: number; onsuccess?: () => void; } = { result: 4 };
        const transaction: { error: Error | null; onerror?: () => void; onabort?: () => void; oncomplete?: () => void; } = { error: null };
        const writes: number[] = [];
        let settled = false;
        let rejection: unknown;
        const pending = update("fixture", (value: number) => {
            if (outcome === "updater-error") throw error;
            return value + 1;
        }, async (_mode: string, callback: (store: object) => unknown) => callback({
            transaction,
            get: () => request,
            put(value: number) {
                if (outcome === "write-error") throw error;
                writes.push(value);
            }
        })).then(() => { settled = true; }, (reason: unknown) => { settled = true; rejection = reason; });

        if (outcome === "read-error" || outcome === "abort") {
            transaction.error = error;
            if (outcome === "abort") transaction.onabort?.();
            else transaction.onerror?.();
        } else {
            request.onsuccess?.();
            if (outcome === "commit") {
                await setImmediate();
                assert.equal(settled, false, "a successful put must wait for transaction commit");
            }
            transaction.oncomplete?.();
        }
        await setImmediate();
        assert.equal(settled, true, `${outcome} must settle the update promise`);
        await pending;
        assert.equal(rejection, outcome === "commit" ? undefined : error);
        assert.deepEqual(writes, outcome === "commit" ? [5] : []);
    }
});

for (const [name, batch, input] of [
    ["setMany", setMany, [["first", 1], ["second", 2], ["third", 3]]],
    ["delMany", delMany, ["first", "second", "third"]]
] as const) {
    test(`DataStore ${name} aborts queued work when a later request throws`, async () => {
        const error = new Error("invalid request");
        let requests = 0;
        let aborts = 0;
        const enqueue = () => { if (++requests === 2) throw error; };
        await assert.rejects(batch(input, async (_mode: string, callback: (store: object) => unknown) => callback({
            transaction: { abort() { aborts++; } },
            put: enqueue,
            delete: enqueue
        })), (reason: unknown) => reason === error);
        assert.equal(requests, 2);
        assert.equal(aborts, 1);
    });

    test(`DataStore ${name} waits for commit and rejects transaction failures`, async () => {
        for (const values of [[], input]) {
            for (const failed of [false, true]) {
                const error = new Error("transaction failed");
                const transaction: { error: Error; oncomplete?: () => void; onerror?: () => void; } = { error };
                let settled = false;
                const pending = batch(values, async (_mode: string, callback: (store: object) => unknown) => callback({
                    transaction, put() { }, delete() { }
                })).then(() => { settled = true; }, (reason: unknown) => { settled = true; throw reason; });
                await setImmediate();
                assert.equal(settled, false);
                if (failed) {
                    const rejected = assert.rejects(pending, (reason: unknown) => reason === error);
                    transaction.onerror?.();
                    await rejected;
                } else {
                    transaction.oncomplete?.();
                    await pending;
                }
            }
        }
    });
}

test("DataStore bulk reads preserve key/value pairing in one transaction and reject request errors", async () => {
    for (const read of [keys, values, entries]) {
        for (const failed of [undefined, "keys", "values"] as const) {
            const storedKeys = [1, "fixture", ["compound", 2]];
            const storedValues = [null, { saved: true }, new Map([["item", 4]])];
            const requests: { name: string; result: unknown; error: Error; onsuccess?: () => void; onerror?: () => void; }[] = [];
            const error = new Error("Read failed");
            let transactions = 0;
            const pending = read(async (mode: string, callback: (store: object) => unknown) => {
                transactions++;
                assert.equal(mode, "readonly");
                const request = (name: string, result: unknown) => {
                    const value = { name, result, error };
                    requests.push(value);
                    return value;
                };
                return callback({
                    getAllKeys: () => request("keys", storedKeys),
                    getAll: () => request("values", storedValues)
                });
            });
            const rejecting = requests.some(request => request.name === failed);
            const checked = rejecting ? assert.rejects(pending, (reason: unknown) => reason === error) : pending;
            for (const request of requests.toReversed()) {
                if (request.name === failed) request.onerror?.();
                else request.onsuccess?.();
            }
            await checked;
            if (!rejecting) {
                const expected = read === keys ? storedKeys : read === values ? storedValues : storedKeys.map((key, index) => [key, storedValues[index]]);
                assert.deepEqual(structuredClone(await pending), expected);
            }
            assert.equal(transactions, 1);
        }
    }
});

test("DataStore filtered entries never read excluded large values and keep one transaction", async () => {
    const stored = new Map<string, unknown>([["large-local-model", new Uint8Array(1024 * 1024)], ["public", { saved: true }]]);
    let transactions = 0;
    let bulkReads = 0;
    const valueReads: string[] = [];
    const request = (result: unknown) => {
        const value: { result: unknown; onsuccess?: () => void; } = { result };
        queueMicrotask(() => value.onsuccess?.());
        return value;
    };
    const result = await entries(async (_mode: string, callback: (store: object) => unknown) => {
        transactions++;
        return callback({
            getAllKeys: () => request([...stored.keys()]),
            getAll() { bulkReads++; return request([...stored.values()]); },
            get(key: string) { valueReads.push(key); return request(stored.get(key)); }
        });
    }, (key: unknown) => key === "public");
    assert.deepEqual(Array.from(result, ([key]: [string, unknown]) => key), ["public"]);
    assert.deepEqual(structuredClone(result[0][1]), { saved: true });
    assert.equal(bulkReads, 0);
    assert.deepEqual(valueReads, ["public"]);
    assert.equal(transactions, 1);
});
