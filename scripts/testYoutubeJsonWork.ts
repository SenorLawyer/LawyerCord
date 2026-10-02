/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function fixture() {
    class Response {
        constructor(private body: object) {}
        async json() { return this.body; }
    }
    const api = runInNewContext(`${readFileSync(process.env.AUDIT_YOUTUBE_SOURCE ?? "src/plugins/youtubeAdblock.desktop/adguard.js", "utf8")}\n({ parse: JSON.parse, Response });`, {
        window: {}, Response,
        document: { querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({}), head: { appendChild() {} }, documentElement: {} },
        MutationObserver: class { observe() {} }
    }) as { parse(text: string, reviver?: (key: string, value: unknown) => unknown): Record<string, unknown>; Response: typeof Response; };
    return api;
}

test("YouTube metadata is stripped from nested arrays in one object traversal", () => {
    const api = fixture();
    let reads = 0;
    const body = { child: { adPlacements: ["ad"], playerAds: ["ad"], content: "video" } };
    const parsed = api.parse('{"payload":0}', (key: string, value: unknown) => {
        if (key !== "payload") return value;
        return Object.defineProperty({}, "child", { enumerable: true, get() { reads++; return body.child; } });
    });
    assert.equal(reads, 1);
    assert.deepEqual(Array.from(body.child.adPlacements), []);
    assert.deepEqual(Array.from(body.child.playerAds), []);
    assert.equal(body.child.content, "video");
    assert.ok(parsed.payload);
});

test("YouTube JSON interception preserves normal content and the JSON reviver contract", async () => {
    const api = fixture();
    let revived = 0;
    const parsed = api.parse('{"items":[{"adPlacements":[1],"playerAds":[2],"title":"video"}],"count":3}', (key: string, value: unknown) => {
        revived++;
        return key === "count" ? 4 : value;
    });
    assert.equal(JSON.stringify(parsed), '{"items":[{"adPlacements":[],"playerAds":[],"title":"video"}],"count":4}');
    assert.ok(revived > 0);
    assert.throws(() => api.parse("invalid"));
    assert.equal(JSON.stringify(api.parse("null")), "null");
    const response = new api.Response({ items: [{ playerAds: ["ad"], adPlacements: ["ad"], value: 3 }] });
    assert.equal(JSON.stringify(await response.json()), '{"items":[{"playerAds":[],"adPlacements":[],"value":3}]}');
});

test("Deep JSON metadata and reviver-created cycles do not overflow the call stack", () => {
    const api = fixture();
    let parsed = api.parse('{"child":'.repeat(8000) + '{"playerAds":[1],"adPlacements":[2]}' + "}".repeat(8000));
    for (let i = 0; i < 8000; i++) parsed = parsed.child as Record<string, unknown>;
    assert.deepEqual(Array.from(parsed.playerAds as unknown[]), []);
    assert.deepEqual(Array.from(parsed.adPlacements as unknown[]), []);
    const cycle: { child?: object; playerAds: unknown[]; adPlacements: unknown[]; } = { playerAds: [1], adPlacements: [2] };
    cycle.child = cycle;
    assert.equal(api.parse("{}", (key: string, value: unknown) => key === "" ? cycle : value), cycle);
    assert.deepEqual(Array.from(cycle.playerAds), []);
    assert.deepEqual(Array.from(cycle.adPlacements), []);
});
