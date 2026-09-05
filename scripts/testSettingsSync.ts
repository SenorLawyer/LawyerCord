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

const { outputText } = transpileModule(readFileSync("src/api/SettingsSync/offline.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

test("backup imports await file reading, preserve empty CSS, and never log backup content", async () => {
    const css: string[] = [];
    const logs: unknown[] = [];
    const notifications: unknown[] = [];
    let finishRead: ((value: string) => void) | undefined;
    const modules: Record<string, unknown> = {
        "@api/Settings": { PlainSettings: {} },
        "@utils/Logger": { Logger: class { error() { } } },
        "@utils/web": { chooseFile: async () => ({ text: () => new Promise<string>(resolve => { finishRead = resolve; }) }) },
        "@webpack/common": { Toasts: { show: (toast: unknown) => notifications.push(toast), genId: () => "test", Type: { SUCCESS: "success", FAILURE: "failure" } } },
        "..": { DataStore: { setMany: async () => { } } }
    };
    const { importSettings, uploadSettingsBackup } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name], IS_DISCORD_DESKTOP: false,
        console: { log: (...args: unknown[]) => logs.push(args) },
        VencordNative: { settings: { set: async () => { } }, quickCss: { set: async (value: string) => css.push(value) } }
    });
    await assert.rejects(importSettings("invalid private backup"));
    assert.deepEqual(logs, []);
    await importSettings('{"quickCss":""}', "css");
    assert.deepEqual(css, [""]);
    await importSettings('{"settings":{},"quickCss":""}', "all");
    assert.deepEqual(css, ["", ""]);
    let settled = false;
    const pending = uploadSettingsBackup("css").then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.ok(finishRead);
    finishRead('{"quickCss":"restored"}');
    await pending;
    assert.equal(css.at(-1), "restored");
    assert.equal(notifications.length, 1);
});
