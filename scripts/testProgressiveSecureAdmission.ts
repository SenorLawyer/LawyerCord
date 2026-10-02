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
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Secure attachment admission bounds authentication work before the vault queue", async () => {
    const source = readFileSync(process.env.AUDIT_SECURE_NATIVE_SOURCE ?? "src/equicordplugins/secureMessaging.desktop/native.ts", "utf8");
    const file = createSourceFile("native.ts", source, ScriptTarget.ES2022, true);
    const fn = file.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "decryptIncomingAttachments");
    assert.ok(fn);
    const javascript = transpileModule(fn.getText(file), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const authentication = Promise.withResolvers<{ status: string }>();
    let calls = 0;
    const api = runInNewContext(`${javascript};exports`, {
        exports: {}, AbortController, setTimeout, clearTimeout,
        attachmentRequests: new Set(), MAX_ATTACHMENT_REQUESTS: 2, ATTACHMENT_DOWNLOAD_TIMEOUT_MS: 60_000,
        validateIpcCaller: () => null, validateLocalUserId: (value: string) => ({ ok: true, value }),
        validateDecryptAttachmentsInput: (value: unknown) => ({ ok: true, value }),
        decryptIncoming: () => { calls++; return authentication.promise; }
    });
    const requests = Array.from({ length: 100 }, () => api.decryptIncomingAttachments({}, "self", { attachments: [] }));
    try {
        assert.equal(calls, 2);
        assert.equal((await requests[2]).error, "capacity_exceeded");
    } finally {
        authentication.resolve({ status: "invalid_message" });
        await Promise.all(requests);
    }
});

test("Secure attachment decryption holds capacity and wipes successful siblings when another fails", async () => {
    const file = createSourceFile("native.ts", readFileSync("src/equicordplugins/secureMessaging.desktop/native.ts", "utf8"), ScriptTarget.ES2022, true);
    const fn = file.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "decryptIncomingAttachments");
    assert.ok(fn);
    const javascript = transpileModule(fn.getText(file), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const sibling = Promise.withResolvers<{ data: Uint8Array }>();
    const requests = new Set<AbortController>();
    const plaintext = new Uint8Array([42]);
    const api = runInNewContext(`${javascript};exports`, {
        exports: {}, AbortController, setTimeout, clearTimeout,
        attachmentRequests: requests, MAX_ATTACHMENT_REQUESTS: 2, ATTACHMENT_DOWNLOAD_TIMEOUT_MS: 60_000,
        validateIpcCaller: () => null, validateLocalUserId: (value: string) => ({ ok: true, value }),
        validateDecryptAttachmentsInput: (value: unknown) => ({ ok: true, value }),
        decryptIncoming: async () => ({ status: "decrypted", attachmentBundle: { count: 2, root: "digest", key: "key" } }),
        downloadEncryptedAttachment: async () => new Uint8Array([1]),
        attachmentBundleRoot: async () => "digest", decodeBase64Url: () => new Uint8Array(32),
        decryptAttachmentBytes: ({ index }: { index: number }) => index ? sibling.promise : Promise.reject(Error("Invalid authentication tag."))
    });
    const pending = api.decryptIncomingAttachments({}, "self", { attachments: [{ id: "first" }, { id: "second" }] });
    await setImmediate();
    assert.equal(requests.size, 1);
    sibling.resolve({ data: plaintext });
    assert.equal((await pending).status, "invalid_message");
    assert.equal(requests.size, 0);
    assert.equal(plaintext[0], 0);
});
