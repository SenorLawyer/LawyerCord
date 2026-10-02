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
    const store = { serviceType: "catbox", fallbackEnabled: true, fallbackOrder: "", autoSend: true, autoCopy: false };
    const inserted: string[] = [];
    const buffers: ArrayBuffer[] = [];
    const timers: (() => void)[] = [];
    let channel = "original";
    let user = "account";
    let resolveUpload: (result: object) => void = () => {};
    const natives = {
        uploadToCatbox: async (data: ArrayBuffer) => { buffers.push(data); return { success: false, error: "First service failed" }; },
        uploadToTempSh: async (data: ArrayBuffer) => { buffers.push(data); return { success: true, url: "https://example.com/file" }; },
        cancelUploads: async () => {},
        uploadToNest: () => new Promise(resolve => resolveUpload = resolve)
    };
    const types = transpileModule(readFileSync("src/equicordplugins/fileUpload/types.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const typeApi = runInNewContext(types + "\nexports;", { exports: {} });
    const modules: Record<string, unknown> = {
        "@equicordplugins/fileUpload/constants": { normalizeCorsProxyUrl: () => "none", toProxiedUrl: (url: string) => url },
        "@equicordplugins/fileUpload/settings": { settings: { store } }, "@equicordplugins/fileUpload/types": typeApi,
        "@utils/clipboard": {}, "@utils/discord": { insertTextIntoChatInputBox: (text: string) => inserted.push(text) },
        "@utils/Logger": { Logger: class { warn() {} error() {} } }, "@utils/web": {},
        "@webpack/common": { showToast() {}, Toasts: { Type: {} }, SelectedChannelStore: { getChannelId: () => channel }, UserStore: { getCurrentUser: () => ({ id: user }) } },
        "./apngToGif": {}, "./getMediaUrl": { getExtensionFromBytes: async () => "png", getMimeFromExtension: () => "image/png" }, "./s3": { isS3Configured: () => false }, "./sharex": {}
    };
    const requestSource = transpileModule(readFileSync("src/equicordplugins/fileUpload/request.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    modules["../request"] = runInNewContext(requestSource + "\nexports;", { exports: {}, URL, Blob, Uint8Array });
    const source = readFileSync(process.env.AUDIT_UPLOAD_SOURCE ?? "src/equicordplugins/fileUpload/utils/upload.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const api = runInNewContext(outputText + "\n({ ...exports, uploadToCatbox, uploadToTempSh, notifyUploadSuccess, beginUpload });", {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, IS_DISCORD_DESKTOP: true,
        VencordNative: { pluginHelpers: { FileUpload: natives } }, Blob, File, URL, Headers, FormData, AbortController,
        setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {}
    }) as { beginUpload(): void; cancelCurrentUpload(): void; uploadToCatbox(blob: Blob, filename: string): Promise<string>; uploadToTempSh(blob: Blob, filename: string): Promise<string>; uploadProvidedFiles(files: File[], forceSend?: boolean): Promise<boolean>; notifyUploadSuccess(url: string, force?: boolean): Promise<void>; getUploadState(): { phase: string; }; };
    return { api, store, natives, buffers, inserted, timers, channel: (value: string) => channel = value, user: (value: string) => user = value, finish: () => resolveUpload({ success: true, url: "https://example.com/file" }) };
}

test("Native fallback uploads reuse one full file read", async () => {
    const f = fixture();
    f.api.beginUpload();
    let reads = 0;
    const blob = new Blob(["data"]);
    const read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = () => { reads++; return read(); };
    await assert.rejects(f.api.uploadToCatbox(blob, "a.png"));
    await f.api.uploadToTempSh(blob, "a.png");
    assert.equal(reads, 1);
    assert.equal(f.buffers[0], f.buffers[1]);
});

test("Completing an upload after switching channels does not insert into the new composer", async () => {
    const f = fixture();
    Object.assign(f.store, { serviceType: "nest", nestToken: "token" });
    const pending = f.api.uploadProvidedFiles([new File(["data"], "a.png")]);
    await new Promise(resolve => setImmediate(resolve));
    f.channel("other"); f.finish();
    assert.equal(await pending, true);
    assert.deepEqual(f.inserted, []);
});

test("Cancelling or switching accounts during a file read cannot start a native upload", async () => {
    for (const cancel of [true, false]) {
        const f = fixture();
        f.api.beginUpload();
        let finish: (buffer: ArrayBuffer) => void = () => {};
        const blob = new Blob(["data"]);
        blob.arrayBuffer = () => new Promise(resolve => finish = resolve);
        const pending = f.api.uploadToTempSh(blob, "a.png");
        if (cancel) f.api.cancelCurrentUpload();
        else f.user("replacement");
        finish(new ArrayBuffer(4));
        await assert.rejects(pending, /cancelled/);
        assert.equal(f.buffers.length, 0);
    }
});
