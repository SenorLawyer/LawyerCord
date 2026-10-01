/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Asset { id: string; name: string; animated?: boolean; format_type?: number; }
interface ResponseData { ok?: boolean; mime?: string; length?: number; chunks?: Uint8Array[]; }

function fixture(items: Asset[] = [{ id: "1", name: "first", animated: false }, { id: "2", name: "second", animated: true }]) {
    const source = readFileSync(process.env.AUDIT_GUILD_EXPORT_SOURCE ?? "src/equicordplugins/guildPickerDumper/index.tsx", "utf8");
    const { outputText } = transpileModule(`${source}\nexport { zipGuildAssets };`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const requests: { url: string; signal?: AbortSignal; redirect?: string; }[] = [];
    const saved: File[] = [];
    const archives: { name: string; files: Record<string, Uint8Array>; signal: AbortSignal; }[] = [];
    const timers = new Map<number, () => void>();
    const toasts: unknown[] = [];
    let pending: (() => Promise<ResponseData>) | undefined;
    let pendingZip: (() => Promise<File>) | undefined;
    let responses: ResponseData[] = [];
    let active = 0;
    let peak = 0;
    let synchronousCalls = 0;
    let cancellations = 0;
    let releases = 0;
    const React = { createElement: () => null };
    const mocks: Record<string, unknown> = {
        "@api/ContextMenu": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/Logger": { Logger: class { warn() {} } },
        "@utils/types": { __esModule: true, default: (p: unknown) => p }, "@vencord/discord-types/enums": { StickerFormatType: { APNG: 2 } },
        "@utils/web": { saveFile: (file: File) => saved.push(file) },
        "@utils/zip": { createZipFile: (name: string, files: Record<string, Uint8Array>, signal: AbortSignal) => { archives.push({ name, files, signal }); return pendingZip ? pendingZip() : Promise.resolve(new File([], name)); } },
        "fflate": { zipSync: () => { synchronousCalls++; return new Uint8Array(); } },
        "@webpack/common": { React, Menu: {}, EmojiStore: { getGuildEmoji: () => items, getGuilds: () => ({ guild: { emojis: items } }) },
            StickersStore: { getStickersByGuildId: () => items }, IconUtils: { getEmojiURL: ({ id, animated }: Asset) => `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}` },
            showToast: (value: unknown) => toasts.push(value), Toasts: { Type: {} } }
    };
    const api: { default: { start?(): void; stop?(): void; flux?: { CONNECTION_OPEN(): void; }; }; zipGuildAssets(guild: { id: string; name: string; }, type: string): Promise<void>; } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React, AbortController, File, Blob, Uint8Array, Error,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        window: { GLOBAL_ENV: { MEDIA_PROXY_ENDPOINT: "//media.discordapp.net" } },
        URL: class extends URL { static createObjectURL() { return "blob:test"; } static revokeObjectURL() {} },
        document: { createElement: () => ({ click: () => saved.push(new File([], "legacy.zip")), remove() {} }) },
        setTimeout: (cb: () => void, delay: number) => { const id = timers.size + 1; timers.set(id, cb); assert.ok(delay === 0 || delay === 120_000); return id; }, clearTimeout: (id: number) => timers.delete(id),
        fetch: async (url: string, options?: { signal?: AbortSignal; redirect?: string; }) => {
            requests.push({ url, ...options }); active++; peak = Math.max(peak, active);
            try {
                const data = pending ? await pending() : responses.shift() ?? {};
                const chunks = data.chunks ?? [new Uint8Array([1, 2, 3])];
                let index = 0;
                return { ok: data.ok ?? true,
                    headers: { get: (key: string) => key === "content-type" ? data.mime ?? "image/png" : data.length === undefined ? null : String(data.length) },
                    body: { cancel: async () => { cancellations++; }, getReader: () => ({ read: async () => ({ done: index >= chunks.length, value: chunks[index++] }), cancel: async () => { cancellations++; }, releaseLock: () => { releases++; } }) },
                    blob: async () => new Blob([new Uint8Array([1, 2, 3])]) };
            } finally { active--; }
        }, console: { error() {} }
    });
    api.default.start?.();
    return { api, requests, saved, archives, timers, toasts, peak: () => peak, sync: () => synchronousCalls, cleanup: () => ({ cancellations, releases }),
        run: (type = "emojis") => api.zipGuildAssets({ id: "guild", name: "Server" }, type),
        responses(values: ResponseData[]) { responses = values; },
        deferFetch(value: () => Promise<ResponseData>) { pending = value; },
        deferZip(value: () => Promise<File>) { pendingZip = value; }
    };
}

