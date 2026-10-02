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

test("Secure messaging retains render owners only while capture protection is pending", () => {
    const source = transpileModule(readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const modules: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/constants": { EquicordDevs: {} },
        "./keyReviewGate": { KeyReviewGate: class {} },
        "./attachmentCache": { patchEncryptedMessageAttachments: () => {} },
        "./embedCache": { patchEncryptedMessageEmbeds: () => {}, patchEncryptedMessageStickers: () => {} }
    };
    const api = runInNewContext(`${source};({plugin:exports.default,setStatus:setScreenCaptureProtectionStatus,count:()=>pendingEncryptedRenderOwners.size})`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, VencordNative: { pluginHelpers: {} }
    });
    for (const status of ["screenshot", "failed", "disabled"]) {
        api.setStatus(status);
        for (let index = 0; index < 1000; index++) {
            const owner = { forceUpdate() {} };
            api.plugin.patchEncryptedAttachments({}, owner);
            api.plugin.patchEncryptedEmbeds({}, owner);
            api.plugin.patchEncryptedStickers({}, owner);
        }
        assert.equal(api.count(), 0, status);
    }
    let updates = 0;
    api.setStatus("pending");
    const owner = { forceUpdate() { updates++; } };
    api.plugin.patchEncryptedAttachments({}, owner);
    api.plugin.patchEncryptedEmbeds({}, owner);
    assert.equal(api.count(), 1);
    api.setStatus("ready");
    assert.equal(updates, 1);
    assert.equal(api.count(), 0);
});
