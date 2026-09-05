/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TTLMap } from "../src/utils/TTLMap";

test("TTLMap expires once and removes the entry before notifying", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number][] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => {
        assert.equal(cache.has(key), false);
        expired.push([key, value]);
    });

    assert.equal(cache.set("a", 1), cache);
    t.mock.timers.tick(99);
    assert.equal(cache.get("a"), 1);
    assert.deepEqual(expired, []);
    t.mock.timers.tick(1);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [["a", 1]]);
    t.mock.timers.tick(100);
    assert.deepEqual(expired, [["a", 1]]);
});

test("TTLMap replacement gets a full lifetime and only expires the latest value", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number][] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => expired.push([key, value]));

    cache.set("a", 1);
    t.mock.timers.tick(60);
    cache.set("a", 2);
    t.mock.timers.tick(40);
    assert.equal(cache.get("a"), 2);
    assert.deepEqual(expired, []);
    t.mock.timers.tick(59);
    assert.equal(cache.get("a"), 2);
    t.mock.timers.tick(1);
    assert.equal(cache.has("a"), false);
    assert.deepEqual(expired, [["a", 2]]);
});

test("TTLMap updating a key preserves Map insertion order", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cache = new TTLMap<string, number>(100);

    cache.set("a", 1).set("b", 2).set("a", 3);
    assert.deepEqual([...cache], [["a", 3], ["b", 2]]);
    assert.equal(cache.size, 2);
});

test("TTLMap delete cancels every timer after repeated replacement", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired = t.mock.fn();
    const cache = new TTLMap<string, number>(100, expired);

    cache.set("a", 1).set("a", 2).set("a", 3);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.delete("a"), false);
    t.mock.timers.tick(1000);
    assert.equal(cache.size, 0);
    assert.equal(expired.mock.callCount(), 0);
});

test("TTLMap clear cancels replaced entries without expiration callbacks", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired = t.mock.fn();
    const cache = new TTLMap<string, number>(100, expired);

    cache.set("a", 1).set("b", 2);
    t.mock.timers.tick(50);
    cache.set("a", 3).set("b", 4);
    assert.equal(cache.clear(), undefined);
    cache.clear();
    t.mock.timers.tick(1000);
    assert.equal(cache.size, 0);
    assert.equal(expired.mock.callCount(), 0);
});

for (const operation of ["delete", "clear"] as const) {
    test(`TTLMap ${operation} followed by reinsertion cannot inherit an old timer`, t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const expired: number[] = [];
        const cache = new TTLMap<string, number>(100, (_key, value) => expired.push(value));

        cache.set("a", 1);
        t.mock.timers.tick(20);
        cache.set("a", 2);
        if (operation === "delete") cache.delete("a");
        else cache.clear();
        t.mock.timers.tick(20);
        cache.set("a", 3);
        t.mock.timers.tick(60);
        assert.equal(cache.get("a"), 3);
        assert.deepEqual(expired, []);
        t.mock.timers.tick(40);
        assert.equal(cache.size, 0);
        assert.deepEqual(expired, [3]);
    });
}

test("TTLMap expiration callbacks may reinsert the same key", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: number[] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => {
        expired.push(value);
        if (value === 1) cache.set(key, 2);
    });

    cache.set("a", 1);
    t.mock.timers.tick(100);
    assert.equal(cache.get("a"), 2);
    t.mock.timers.tick(100);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [1, 2]);
});

test("TTLMap keys retain Map identity and SameValueZero semantics", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const left = {};
    const right = {};
    const cache = new TTLMap<object | number, string>(100);

    cache.set(left, "left").set(right, "right").set(NaN, "old");
    t.mock.timers.tick(50);
    cache.set(NaN, "new");
    assert.equal(cache.size, 3);
    t.mock.timers.tick(50);
    assert.equal(cache.has(left), false);
    assert.equal(cache.has(right), false);
    assert.equal(cache.get(NaN), "new");
    t.mock.timers.tick(50);
    assert.equal(cache.size, 0);
});

test("TTLMap supports undefined values and independent expiration times", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number | undefined][] = [];
    const cache = new TTLMap<string, number | undefined>(100, (key, value) => expired.push([key, value]));

    cache.set("a", undefined);
    t.mock.timers.tick(50);
    cache.set("b", 2);
    assert.equal(cache.has("a"), true);
    t.mock.timers.tick(50);
    assert.equal(cache.has("a"), false);
    assert.equal(cache.get("b"), 2);
    assert.deepEqual(expired, [["a", undefined]]);
    t.mock.timers.tick(50);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [["a", undefined], ["b", 2]]);
});

test("TTLMap matches a reference model over 10000 deterministic operations", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const actualExpired: number[] = [];
    const cache = new TTLMap<number, number>(100, (_key, value) => actualExpired.push(value));
    const model = new Map<number, { value: number; expires: number; }>();
    let now = 0;
    let seed = 0x5eed;
    const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    for (let step = 0; step < 10000; step++) {
        const operation = random() % 10;
        const key = random() % 8;
        if (operation < 5) {
            cache.set(key, step);
            model.set(key, { value: step, expires: now + 100 });
        } else if (operation < 7) {
            assert.equal(cache.delete(key), model.delete(key));
        } else if (operation === 7) {
            cache.clear();
            model.clear();
        } else {
            const elapsed = random() % 150;
            now += elapsed;
            const expectedExpired: number[] = [];
            for (const [entryKey, entry] of model) {
                if (entry.expires <= now) {
                    model.delete(entryKey);
                    expectedExpired.push(entry.value);
                }
            }
            t.mock.timers.tick(elapsed);
            assert.deepEqual(actualExpired.sort((a, b) => a - b), expectedExpired.sort((a, b) => a - b), `expiration at step ${step}`);
            actualExpired.length = 0;
        }
        assert.deepEqual([...cache], [...model].map(([entryKey, entry]) => [entryKey, entry.value]), `entries at step ${step}`);
    }
    cache.clear();
    t.mock.timers.tick(1000);
    assert.deepEqual(actualExpired, []);
});

