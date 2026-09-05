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
const { delMany, entries, setMany, update } = runInNewContext(`${outputText}\nexports;`, { exports: {} });

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

test("DataStore cursor entries reuse the existing transaction", async () => {
    let transactions = 0;
    const pending = entries(async (_mode: string, callback: (store: object) => unknown) => {
        transactions++;
        const transaction: { oncomplete?: () => void; } = {};
        const request: { result: { key: string; value: number; continue(): void; } | null; onsuccess?: () => void; } = {
            result: { key: "fixture", value: 4, continue() { request.result = null; request.onsuccess?.(); transaction.oncomplete?.(); } }
        };
        const result = callback({ transaction, openCursor: () => request });
        queueMicrotask(() => request.onsuccess?.());
        return result;
    });
    const result = await pending;
    assert.equal(JSON.stringify(result), JSON.stringify([["fixture", 4]]));
    assert.equal(transactions, 1);
});
