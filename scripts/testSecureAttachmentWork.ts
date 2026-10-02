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

import * as attachments from "../src/equicordplugins/secureMessaging.desktop/attachments";
import * as protocol from "../src/equicordplugins/secureMessaging.desktop/protocol";

function loadSource(path: string, modules: Record<string, unknown>, globals: Record<string, unknown>) {
    const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    runInNewContext(outputText, { exports, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, ...globals,
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    return exports;
}

test("Secure Messaging rejects an oversized attachment before reading any file bytes", async () => {
    class FileFixture { size = attachments.MAX_ATTACHMENT_BYTES + 1; arrayBuffer() { assert.fail("Oversized attachment must not be read."); } }
    const source = loadSource(process.env.AUDIT_SECURE_UPLOAD_SOURCE ?? "src/equicordplugins/secureMessaging.desktop/attachmentUploads.ts", {
        "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: 0 } }, "./attachments": attachments
    }, { File: FileFixture });
    await assert.rejects(source.prepareEncryptedAttachments([{ status: "NOT_STARTED", item: { platform: 0, file: new FileFixture() } }], "", "123456789012345678", "123456789012345679"), /100 MiB/);
});

test("Secure Messaging releases the exact encryption input on success and failure without copying the full plaintext", async () => {
    for (const fails of [false, true]) {
        let encryptionInput: ArrayBuffer | undefined;
        const source = loadSource(process.env.AUDIT_SECURE_ATTACHMENT_SOURCE ?? "src/equicordplugins/secureMessaging.desktop/attachments.ts", {
            "./protocol": protocol
        }, { crypto: { subtle: {
            importKey: async () => ({}), deriveBits: async () => new ArrayBuffer(44),
            encrypt: async (_algorithm: unknown, _key: unknown, data: ArrayBuffer) => {
                encryptionInput = data;
                assert.ok(new Uint8Array(data).some(byte => byte !== 0));
                if (fails) throw new Error("Encryption failed.");
                return new ArrayBuffer(16);
            }
        } } });
        const data = new Uint8Array([1, 2, 3]);
        const encrypting = source.encryptAttachmentBytes({ bundleId: protocol.encodeBase64Url(new Uint8Array(16)), channelId: "123456789012345678",
            senderUserId: "123456789012345679", count: 1, index: 0, masterKey: new Uint8Array(32), data,
            metadata: { name: "test.bin", mimeType: "application/octet-stream", size: 3, spoiler: false, description: null, width: null, height: null, duration: null } });
        if (fails) await assert.rejects(encrypting, /Encryption failed/);
        else await encrypting;
        assert.ok(encryptionInput);
        assert.ok(new Uint8Array(encryptionInput).every(byte => byte === 0));
        assert.deepEqual(data, new Uint8Array([1, 2, 3]));
    }
});
