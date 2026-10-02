/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Secure attachment failures retain only bounded recent message entries", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const modules: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) } },
        "./messageMetadata": { discordEditedTimestamp: () => 0 },
        "./protocol": { isEncryptedMessage: () => true }
    };
    const api = runInNewContext(`${source};({ ...exports, retained: () => cache.size })`, {
        exports: {}, URL, require: (name: string) => modules[name],
        VencordNative: { pluginHelpers: { SecureMessaging: {
            decryptIncomingAttachments: async () => ({ status: "invalid_message" })
        } } }
    });
    const retryMessage = { id: "retry", channel_id: "channel", content: "encrypted", author: { id: "peer" }, attachments: [{ id: "file", size: 1, url: "url", proxy_url: "proxy" }] };
    api.encryptedAttachmentStatus(retryMessage);
    await new Promise<void>(resolve => setImmediate(resolve));
    api.retryEncryptedAttachments(retryMessage);
    assert.equal(api.encryptedAttachmentStatus(retryMessage).status, "loading");
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let i = 0; i < 500; i++) {
        const message = { id: String(i), channel_id: "channel", content: "encrypted", author: { id: "peer" }, attachments: [{ id: "file", size: 1, url: "url", proxy_url: "proxy" }] };
        api.encryptedAttachmentStatus(message);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(api.encryptedAttachmentStatus(message).status, "failed");
    }
    assert.ok(api.retained() <= 128, `Retained ${api.retained()} failed messages`);
    api.clearEncryptedAttachmentCache();
    assert.equal(api.retained(), 0);
});

test("Secure attachment results from the previous account are wiped without creating object URLs", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    let userId = "first";
    const pending = Promise.withResolvers<unknown>();
    const bytes = new Uint8Array([42]);
    const modules: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./messageMetadata": { discordEditedTimestamp: () => 0 }, "./protocol": { isEncryptedMessage: () => true }
    };
    const api = runInNewContext(`${source};({ ...exports, retained: () => cache.size })`, {
        exports: {}, URL: { createObjectURL: () => assert.fail("Stale account plaintext must not be displayed.") },
        require: (name: string) => modules[name],
        VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncomingAttachments: () => pending.promise } } }
    });
    api.encryptedAttachmentStatus({ id: "message", channel_id: "channel", content: "encrypted", author: { id: "peer" }, attachments: [{ id: "file" }] });
    userId = "second";
    pending.resolve({ status: "decrypted", attachments: [{ data: bytes }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(bytes[0], 0);
    assert.equal(api.retained(), 0);
});

test("Secure account lifecycle revokes ready URLs and rejects previous A to B to A requests", async () => {
    const compile = (path: string) => transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    let userId = "A";
    let embedClears = 0;
    let created = 0;
    const revoked: string[] = [];
    const requests: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
    const modules: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./messageMetadata": { discordEditedTimestamp: () => 0 }, "./protocol": { isEncryptedMessage: () => true },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/constants": { EquicordDevs: {} }, "./keyReviewGate": { KeyReviewGate: class {} },
        "./embedCache": { clearEncryptedEmbedCache: () => embedClears++ }
    };
    const globals = {
        Blob, Uint8Array,
        URL: { createObjectURL: () => `blob:${++created}`, revokeObjectURL: (url: string) => revoked.push(url) },
        require: (name: string) => modules[name] ?? {},
        VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncomingAttachments: () => {
            const request = Promise.withResolvers<unknown>();
            requests.push(request);
            return request.promise;
        } } } }
    };
    const cache = runInNewContext(`${compile("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts")};({ ...exports, retained: () => cache.size })`, { ...globals, exports: {} });
    modules["./attachmentCache"] = cache;
    const plugin = runInNewContext(`${compile("src/equicordplugins/secureMessaging.desktop/index.tsx")};exports.default`, { ...globals, exports: {} });
    const message = { id: "message", channel_id: "channel", content: "encrypted", author: { id: "peer" }, attachments: [{ id: "file" }] };
    const result = (data: Uint8Array) => ({ status: "decrypted", attachments: [{ id: "file", data, metadata: { name: "file", mimeType: "text/plain", size: 1 } }] });
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    cache.encryptedAttachmentStatus(message);
    requests[0].resolve(result(new Uint8Array([1])));
    await settle();
    assert.equal(cache.encryptedAttachmentStatus(message).status, "ready");
    plugin.flux.LOGOUT();
    assert.deepEqual(revoked, ["blob:1"]);
    assert.equal(cache.retained(), 0);
    cache.encryptedAttachmentStatus(message);
    userId = "B";
    plugin.flux.CONNECTION_OPEN();
    userId = "A";
    plugin.flux.CONNECTION_OPEN();
    cache.encryptedAttachmentStatus(message);
    const stale = new Uint8Array([42]);
    requests[1].resolve(result(stale));
    await settle();
    assert.equal(stale[0], 0);
    assert.equal(created, 1);
    assert.equal(cache.encryptedAttachmentStatus(message).status, "loading");
    assert.equal(cache.retained(), 1);
    requests[2].resolve(result(new Uint8Array([3])));
    await settle();
    assert.equal(cache.encryptedAttachmentStatus(message).status, "ready");
    plugin.flux.CONNECTION_OPEN();
    assert.deepEqual(revoked, ["blob:1", "blob:2"]);
    assert.equal(embedClears, 4);
    assert.equal(cache.retained(), 0);
});
