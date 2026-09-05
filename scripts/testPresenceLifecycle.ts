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
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, ...globals,
        require(name: string) {
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

const logger = { Logger: class { error() { } warn() { } } };

test("Apple Music coalesces refreshes and discards stopped presence updates", async () => {
    let requests = 0;
    const results: (() => void)[] = [];
    const activities: unknown[] = [];
    const intervals = new Set<() => void>();
    const plugin = load("src/plugins/appleMusic.desktop/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { refreshInterval: 5, largeImageType: "Disabled", smallImageType: "Disabled" } }) },
        "@components/Paragraph": {}, "@utils/constants": { Devs: {}, IS_MAC: true }, "@utils/Logger": logger,
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, ReporterTestable: {} },
        "@vencord/discord-types/enums": { ActivityFlags: {}, ActivityStatusDisplayType: {}, ActivityType: {} },
        "@webpack/common": { FluxDispatcher: { dispatch: (value: unknown) => activities.push(value) } }
    }, {
        VencordNative: { pluginHelpers: { AppleMusicRichPresence: { fetchTrackData: () => {
            requests++;
            return new Promise(resolve => results.push(() => resolve(null)));
        } } } },
        setInterval: (callback: () => void) => { intervals.add(callback); return callback; },
        clearInterval: (callback: () => void) => intervals.delete(callback)
    }).default;
    plugin.start();
    const pending = plugin.updatePresence();
    assert.equal(requests, 1);
    plugin.stop();
    results.shift()?.();
    await pending;
    assert.equal(activities.length, 1);
    assert.equal(intervals.size, 0);
    plugin.start();
    assert.equal(requests, 2);
    const next = plugin.updatePresence();
    results.shift()?.();
    await next;
    assert.equal(activities.length, 2);
    plugin.stop();
});

test("Client Theme aborts replaced stylesheet requests and cannot recreate styles after stop", async () => {
    const requests: { signal: AbortSignal; resolve: (value: unknown) => void; }[] = [];
    const styles: { textContent: string; removed: boolean; remove(): void; }[] = [];
    const theme = load("src/plugins/clientTheme/utils/styleUtils.ts", {
        "@api/Styles": { managedStyleRootNode: {} }, "@utils/Logger": logger,
        "@utils/css": { createAndAppendStyle: () => {
            const style = { textContent: "", removed: false, remove() { this.removed = true; } };
            styles.push(style);
            return style;
        } },
        "./colorUtils": { hexToHSL: () => ({ hue: 0, saturation: 0, lightness: 50 }) }
    }, {
        AbortController,
        document: { querySelectorAll: () => [{ href: "https://discord.com/test.css" }] },
        fetch: (_url: string, { signal }: { signal: AbortSignal; }) => new Promise(resolve => requests.push({ signal, resolve }))
    });
    const first = theme.startClientTheme("313338");
    const second = theme.startClientTheme("313338");
    assert.equal(requests[0].signal.aborted, true);
    theme.disableClientTheme();
    assert.equal(requests[1].signal.aborted, true);
    for (const request of requests) request.resolve({ ok: true, text: async () => "--neutral-2-hsl:0 0 90%;--neutral-69-hsl:0 0 10%;" });
    await Promise.all([first, second]);
    assert.equal(styles.length, 1);
    assert.ok(styles.every(style => style.removed));
    theme.createOrUpdateThemeColorVars("313338");
    assert.equal(styles.length, 1);
});


test("Custom RPC debounces settings changes and bounds very short timestamp loops", async () => {
    const source = readFileSync("src/plugins/customRPC/index.tsx", "utf8");
    const start = source.indexOf("export async function setRpc");
    const end = source.indexOf("export default definePlugin");
    const code = transpileModule(source.slice(start, end).replace("export async", "async"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const timers = new Map<() => void, number>();
    const activities: unknown[] = [];
    let builds = 0;
    const context = {
        settings: { store: { appName: "test", timestampMode: 3, startTime: 1, endTime: 2 } },
        TimestampMode: { CUSTOM: 3 }, UserStore: { getCurrentUser: () => ({ id: "user" }) },
        createActivity: async () => { builds++; return { name: "test" }; },
        FluxDispatcher: { dispatch: (activity: unknown) => activities.push(activity) },
        logger: { error() { } },
        setTimeout: (callback: () => void, delay: number) => { timers.set(callback, delay); return callback; },
        clearTimeout: (callback: () => void) => timers.delete(callback)
    };
    const rpc = runInNewContext(code + "\npluginActive = true; ({ handleSettingsChange, setRpc });", context);
    rpc.handleSettingsChange(undefined, "plugins.Other.setting");
    assert.equal(timers.size, 0);
    for (let index = 0; index < 10; index++) rpc.handleSettingsChange(undefined, "plugins.CustomRPC.details");
    assert.equal(timers.size, 2);
    assert.deepEqual([...timers.values()].sort((a, b) => a - b), [300, 1000]);
    const update = [...timers].find(([, delay]) => delay === 300);
    assert.ok(update);
    timers.delete(update[0]);
    update[0]();
    await setImmediate();
    assert.equal(builds, 1);
    assert.equal(activities.length, 1);
    await rpc.setRpc(true);
    assert.equal(timers.size, 0);
});


test("ClearURLs cancels obsolete downloads and retains its existing cleaning behavior", async () => {
    const requests: { signal: AbortSignal; resolve: (value: unknown) => void; }[] = [];
    const plugin = load("src/plugins/clearURLs/index.ts", {
        "@utils/constants": { Devs: {} }, "@utils/Logger": logger,
        "@utils/types": { __esModule: true, default: (value: unknown) => value }
    }, {
        AbortController, URL,
        fetch: (_url: string, { signal }: { signal: AbortSignal; }) => new Promise(resolve => requests.push({ signal, resolve }))
    }).default;
    const catalog = { providers: { test: { urlPattern: "example.com", rules: ["^utm_source$"], rawRules: ["&raw=1"], exceptions: ["/keep"] } } };
    const first = plugin.start();
    const second = plugin.createRules();
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({ ok: true, json: async () => catalog });
    await second;
    assert.equal(plugin.rules.length, 1);
    assert.equal(plugin.replacer("https://example.com/path?utm_source=a&ok=1&raw=1"), "https://example.com/path?ok=1");
    assert.equal(plugin.replacer("https://example.com/keep?utm_source=a"), "https://example.com/keep?utm_source=a");
    requests[0].resolve({ ok: true, json: async () => ({ providers: {} }) });
    await first;
    assert.equal(plugin.rules.length, 1);
    const stopped = plugin.createRules();
    plugin.stop();
    assert.equal(requests[2].signal.aborted, true);
    requests[2].resolve({ ok: true, json: async () => catalog });
    await stopped;
    assert.equal(plugin.rules.length, 0);
});
