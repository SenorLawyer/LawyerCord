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

test("Ordinary message renders skip support-only role lookups over a long session", () => {
    let roleReads = 0;
    const identity = Object.assign((value: unknown) => value, { wrap: (value: unknown) => value });
    const modules = { __esModule: true, default: identity, Devs: {}, SUPPORT_CHANNEL_IDS: [],
        getUserSettingLazy: () => ({}), onlyOnce: (callback: unknown) => callback,
        definePluginSettings: () => ({ withPrivateSettings: () => ({}) }),
        isSupportChannel: (id: string) => id === "support", isEquicordSupport: () => { roleReads++; return true; },
        PermissionStore: { can: () => false }, PermissionsBits: {}
    };
    const source = readFileSync(process.env.AUDIT_SUPPORT_HELPER_SOURCE ?? "src/plugins/_core/supportHelper.tsx", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const plugin = runInNewContext(`${code}\nexports.default;`, { exports: {}, require: () => modules, IS_UPDATER_DISABLED: false }) as { renderMessageAccessory(props: unknown): unknown; };
    const props = { channel: { id: "ordinary" }, message: { author: { id: "author" }, content: "text" } };
    for (let i = 0; i < 10_000; i++) assert.equal(plugin.renderMessageAccessory(props), null);
    assert.equal(roleReads, 0);
    plugin.renderMessageAccessory({ ...props, channel: { id: "support" } });
    assert.equal(roleReads, 1);
});
