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

function fixture(web = true) {
    let account = "first";
    let enabled = true;
    let mutations = 0;
    const downloads: { signal?: AbortSignal; resolve: (response: unknown) => void; }[] = [];
    const uploads: { files: File[]; resolve: () => void; reject: () => void; }[] = [];
    const sent: { channel: string; options: { attachmentsToUpload: { item: { file: File; }; filename?: string; description?: string; }[]; }; }[] = [];
    const toasts: unknown[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const existing = { item: { file: new File(["draft"], "existing") } };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isPluginEnabled: () => enabled },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/discord": { sendMessage: (channel: string, _data: unknown, _ready: boolean, options: typeof sent[number]["options"]) => {
            sent.push({ channel, options }); return Promise.resolve();
        } },
        "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() },
        "@utils/react": {}, "@utils/Queue": { Queue: class {} },
        "@webpack": { findByCodeLazy: () => ({}), findByPropsLazy: () => ({}) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => account ? { id: account } : undefined },
            DraftType: { ChannelMessage: 0 },
            UploadHandler: { promptToUpload: (files: File[]) => new Promise<void>((resolve, reject) => uploads.push({ files, resolve, reject: () => reject(new Error("Upload failure")) })) },
            UploadAttachmentStore: { getUploads: () => [existing, { item: { file: uploads.at(-1)?.files[0] } }] },
            UploadManager: { setUploads: ({ uploads }: { uploads: unknown[]; }) => { mutations++; assert.deepEqual([...uploads], [existing]); } },
            PendingReplyStore: { getPendingReply: () => "reply" },
            MessageActions: { getSendMessageOptionsForReply: () => ({ reply: true }) },
            FluxDispatcher: { dispatch: () => { mutations++; } },
            Toasts: { Type: { FAILURE: 1 }, genId: () => "toast", show: (toast: unknown) => { toasts.push(toast); } }
        },
        "fflate": {}, "./polyfills": {}, "./types": { FavouriteItemFormat: { NONE: 0 }, CustomItemFormat: { ATTACHMENT: 0 } }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/utils.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, URL, File, TextEncoder, AbortController, IS_WEB: web,
        VencordNative: { pluginHelpers: { FavouriteAnything: { fetchAttachment: () => new Promise(resolve => downloads.push({ resolve })) } } },
        window: { GLOBAL_ENV: { CDN_HOST: "cdn.discordapp.com", MEDIA_PROXY_ENDPOINT: "media.discordapp.net", IMAGE_PROXY_ENDPOINTS: "images-ext-1.discordapp.net" } },
        fetch: (_url: URL, options: { signal?: AbortSignal; }) => new Promise(resolve => downloads.push({ signal: options.signal, resolve })),
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const attachment = { filename: "file.txt", url: "https://cdn.discordapp.com/attachments/1/file", title: "", description: "description", content_type: "text/plain" };
    return { api, downloads, uploads, sent, toasts, timers, attachment, mutations: () => mutations,
        account: (value: string) => { account = value; }, enable: (value: boolean) => { enabled = value; },
        send: (overrides = {}) => api.sendAttachment({ ...attachment, ...overrides }, { id: "channel" }) };
}

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function response(parts: Uint8Array<ArrayBuffer>[] = [new TextEncoder().encode("content")], declaredSize?: number) {
    let index = 0;
    let cancelled = 0;
    let released = 0;
    const value = {
        ok: true, headers: new Headers(declaredSize === undefined ? {} : { "content-length": String(declaredSize) }),
        body: { cancel: async () => { cancelled++; }, getReader: () => ({
            read: async () => index < parts.length ? { done: false, value: parts[index++] } : { done: true },
            cancel: async () => { cancelled++; }, releaseLock: () => { released++; }
        }) },
        blob: async () => new Blob(parts)
    };
    return { value, cancelled: () => cancelled, released: () => released };
}