test("server exports download sequentially and use the shared cancellable ZIP implementation", async () => {
    const f = fixture(); let finish: (value: ResponseData) => void = () => {};
    f.deferFetch(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.run(); assert.equal(f.requests.length, 1);
    f.deferFetch(() => Promise.resolve({})); finish({}); await pending; await setImmediate();
    assert.equal(f.peak(), 1); assert.equal(f.sync(), 0); assert.equal(f.archives.length, 1);
    assert.deepEqual(Object.keys(f.archives[0].files), ["first_1.png", "second_2.gif"]);
    assert.deepEqual(Array.from(f.archives[0].files["first_1.png"]), [1, 2, 3]);
    assert.equal(f.saved[0].name, "Server-emojis.zip");
    assert.ok(f.requests.every(request => request.signal && request.redirect === "error"));
    assert.equal(f.cleanup().releases, 2); assert.equal(f.timers.size, 0); f.api.default.stop?.();
});

test("server export deadlines report failure and discard late results", async () => {
    const f = fixture(); let finish: (value: ResponseData) => void = () => {};
    f.deferFetch(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.run(); assert.equal(f.timers.size, 1);
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.requests[0].signal?.aborted, true); assert.equal(f.timers.size, 0);
    finish({}); await pending; assert.equal(f.saved.length, 0); assert.equal(f.archives.length, 0);
    assert.deepEqual(f.toasts, ["Server asset export timed out."]); f.api.default.stop?.();
});

test("stopped or reconnected exports discard late downloads and release their deadline", async () => {
    for (const reconnect of [false, true]) {
        const f = fixture(); let finish: (value: ResponseData) => void = () => {};
        f.deferFetch(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.run();
        if (reconnect) f.api.default.flux?.CONNECTION_OPEN(); else f.api.default.stop?.();
        assert.equal(f.requests[0].signal?.aborted, true); assert.equal(f.timers.size, 0);
        finish({}); await pending; await setImmediate();
        assert.equal(f.saved.length, 0); assert.equal(f.archives.length, 0); assert.equal(f.requests.length, 1);
        assert.equal(f.toasts.length, 0); assert.equal(f.cleanup().releases, 1); f.api.default.stop?.();
    }
});

test("server exports suppress cancelled compression and prevent overlapping downloads", async () => {
    const f = fixture(); let finish: (file: File) => void = () => {};
    f.deferZip(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.run(); await setImmediate();
    await f.run(); assert.equal(f.requests.length, 2); assert.equal(f.archives.length, 1);
    f.api.default.stop?.(); assert.equal(f.archives[0].signal.aborted, true);
    finish(new File([], "cancelled.zip")); await pending; assert.equal(f.saved.length, 0); assert.equal(f.timers.size, 0);
    await f.run(); assert.equal(f.requests.length, 2);
});

test("APNG fallback preserves GIF extensions and cancels the rejected response", async () => {
    const f = fixture([{ id: "sticker", name: "bad/name", format_type: 2 }]);
    f.responses([{ ok: false, mime: "text/html" }, { mime: "image/gif" }]);
    await f.run("stickers"); await setImmediate();
    assert.match(f.requests[0].url, /sticker\.png/); assert.match(f.requests[1].url, /sticker\.gif/);
    assert.deepEqual(Object.keys(f.archives[0].files), ["bad_name_sticker.gif"]);
    assert.equal(f.cleanup().cancellations, 2); f.api.default.stop?.();
});

test("failed HTTP responses do not enter the archive", async () => {
    const f = fixture(); f.responses([{ ok: false }]); await f.run(); await setImmediate();
    assert.equal(f.archives.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.toasts.length, 1);
    assert.equal(f.cleanup().cancellations, 1); assert.equal(f.timers.size, 0); f.api.default.stop?.();
});

test("server exports enforce cumulative declared and streamed byte limits", async () => {
    const limit = 100 * 1024 * 1024;
    class OversizedChunk extends Uint8Array { get byteLength() { return limit + 1; } }
    for (const responses of [[{ length: limit + 1 }], [{}, { length: limit }], [{ chunks: [new OversizedChunk(1)] }]]) {
        const f = fixture(); f.responses(responses); await f.run(); await setImmediate();
        assert.equal(f.archives.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.toasts.length, 1);
        assert.match(String(f.toasts[0]), /100 MiB/); assert.equal(f.timers.size, 0);
        assert.ok(f.cleanup().cancellations > 0); f.api.default.stop?.();
    }
});
