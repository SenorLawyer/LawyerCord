/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Streak updates coalesce an unresolved message burst and release network work on account cleanup", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/streaks/stores/StreaksStore.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    let requests = 0;
    const signals: AbortSignal[] = [];
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() }, "../constants": { API_URL: "https://fixture.invalid" },
        "./AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => "fixture" }) } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) },
            zustandCreate: (factory: (set: (value: object) => void, get: () => object) => object) => {
                let state: object = factory(value => state = { ...state, ...value }, () => state);
                return { getState: () => state };
            } }
    };
    const api = runInNewContext(`${source};exports`, {
        exports: {}, AbortController, AbortSignal: {}, setTimeout, clearTimeout, console, require: (name: string) => modules[name],
        fetch: (_url: string, options: { signal: AbortSignal; }) => {
            requests++;
            if (options.signal) signals.push(options.signal);
            return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
        }
    });
    const state = api.useStreaksStore.getState();
    const pending = Array.from({ length: 100 }, () => state.update("peer"));
    assert.equal(requests, 1);
    state.clear();
    assert.ok(signals.every(signal => signal.aborted));
    await Promise.all(pending);
});

test("Streak deadline cancels a real HTTP response stalled during JSON decoding and permits the next request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const source = transpileModule(readFileSync("src/equicordplugins/streaks/stores/StreaksStore.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() }, "../constants": { API_URL: `http://127.0.0.1:${address.port}` },
        "./AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => "fixture" }) } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) },
            zustandCreate: (factory: (set: (value: object) => void, get: () => object) => object) => {
                let state: object = factory(value => state = { ...state, ...value }, () => state);
                return { getState: () => state };
            } }
    };
    const deadlines = new Map<number, () => void>();
    let timerId = 0;
    let bodyReads = 0;
    const api = runInNewContext(`${source};exports`, {
        exports: {}, AbortController, console, require: (name: string) => modules[name],
        fetch: async (...args: Parameters<typeof fetch>) => {
            const response = await fetch(...args);
            return { ok: response.ok, json: () => {
                bodyReads++;
                const pending = response.json();
                assert.equal(deadlines.size, 1);
                for (const expire of deadlines.values()) expire();
                return pending;
            } };
        },
        AbortSignal: {}, clearTimeout: (id: number) => deadlines.delete(id), setTimeout: (callback: () => void, duration: number) => {
            assert.equal(duration, 30_000);
            deadlines.set(++timerId, callback);
            return timerId;
        }
    });
    try {
        const state = api.useStreaksStore.getState();
        await state.update("peer");
        await state.update("peer");
        assert.equal(requests, 2);
        assert.equal(bodyReads, 2);
        assert.equal(deadlines.size, 0);
        assert.equal(Object.keys(state.streaks).length, 0);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
