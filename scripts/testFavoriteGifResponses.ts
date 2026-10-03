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
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture(fetch: (url: string, options?: RequestInit) => Promise<Response>, gifUrls: string[] = []) {
    const notifications: unknown[] = [];
    const source = transpileModule(readFileSync("src/equicordplugins/saveFavoriteGIFs/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { warn() {} error() {} } },
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/constants": { Devs: {} },
        "@api/Commands": { ApplicationCommandInputType: {} },
        "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
        "@webpack/common": { UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { getCurrentValue: () => ({ favoriteGifs: { gifs: Object.fromEntries(gifUrls.map(url => [url, {}])) } }) } } }
    };
    const api = runInNewContext(`${source};({filterReachableGifs,isGifReachable,saveWorkingGifs,plugin:exports.default})`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, fetch, AbortController, AbortSignal: {}
    }) as { filterReachableGifs(urls: string[], signal?: AbortSignal): Promise<string[]>; isGifReachable(url: string, signal?: AbortSignal): Promise<boolean>; saveWorkingGifs(): Promise<void>; plugin: { stop(): void }; };
    return { ...api, notifications };
}

test("GIF fallback and worker admission await response body cancellation", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let pendingBodies = 0;
    let peak = 0;
    const api = fixture(async (url, options) => {
        calls.push(`${options?.method ?? "GET"}:${url}`);
        pendingBodies++;
        peak = Math.max(peak, pendingBodies);
        return new Response(new ReadableStream({ cancel: () => new Promise<void>(resolve => releases.push(() => { pendingBodies--; resolve(); })) }), { status: options?.method === "HEAD" ? 405 : 200 });
    });
    const urls = Array.from({ length: 17 }, (_, index) => String(index));
    let settled = false;
    const work = api.filterReachableGifs(urls).then(result => { settled = true; return result; });
    await setImmediate();
    assert.equal(calls.length, 8);
    assert.equal(releases.length, 8);
    assert.equal(settled, false);
    for (let step = 0; step < 10 && !settled; step++) {
        releases.splice(0).reverse().forEach(release => release());
        await setImmediate();
    }
    assert.deepEqual(Array.from(await work), urls);
    assert.equal(pendingBodies, 0);
    assert.equal(peak, 8);
    assert.equal(calls.length, 34);
});

test("GIF reachability preserves fallback and status when body cancellation rejects", async () => {
    const calls: string[] = [];
    let cancellations = 0;
    const api = fixture(async (url, options) => {
        const method = options?.method ?? "GET";
        calls.push(`${method}:${url}`);
        if (url === "network" && method === "HEAD") throw Error("Network failure");
        return new Response(new ReadableStream({ cancel() { cancellations++; return Promise.reject(Error("Stream failed during cancellation")); } }), {
            status: url === "head" || method === "GET" && url !== "missing" ? 200 : 404
        });
    });
    assert.deepEqual(Array.from(await api.filterReachableGifs(["head", "network", "missing"])), ["head", "network"]);
    assert.equal(cancellations, 4);
    assert.equal(calls.filter(call => call === "GET:head").length, 0);
});

test("Cancelled GIF check finishes body cleanup without fallback or further URLs", async () => {
    const controller = new AbortController();
    let release = () => {};
    let calls = 0;
    const api = fixture(async () => {
        calls++;
        return new Response(new ReadableStream({ cancel: () => new Promise<void>(resolve => { release = resolve; }) }), { status: 405 });
    });
    const work = api.isGifReachable("one", controller.signal);
    await setImmediate();
    controller.abort();
    release();
    assert.equal(await work, false);
    assert.equal(calls, 1);
    assert.deepEqual(Array.from(await api.filterReachableGifs(["later"], controller.signal)), []);
    assert.equal(calls, 1);
});


test("Stopping GIF export aborts active checks and suppresses fallback, queued URLs and export", async () => {
    let active = 0;
    let requests = 0;
    const api = fixture((_url, options) => {
        requests++;
        active++;
        return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
                active--;
                reject(new Error("Cancelled"));
            }, { once: true });
        });
    }, Array.from({ length: 17 }, (_, index) => String(index)));
    const work = api.saveWorkingGifs();
    await setImmediate();
    assert.equal(active, 8);
    api.plugin.stop();
    await work;
    assert.equal(active, 0);
    assert.equal(requests, 8);
    assert.equal(api.notifications.length, 1);
});
