/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";

async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

test("Secure Messaging bounds queued native operations and releases admission after physical settlement", async () => {
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/native.ts", "utf8");
    const state = source.slice(source.indexOf("let operationQueue:"), source.indexOf("class VaultOperationError"));
    const operation = source.slice(source.indexOf("async function runSerialized"), source.indexOf("async function loadAccount"));
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const context = { run: null as null | ((operation: () => Promise<string>) => Promise<string | { status: string; error: string; }>),
        validateStorageAvailability() {}, acquireVaultLock: async () => { await gate; return async () => {}; },
        synchronizeCachedVault: async () => {}, synchronizeQuarantineJournal: async () => {}, persistVolatileQuarantines: async () => {},
        mapOperationFailure: () => ({ status: "failed", error: "storage_error" }) };
    runInNewContext(transpileModule(`${state}\n${operation}\nglobalThis.run = runSerialized;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
    const { run } = context;
    assert.ok(run);
    let busy = 0;
    const requests = Array.from({ length: 512 }, () => run(async () => "done").then(result => { if (typeof result !== "string" && result.error === "busy") busy++; return result; }));
    await flush();
    assert.equal(busy, 256);
    release();
    const results = await Promise.all(requests);
    assert.equal(results.filter(result => result === "done").length, 256);
    assert.equal(await run(async () => "retry"), "retry");
});

function embedHarness() {
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/embedCache.ts", "utf8");
    const pending: Array<(result: object) => void> = [];
    const requests: Array<(result: object) => void> = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const modules: Record<string, unknown> = {
        "@webpack": { findByCodeLazy: () => (_channel: string, _message: string, embed: object) => embed },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "local" }) }, Constants: { Endpoints: { UNFURL_EMBED_URLS: "/unfurl" } },
            RestAPI: { post: () => new Promise(resolve => requests.push(resolve)) } },
        "./embedUrls": { extractSecureEmbedUrls: (value: string) => value ? [value] : [] },
        "./messageMetadata": { discordEditedTimestamp: () => null }, "./protocol": { isEncryptedMessage: () => true }
    };
    const exports: Record<string, (...args: unknown[]) => unknown> = {};
    const { outputText } = transpileModule(source, { compilerOptions: { module: 1, target: ScriptTarget.ES2022 } });
    runInNewContext(outputText, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncoming: () => new Promise(resolve => pending.push(resolve)) } } },
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id) });
    return { exports, pending, requests, timers };
}

function message(id: number) {
    return { channel_id: "channel", id: String(id), author: { id: "sender" }, content: "encrypted" };
}

test("Secure Messaging bounds pending embed decryption across cache clears and allows retry", async () => {
    const { exports: cache, pending } = embedHarness();
    for (let index = 0; index < 200; index++) cache.patchEncryptedMessageEmbeds(message(index), () => {});
    assert.equal(pending.length, 32);
    cache.clearEncryptedEmbedCache();
    cache.patchEncryptedMessageEmbeds(message(201), () => {});
    assert.equal(pending.length, 32);
    for (const resolve of pending) resolve({ status: "decrypted", plaintext: "" });
    await flush();
    cache.patchEncryptedMessageEmbeds(message(201), () => {});
    assert.equal(pending.length, 33);
});

test("Secure Messaging clears unfurl retry timers without starting another request", async () => {
    const { exports: cache, requests, timers } = embedHarness();
    const prefetch = cache.prefetchEncryptedMessageEmbeds("https://example.com/a");
    assert.equal(requests.length, 1);
    requests[0]({ body: { embeds: [] } });
    await flush();
    assert.equal(timers.size, 1);
    cache.clearEncryptedEmbedCache();
    assert.equal(timers.size, 0);
    await prefetch;
    assert.equal(requests.length, 1);
});

test("Secure Messaging retains unfurl admission across invalidation until requests settle", async () => {
    const { exports: cache, requests } = embedHarness();
    const jobs = Array.from({ length: 200 }, (_, index) => cache.prefetchEncryptedMessageEmbeds(`https://example.com/${index}`));
    assert.equal(requests.length, 128);
    cache.clearEncryptedEmbedCache();
    await cache.prefetchEncryptedMessageEmbeds("https://example.com/retry");
    assert.equal(requests.length, 128);
    for (const resolve of requests) resolve({ body: { embeds: [] } });
    await Promise.all(jobs);
    const retry = cache.prefetchEncryptedMessageEmbeds("https://example.com/retry");
    assert.equal(requests.length, 129);
    requests[128]({ body: { embeds: [{ title: "Loaded" }] } });
    await retry;
});

test("Secure Messaging retains attachment admission across invalidation and offers retry", async () => {
    const source = readFileSync(process.env.AUDIT_SECURE_CACHE_SOURCE ?? "src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", "utf8");
    const pending: Array<(result: object) => void> = [];
    const modules: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "local" }) } },
        "./messageMetadata": { discordEditedTimestamp: () => null }, "./protocol": { isEncryptedMessage: () => true }
    };
    const exports: Record<string, (...args: unknown[]) => unknown> = {};
    runInNewContext(transpileModule(source, { compilerOptions: { module: 1, target: ScriptTarget.ES2022 } }).outputText, {
        exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncomingAttachments: () => new Promise(resolve => pending.push(resolve)) } } }, URL: { revokeObjectURL() {} }
    });
    const attachmentMessage = (id: number) => ({ ...message(id), attachments: [{ id: "file", size: 1, url: "url", proxy_url: "url" }] });
    for (let index = 0; index < 200; index++) exports.encryptedAttachmentStatus(attachmentMessage(index));
    assert.equal(pending.length, 16);
    assert.equal((exports.encryptedAttachmentStatus(attachmentMessage(201)) as { status: string; }).status, "failed");
    exports.clearEncryptedAttachmentCache();
    exports.encryptedAttachmentStatus(attachmentMessage(201));
    assert.equal(pending.length, 16);
    for (const resolve of pending) resolve({ status: "invalid_message" });
    await flush();
    exports.retryEncryptedAttachments(attachmentMessage(201));
    exports.encryptedAttachmentStatus(attachmentMessage(201));
    assert.equal(pending.length, 17);
});

