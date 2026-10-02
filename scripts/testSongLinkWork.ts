/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

import { readResponseText } from "../src/shared/readResponseText";

function fixture() {
    const pending: Array<{ resolve(value: Response): void; signal?: AbortSignal }> = [];
    const timers = new Map<number, () => void>();
    let id = 0;
    const code = transformSync(readFileSync("src/equicordplugins/songLink.desktop/native.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const api = runInNewContext(`${code};module.exports`, {
        module: { exports: {} }, URL, AbortController,
        require: (name: string) => name === "@shared/readResponseText" ? { readResponseText } : { RendererSettings: { store: { plugins: { SongLink: { userCountry: "US" } } } } },
        fetch: (_url: string, options?: RequestInit) => new Promise<Response>(resolve => pending.push({ resolve, signal: options?.signal ?? undefined })),
        setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; }, clearTimeout: (key: number) => timers.delete(key)
    });
    const request = (id: string): Promise<unknown> => api.getTrackData({}, `https://open.spotify.com/track/${id}`);
    return { pending, timers, request };
}

const body = { entitiesByUniqueId: { SPOTIFY: { title: "Track", artistName: "Artist" } }, linksByPlatform: { spotify: { url: "https://open.spotify.com/track/test", nativeAppUriDesktop: "spotify:track:test" } } };
const response = () => new Response(JSON.stringify(body));

test("SongLink deduplicates pending lookups and bounds distinct native requests", async () => {
    const f = fixture();
    const same = Array.from({ length: 100 }, () => f.request("same"));
    assert.equal(f.pending.length, 1);
    const other = Array.from({ length: 100 }, (_, index) => f.request(String(index)).catch(() => null));
    assert.ok(f.pending.length <= 8);
    for (const request of f.pending) request.resolve(response());
    await Promise.all([...same, ...other]);
    assert.equal(f.timers.size, 0);
    const next = f.request("next");
    f.pending.at(-1)?.resolve(response());
    const result = await next;
    assert.equal(JSON.stringify(result), JSON.stringify({ info: { title: "Track", artist: "Artist" }, links: { spotify: { url: body.linksByPlatform.spotify.url, nativeUri: "spotify:track:test" } } }));
});

test("SongLink deadlines abort requests and retain capacity until native work settles", async () => {
    const f = fixture();
    const tasks = Array.from({ length: 8 }, (_, index) => f.request(String(index)).catch(() => null));
    assert.equal(f.timers.size, 8);
    for (const callback of [...f.timers.values()]) callback();
    assert.ok(f.pending.every(request => request.signal?.aborted));
    await assert.rejects(f.request("overflow"));
    assert.equal(f.pending.length, 8);
    for (const request of f.pending) request.resolve(response());
    assert.deepEqual(await Promise.all(tasks), Array(8).fill(null));
    assert.equal(f.timers.size, 0);
});

test("SongLink rejects oversized bodies and cancels unsuccessful responses", async () => {
    const f = fixture();
    let cancelled = 0;
    const failed = f.request("failure");
    f.pending[0].resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }));
    await assert.rejects(failed);
    assert.equal(cancelled, 1);
    const oversized = f.request("oversized");
    f.pending[1].resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled++; } })));
    await assert.rejects(oversized);
    assert.equal(cancelled, 2);
    assert.equal(f.timers.size, 0);
});

test("SongLink accessory offers retry after a bounded lookup fails", async () => {
    const values: unknown[] = [];
    let cursor = 0;
    let effect: (() => void) | undefined;
    let calls = 0;
    const modules: Record<string, unknown> = {
        ".": { __esModule: true, default: { getFromCache() {}, addToCache() {} }, Native: { getTrackData: async () => { if (++calls === 1) throw "Busy"; return { links: {} }; } }, settings: { store: { servicesSettings: {} } } },
        "./Providers": { Providers: {} }, "@components/BaseText": { BaseText: "text" }, "@components/Card": { Card: "card" }, "@components/Icons": {},
        "@utils/Logger": { Logger: class { warn() {} } },
        "@webpack/common": { Button: "button", useState: (initial: unknown) => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }]; }, useEffect: (callback: () => void) => { effect = callback; } }
    };
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const code = transformSync(readFileSync("src/equicordplugins/songLink.desktop/SongLinker.tsx", "utf8"), { loader: "tsx", format: "cjs" }).code;
    const component = runInNewContext(`${code};module.exports.default`, { module: { exports: {} }, require: (name: string) => modules[name], React, console: { error() {} } });
    const render = () => { cursor = 0; return component({ url: "https://open.spotify.com/track/test" }); };
    render(); effect?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const failed = render();
    assert.ok(JSON.stringify(failed).includes("Retry"));
    const visit = (node: { type?: string; props?: { children?: unknown[]; onClick?: () => void } }): void => {
        if (node.type === "button") node.props?.onClick?.();
        for (const child of node.props?.children ?? []) if (typeof child === "object" && child !== null) visit(child);
    };
    visit(failed); render(); effect?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(render()).includes("Retry"));
});