test("favorite sends preserve other drafts and attachment metadata and release download resources", async () => {
    const f = fixture();
    const send = f.send();
    const res = response();
    f.downloads[0].resolve(res.value);
    await settle();
    assert.equal(f.uploads.length, 1);
    assert.equal(await f.uploads[0].files[0].text(), "content");
    assert.equal(f.uploads[0].files[0].type, "text/plain");
    assert.equal(res.cancelled(), 1);
    assert.equal(res.released(), 1);
    assert.equal(f.timers.size, 0);
    f.uploads[0].resolve();
    assert.equal(await send, true);
    assert.equal(f.sent[0].channel, "channel");
    assert.equal(f.sent[0].options.attachmentsToUpload[0].filename, "");
    assert.equal(f.sent[0].options.attachmentsToUpload[0].description, "description");
    assert.equal(f.mutations(), 2);
    assert.equal(f.toasts.length, 0);
});

test("account changes and plugin stop prevent pending downloads and uploads from sending", async () => {
    for (const web of [true, false]) {
        const f = fixture(web);
        const send = f.send();
        f.account("second");
        f.downloads[0].resolve(web ? response().value : { success: true, data: new Uint8Array([1]), filename: "file", type: "text/plain" });
        await settle();
        assert.equal(f.uploads.length, 0);
        await send;
        assert.equal(f.sent.length, 0);
        assert.equal(f.toasts.length, 0);
        assert.equal(f.timers.size, 0);
    }
    const f = fixture();
    const send = f.send();
    f.downloads[0].resolve(response().value);
    await settle();
    f.account("second");
    f.uploads[0].resolve();
    await settle();
    assert.equal(f.sent.length, 0);
    await send;
    assert.equal(f.mutations(), 0);

    const stopped = fixture();
    const pending = stopped.send();
    stopped.api.cancelAttachmentSends();
    assert.equal(stopped.downloads[0].signal?.aborted, true);
    stopped.enable(false);
    stopped.downloads[0].resolve(response().value);
    await pending;
    assert.equal(stopped.uploads.length, 0);
    assert.equal(stopped.toasts.length, 0);
});

test("browser downloads reject oversized declared and streamed data and invalid destinations", async () => {
    for (const streamed of [false, true]) {
        const f = fixture();
        const send = f.send();
        const res = response();
        if (streamed) {
            const chunk = new Uint8Array(1);
            Object.defineProperty(chunk, "byteLength", { value: 500 * 1024 * 1024 + 1 });
            res.value.body.getReader = () => ({
                read: async () => ({ done: false, value: chunk }),
                cancel: async () => { await res.value.body.cancel(); }, releaseLock: () => {}
            });
        }
        else res.value.headers.set("content-length", String(500 * 1024 * 1024 + 1));
        f.downloads[0].resolve(res.value);
        await settle();
        assert.equal(f.uploads.length, 0);
        await send;
        assert.equal(f.toasts.length, 1);
        assert.equal(res.cancelled(), 1);
        assert.equal(f.timers.size, 0);
    }
    for (const url of ["http://cdn.discordapp.com/file", "https://cdn.discordapp.com:8443/file", "https://user@cdn.discordapp.com/file", "https://evil.example/file"]) {
        const f = fixture();
        await f.send({ url });
        assert.equal(f.downloads.length, 0);
        assert.equal(f.toasts.length, 1);
    }
});

test("download timeouts and failed uploads leave drafts untouched", async () => {
    const f = fixture();
    const send = f.send();
    for (const timeout of f.timers.values()) timeout();
    assert.equal(f.downloads[0].signal?.aborted, true);
    f.downloads[0].resolve(response().value);
    await send;
    assert.equal(f.uploads.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.toasts.length, 0);
    const failed = fixture();
    const upload = failed.send();
    failed.downloads[0].resolve(response().value);
    await settle();
    failed.uploads[0].reject();
    await upload;
    assert.equal(failed.mutations(), 0);
    assert.equal(failed.sent.length, 0);
    assert.equal(failed.toasts.length, 1);
});