test("Secure Messaging exposes retries for temporary native and preview saturation", () => {
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8");
    for (const preview of [false, true]) {
        const component = source.slice(source.indexOf("function EncryptedMessageAccessory("), source.indexOf("interface KeyReviewModalProps"));
        let stateIndex = 0;
        let attempts = 0;
        let previewRetries = 0;
        const initialResult = preview ? { status: "decrypted", plaintext: "", attachmentBundle: null } : { status: "failed", error: "busy" };
        interface Element { type: unknown; props: { onClick?: () => void; } | null; children: unknown[]; }
        const context = { render: null as null | ((props: { message: object; }) => Element),
            React: { createElement: (type: unknown, props: Element["props"], ...children: unknown[]) => ({ type, props, children }) },
            useState: () => stateIndex++ === 0 ? [0, (update: (value: number) => number) => { attempts = update(attempts); }] : [initialResult, () => {}],
            useEffect() {}, UserStore: { getCurrentUser: () => ({ id: "local" }) }, useScreenCaptureProtectionStatus: () => "ready",
            encryptedStatusText: () => "Busy", encryptedEmbedFailed: () => preview, retryEncryptedEmbeds: () => previewRetries++, updateMessage() {},
            BaseText: "Text", Button: "Button", LockIcon: "Lock", EncryptedAttachmentStatus: "Attachments" };
        runInNewContext(transpileModule(`${component}\nglobalThis.render = EncryptedMessageAccessory;`, { compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 } }).outputText, context);
        assert.ok(context.render);
        const tree = context.render({ message: message(1) });
        const visit = (value: unknown): (() => void) | undefined => {
            if (!value || typeof value !== "object" || !("children" in value)) return;
            const element = value as Element;
            if (element.type === "Button") return element.props?.onClick;
            for (const child of element.children) { const callback = visit(child); if (callback) return callback; }
        };
        const retry = visit(tree);
        assert.ok(retry);
        retry();
        assert.equal(attempts, 1);
        assert.equal(previewRetries, preview ? 1 : 0);
    }
});
