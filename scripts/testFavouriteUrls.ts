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
    let user = "first";
    let changes = 0;
    const timers = new Map<number, () => void>();
    const requests: { urls: string[]; resolve: (body: unknown) => void; reject: () => void; }[] = [];
    let timerId = 0;
    const mocks: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { warn() {} } },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": {
            Flux: { Store: class { emitChange() { changes++; } } }, FluxDispatcher: {},
            UserStore: { getCurrentUser: () => user ? { id: user } : undefined },
            Constants: { Endpoints: { ATTACHMENTS_REFRESH_URLS: "refresh" } },
            RestAPI: { post: ({ body }: { body: { attachment_urls: string[]; }; }) => new Promise((resolve, reject) => {
                requests.push({ urls: body.attachment_urls, resolve: value => resolve({ body: value }), reject: () => reject(new Error("Network failure")) });
            }) }
        },
        "./utils": { isAllowedHost: (host: string) => host === "cdn.discordapp.com" }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/stores.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { SignedUrlsStore: store } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, URL, Date,
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => timers.delete(id),
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { store, timers, requests, changes: () => changes,
        account: (value: string) => { user = value; },
        tick: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await settle(); } };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const url = (id: number) => `https://cdn.discordapp.com/attachments/1/${id}`;
const expiry = Math.ceil((Date.now() + 7_200_000) / 1000).toString(16);
const signed = (id: number) => `${url(id)}?ex=${expiry}&hm=signature`;

test("signed URL reads stay pure and refresh requests deduplicate queued and running URLs", async () => {
    const f = fixture();
    f.store.start();
    for (let i = 0; i < 100; i++) assert.equal(f.store.get(url(1)), null);
    assert.equal(f.timers.size, 0);
    for (let i = 0; i < 100; i++) f.store.refresh(url(1));
    await f.tick();
    assert.equal(f.requests.length, 1);
    assert.deepEqual([...f.requests[0].urls], [url(1)]);
    for (let i = 0; i < 100; i++) f.store.refresh(url(1));
    await f.tick();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve({ refreshed_urls: [{ original: url(1), refreshed: signed(1) }] });
    await settle();
    assert.equal(f.store.get(url(1)), signed(1));
    assert.equal(f.changes(), 2);
    f.store.refresh(url(1));
    assert.equal(f.timers.size, 0);
});

test("signed URL batches run sequentially and failures can be retried without a retry loop", async () => {
    const f = fixture();
    f.store.start();
    for (let i = 0; i < 120; i++) f.store.refresh(url(i));
    await f.tick();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].urls.length, 50);
    f.requests[0].reject();
    await settle();
    await f.tick();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].urls.length, 50);
    f.requests[1].resolve({ refreshed_urls: [] });
    await settle();
    await f.tick();
    assert.equal(f.requests[2].urls.length, 20);
    f.requests[2].resolve({ refreshed_urls: [] });
    await settle();
    assert.equal(f.timers.size, 0);
    f.store.refresh(url(0));
    await f.tick();
    assert.deepEqual([...f.requests[3].urls], [url(0)]);
});

test("stop and account changes discard pending requests and late signed URL results", async () => {
    const f = fixture();
    f.store.start();
    f.store.refresh(url(1));
    await f.tick();
    f.store.refresh(url(2));
    f.store.stop();
    assert.equal(f.timers.size, 0);
    f.requests[0].resolve({ refreshed_urls: [{ original: url(1), refreshed: signed(1) }] });
    await settle();
    assert.equal(f.store.get(url(1)), null);
    f.store.start();
    f.store.refresh(url(3));
    await f.tick();
    f.account("second");
    f.requests[1].resolve({ refreshed_urls: [{ original: url(3), refreshed: signed(3) }] });
    await settle();
    assert.equal(f.store.get(url(3)), null);
    f.store.reset();
    f.store.addSigned(signed(4));
    assert.equal(f.store.get(url(4)), signed(4));
    f.account("third");
    assert.equal(f.store.get(url(4)), null);
    f.store.stop();
    f.store.refresh(url(5));
    f.store.addSigned(signed(5));
    assert.equal(f.timers.size, 0);
    assert.equal(f.store.get(url(5)), null);
});

test("signed URL cache bounds retained entries and rejects invalid refresh destinations", () => {
    const f = fixture();
    f.store.start();
    for (let i = 0; i < 1100; i++) f.store.addSigned(signed(i));
    assert.equal(f.store.get(url(0)), null);
    assert.equal(f.store.get(url(1099)), signed(1099));
    for (const invalid of ["http://cdn.discordapp.com/file", "https://cdn.discordapp.com:8443/file", "https://user@cdn.discordapp.com/file", "https://evil.example/file"])
        f.store.refresh(invalid);
    assert.equal(f.timers.size, 0);
});

test("a stopped run cannot clear a restarted request and invalid refresh results are ignored", async () => {
    const f = fixture();
    f.store.start();
    f.store.refresh(url(1));
    await f.tick();
    f.store.stop();
    f.store.start();
    f.store.refresh(url(2));
    await f.tick();
    f.requests[0].resolve({ refreshed_urls: [{ original: url(1), refreshed: signed(1) }] });
    await settle();
    f.store.refresh(url(2));
    await f.tick();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ refreshed_urls: [
        { original: url(2), refreshed: null }, { original: url(2), refreshed: `${url(2)}?ex=1` },
        { original: url(2), refreshed: "https://evil.example/file" }, { original: url(3), refreshed: signed(3) }
    ] });
    await settle();
    assert.equal(f.store.get(url(1)), null);
    assert.equal(f.store.get(url(2)), null);
    assert.equal(f.store.get(url(3)), null);
    f.store.refresh(url(2));
    await f.tick();
    assert.equal(f.requests.length, 3);
});
