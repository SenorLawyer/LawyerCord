/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Roblox process checks ignore unrelated presence events and retain single-flight polling", async () => {
    const path = "src/equicordplugins/robloxActivity.desktop/index.ts";
    const baseline = process.env.LAWYERCORD_TEST_BASELINE;
    const source = baseline ? execFileSync("git", ["show", baseline + ":" + path], { encoding: "utf8" }) : readFileSync(path, "utf8");
    let checks = 0;
    let finish: ((value: boolean) => void) | undefined;
    let blocked = false;
    const intervals = new Set<() => void>();
    const user = { id: "1045011641940574208" };
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: (definitions: Record<string, { default: unknown; }>) => ({ store: Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.default])) }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(error: unknown) { throw error; } } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/discord": { sendMessage: () => { throw new Error("Unexpected message."); } },
        "@webpack/common": { UserStore: { getCurrentUser: () => user }, PresenceStore: { getActivities: () => [] } }
    };
    const plugin = runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText + "\nexports.default;", {
        exports: {}, require: (name: string) => modules[name],
        setInterval: (callback: () => void) => { intervals.add(callback); return callback; },
        clearInterval: (callback: () => void) => intervals.delete(callback),
        VencordNative: { pluginHelpers: { RobloxActivity: { isRobloxRunning: () => {
            checks++;
            return blocked ? new Promise<boolean>(resolve => { finish = resolve; }) : Promise.resolve(false);
        } } } }
    });
    plugin.start();
    await setImmediate();
    assert.equal(checks, 1);
    for (let index = 0; index < 1000; index++) {
        plugin.flux.PRESENCE_UPDATE({ user: { id: "unrelated" } });
        await setImmediate();
    }
    assert.equal(checks, 1, "Other users' presence must not launch local process checks.");
    blocked = true;
    plugin.flux.PRESENCE_UPDATE({ user });
    for (let index = 0; index < 1000; index++) {
        plugin.flux.PRESENCE_UPDATE({ user });
        for (const callback of intervals) callback();
    }
    assert.equal(checks, 2);
    plugin.stop();
    assert.equal(intervals.size, 0);
    assert.ok(finish);
    finish(false);
    await setImmediate();
    blocked = false;
    plugin.start();
    await setImmediate();
    assert.equal(checks, 3);
    plugin.stop();
});
