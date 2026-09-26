/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Deflate, deflateSync } from "fflate";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isCallExpression, isFunctionDeclaration, isPropertyAccessExpression, isVariableStatement, JsxEmit, ModuleKind, type Node, ScriptTarget, transpileModule } from "typescript";

import { readResponseText } from "../src/shared/readResponseText";

const jsonResponseReader = {
    readResponseText: async (response: Response | { json(): Promise<unknown>; }, maxBytes: number) =>
        readResponseText(response instanceof Response ? response : Response.json(await response.json()), maxBytes)
};

function compressedBody(read: () => Promise<string>) {
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            controller.enqueue(deflateSync(new TextEncoder().encode(await read())));
            controller.close();
        }
    }, { highWaterMark: 0 });
}

const { outputText } = transpileModule(readFileSync("src/api/SettingsSync/offline.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

const settingsSource = createSourceFile("Settings.ts", readFileSync("src/api/Settings.ts", "utf8"), ScriptTarget.Latest, true);
const defaultsDeclaration = settingsSource.statements.filter(isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(settingsSource) === "DefaultSettings");
assert.ok(defaultsDeclaration?.initializer);
const defaultSettings = runInNewContext(`(${defaultsDeclaration.initializer.getText(settingsSource)})`);

test("cloud authentication rejects missing or changed owners and deauthorizes the captured account", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSetup.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "cloudSetup.tsx"
    }).outputText;
    let userId = "first";
    const settings = { cloud: { url: "https://first.invalid" } };
    let finishRead: ((value: Record<string, string>) => void) | undefined;
    let finishUpdate: (() => void) | undefined;
    let records = { "https://first.invalid:first": "first", "https://first.invalid:second": "second" } as Record<string, string>;
    const modules: Record<string, unknown> = {
        "@api/DataStore": {
            get: () => new Promise<Record<string, string>>(resolve => { finishRead = resolve; }),
            update: (_key: string, change: (value: Record<string, string>) => Record<string, string>) => new Promise<void>(resolve => { finishUpdate = () => { records = change(records); resolve(); }; })
        },
        "@api/Settings": { Settings: settings },
        "@utils/Logger": { Logger: class {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } }
    };
    const { getAuthorization, getCloudAuth, deauthorizeCloud } = runInNewContext(`${compiled}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, window: { btoa }
    });
    for (const change of ["account", "service", "missing"]) {
        userId = "first";
        settings.cloud.url = "https://first.invalid";
        const pending = getCloudAuth();
        assert.ok(finishRead);
        if (change === "account") userId = "second";
        if (change === "service") settings.cloud.url = "https://second.invalid";
        finishRead(change === "missing" ? {} : records);
        await assert.rejects(pending, /Cloud authorization/);
    }
    userId = "first";
    settings.cloud.url = "https://first.invalid";
    const valid = getCloudAuth();
    assert.ok(finishRead);
    finishRead(records);
    assert.equal(await valid, btoa("first:first"));
    const removal = deauthorizeCloud();
    assert.ok(finishUpdate);
    userId = "second";
    finishUpdate();
    await removal;
    assert.deepEqual(records, { "https://first.invalid:second": "second" });
    for (const change of ["account", "newer", "removed"]) {
        userId = "first";
        records = { "https://first.invalid": "legacy" };
        const previousUpdate = finishUpdate;
        const migration = getAuthorization();
        assert.ok(finishRead);
        finishRead({ ...records });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(finishUpdate);
        assert.notEqual(finishUpdate, previousUpdate);
        if (change === "account") userId = "second";
        if (change === "newer") records["https://first.invalid:first"] = "newer";
        if (change === "removed") records = {};
        finishUpdate();
        assert.equal(await migration, change === "account" ? "legacy" : change === "newer" ? "newer" : undefined);
        assert.equal(records["https://first.invalid:second"], undefined);
        assert.equal(records["https://first.invalid:first"], change === "account" ? "legacy" : change === "newer" ? "newer" : undefined);
    }
});

test("cloud backend controls retain saved credentials and reserve deletion for reauthorization", async () => {
    const settings = { cloud: { url: "https://first.invalid", authenticated: true, settingsSync: false } };
    let records: Record<string, string> = { "https://first.invalid:first": "one", "https://second.invalid:first": "two" };
    let requests = 0;
    let userId = "first";
    let pauseUpdate: (() => Promise<void>) | undefined;
    const modules: Record<string, unknown> = {
        "@api/Settings": { Settings: settings, useSettings: () => settings },
        "@api/DataStore": {
            get: async () => ({ ...records }),
            update: async (_key: string, change: (value: Record<string, string>) => Record<string, string>) => { await pauseUpdate?.(); records = change(records); }
        },
        "@api/Notifications": { showNotification() {} },
        "@shared/readResponseText": { readResponseText },
        "@utils/Logger": { Logger: class { info() {} error() {} } },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@utils/react": { useForceUpdater: () => () => {} },
        "@utils/localStorage": { localStorage: {} },
        "@utils/margins": { Margins: {} },
        "@webpack": { findComponentByCodeLazy: () => "Icon" },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            useState: () => [0, () => {}], SearchableSelect: "SearchableSelect", Select: "Select",
            openModal() {}, OAuth2AuthorizeModal: "Modal"
        },
        "@components/settings/tabs/BaseTab": { SettingsTab: "SettingsTab", wrapTab: (component: unknown) => component }
    };
    type Control = { type: unknown; props: { onChange?: (value: string | boolean) => Promise<void> | void; onClick?: () => Promise<void> | void; children?: unknown; title?: string; }; };
    const controls: Control[] = [];
    const globals = {
        URL, AbortSignal,
        React: { createElement: (type: unknown, props: Control["props"] | null, ...children: unknown[]) => {
            const control = { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
            controls.push(control);
            return control;
        } },
        fetch: async () => { requests++; return Response.json({ clientId: "test", redirectUri: "https://second.invalid/callback" }); }
    };
    function load(file: string) {
        const compiled = transpileModule(readFileSync(file, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: file
        }).outputText;
        return runInNewContext(`${compiled}\nexports;`, {
            ...globals, exports: {}, require: (name: string) => modules[name] ?? new Proxy({}, { get: (_target, key) => key })
        });
    }
    modules["@api/SettingsSync/cloudSetup"] = load("src/api/SettingsSync/cloudSetup.tsx");
    load("src/components/settings/tabs/sync/CloudTab.tsx").default();
    const select = controls.find(control => control.type === "SearchableSelect");
    const input = controls.find(control => control.type === "CheckedTextInput");
    const toggle = controls.find(control => control.props.title === "Enable Cloud Integration");
    const reauthorize = controls.find(control => control.type === "Button" && JSON.stringify(control.props.children).includes("Reauthorize"));
    assert.ok(select?.props.onChange);
    assert.ok(input?.props.onChange);
    assert.ok(reauthorize?.props.onClick);
    assert.ok(toggle?.props.onChange);
    await select.props.onChange("https://second.invalid");
    assert.equal(settings.cloud.authenticated, true);
    assert.equal(requests, 0);
    assert.deepEqual(records, { "https://first.invalid:first": "one", "https://second.invalid:first": "two" });
    await toggle.props.onChange(false);
    assert.equal(settings.cloud.authenticated, false);
    assert.deepEqual(records, { "https://first.invalid:first": "one", "https://second.invalid:first": "two" });
    await input.props.onChange("https://first.invalid");
    await input.props.onChange("https://second.invalid");
    assert.equal(settings.cloud.authenticated, false);
    assert.deepEqual(records, { "https://first.invalid:first": "one", "https://second.invalid:first": "two" });
    await reauthorize.props.onClick();
    assert.deepEqual(records, { "https://first.invalid:first": "one" });
    assert.equal(requests, 1);
    for (const change of ["account", "service", "cancel"]) {
        userId = "first";
        settings.cloud.url = "https://second.invalid";
        records["https://second.invalid:first"] = "two";
        let finish = () => {};
        pauseUpdate = () => new Promise<void>(resolve => { finish = resolve; });
        const pending = reauthorize.props.onClick();
        if (change === "account") userId = "second";
        if (change === "service") settings.cloud.url = "https://third.invalid";
        if (change === "cancel") await toggle.props.onChange(false);
        finish();
        await pending;
        assert.equal(requests, 1, `Reauthorization must stop after ${change}`);
        assert.equal(records["https://second.invalid:first"], undefined);
    }
});

test("obsolete cloud authorization callbacks cannot save credentials or change authentication", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSetup.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "cloudSetup.tsx"
    }).outputText;
    for (const change of ["storage", "config-timeout", "callback-timeout", "config-status", "config-shape", "config-protocol", "callback-origin", "callback-path", "callback-status", "callback-json", "read", "configuration", "account", "service", "deauthorize", "cancel", "newer", "invalid", "none"]) {
        let userId = "first";
        const settings = { cloud: { url: "https://first.invalid", authenticated: false } };
        const requests: ((value: unknown) => void)[] = [];
        const notifications: unknown[] = [];
        const logs: string[] = [];
        const controllers: AbortController[] = [];
        let modal: { callback: (value: { location: string }) => Promise<void> } | undefined;
        let records: Record<string, string> = {};
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": { readResponseText },
            "@api/DataStore": { get: async () => { if (change === "storage") throw new Error("Storage unavailable"); return { ...records }; }, update: async (_key: string, fn: (value: Record<string, string>) => Record<string, string>) => { records = fn(records); } },
            "@api/Settings": { Settings: settings },
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@utils/Logger": { Logger: class { info() {} error(...args: unknown[]) { logs.push(args.map(String).join(" ")); } } },
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, OAuth2AuthorizeModal: "modal", openModal: (render: (props: object) => typeof modal) => { modal = render({}); } }
        };
        const { authorizeCloud, deauthorizeCloud, cancelCloudAuthorization } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL,
            AbortSignal: { timeout: (ms: number) => { assert.equal(ms, 30_000); const controller = new AbortController(); controllers.push(controller); return controller.signal; } },
            React: { createElement: (_type: unknown, props: unknown) => props },
            fetch: (_url: URL, options?: RequestInit) => new Promise((resolve, reject) => { requests.push(resolve); options?.signal?.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true }); })
        });
        const configuration = () => Response.json(change === "config-shape" ? null : { clientId: "test", redirectUri: change === "config-protocol" ? "javascript:alert(1)" : "https://first.invalid/callback" }, { status: change === "config-status" ? 500 : 200 });
        const begin = authorizeCloud().catch((error: unknown) => error);
        if (change === "read") userId = "second";
        await new Promise<void>(resolve => setImmediate(resolve));
        if (change === "storage") {
            assert.equal(await begin, undefined);
            assert.equal(requests.length, 0);
            assert.equal(notifications.length, 1);
            continue;
        }
        if (change === "read") {
            await begin;
            assert.equal(requests.length, 0);
            assert.equal(modal, undefined);
            continue;
        }
        if (change === "config-timeout") {
            assert.ok(controllers[0]);
            controllers[0].abort();
            await begin;
            assert.equal(modal, undefined);
            assert.equal(settings.cloud.authenticated, false);
            assert.equal(notifications.length, 1);
            continue;
        }
        if (change === "configuration") userId = "second";
        requests.shift()?.(configuration());
        await begin;
        if (change.startsWith("config-")) {
            assert.equal(modal, undefined);
            assert.equal(notifications.length, 1);
            continue;
        }
        if (change === "configuration") {
            assert.equal(modal, undefined);
            assert.equal(notifications.length, 0);
            continue;
        }
        assert.ok(modal);
        const pending = modal.callback({ location: change === "callback-origin" ? "https://second.invalid/callback" : change === "callback-path" ? "https://first.invalid/other" : "https://first.invalid/callback?code=synthetic" });
        if (change === "callback-origin" || change === "callback-path") {
            assert.equal(requests.length, 0);
            await pending;
            assert.deepEqual(records, {});
            assert.equal(notifications.length, 1);
            continue;
        }
        const finishResponse = requests.shift();
        assert.ok(finishResponse);
        if (change === "callback-timeout") {
            const controller = controllers.at(-1);
            assert.ok(controller);
            controller.abort();
            await pending;
            assert.deepEqual(records, {});
            assert.equal(settings.cloud.authenticated, false);
            assert.equal(notifications.length, 1);
            continue;
        }
        let newer: Promise<void> | undefined;
        if (change === "account") userId = "second";
        if (change === "service") settings.cloud.url = "https://second.invalid";
        if (change === "deauthorize") await deauthorizeCloud();
        if (change === "cancel") cancelCloudAuthorization();
        if (change === "newer") {
            newer = authorizeCloud();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        finishResponse(change === "callback-json" ? new Response("SECRET_DO_NOT_LOG") : Response.json({ secret: change === "invalid" ? 17 : "synthetic" }, { status: change === "callback-status" ? 500 : 200 }));
        await pending;
        if (change === "none") {
            assert.deepEqual(records, { "https://first.invalid:first": "synthetic" });
            assert.equal(settings.cloud.authenticated, true);
            assert.equal(notifications.length, 1);
            continue;
        }
        if (change === "invalid" || change === "callback-status" || change === "callback-json") {
            assert.doesNotMatch(logs.join(" ") + JSON.stringify(notifications), /SECRET/);
            if (change === "callback-json") assert.match(JSON.stringify(notifications), /invalid JSON/);
            assert.deepEqual(records, {});
            assert.equal(settings.cloud.authenticated, false);
            assert.equal(notifications.length, 1);
            continue;
        }
        assert.deepEqual(records, {}, change);
        assert.equal(settings.cloud.authenticated, false, change);
        assert.equal(notifications.length, 0, change);
        if (newer) {
            requests.shift()?.(configuration());
            await newer;
        }
    }
});

test("cloud authorization bounds streamed configuration and callback bodies before accepting them", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSetup.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "cloudSetup.tsx"
    }).outputText;
    const limit = 1024 * 1024;
    for (const stage of ["configuration", "callback"]) for (const extra of [0, 1]) for (const header of [undefined, "1"]) {
        const settings = { cloud: { url: "https://first.invalid", authenticated: false } };
        const notifications: unknown[] = [];
        let records: Record<string, string> = {};
        let modal: { callback: (value: { location: string }) => Promise<void> } | undefined;
        let cancelled = false;
        let response: Response | undefined;
        let count = 0;
        const configuration = { clientId: "test", redirectUri: "https://first.invalid/callback" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": { readResponseText },
            "@api/DataStore": { get: async () => records, update: async (_key: string, fn: (value: Record<string, string>) => Record<string, string>) => { records = fn(records); } },
            "@api/Settings": { Settings: settings },
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { parseUrl: (value: string) => new URL(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) }, OAuth2AuthorizeModal: "modal", openModal: (render: (props: object) => typeof modal) => { modal = render({}); } }
        };
        const { authorizeCloud } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
            React: { createElement: (_type: unknown, props: unknown) => props },
            fetch: async () => {
                const isConfiguration = count++ === 0;
                const value = isConfiguration ? configuration : { secret: "synthetic" };
                if (isConfiguration !== (stage === "configuration")) return Response.json(value);
                const json = JSON.stringify(value);
                const bytes = new TextEncoder().encode(json + " ".repeat(limit + extra - json.length));
                let position = 0;
                response = new Response(new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (position === bytes.length) { controller.close(); return; }
                        const end = Math.min(position + 8192, bytes.length);
                        controller.enqueue(bytes.subarray(position, end));
                        position = end;
                    },
                    cancel() { cancelled = true; }
                }, { highWaterMark: 0 }), { headers: header === undefined ? {} : { "Content-Length": header } });
                return response;
            }
        });
        await authorizeCloud();
        if (stage === "configuration" && extra) assert.equal(modal, undefined);
        else {
            assert.ok(modal);
            await modal.callback({ location: "https://first.invalid/callback?code=synthetic" });
        }
        assert.ok(response?.body);
        assert.equal(settings.cloud.authenticated, extra === 0);
        assert.equal(notifications.length, 1);
        assert.deepEqual(records, extra ? {} : { "https://first.invalid:first": "synthetic" });
        if (extra) {
            assert.equal(cancelled, true);
            assert.equal(response.body.locked, false);
        }
    }
});

test("desktop settings saves preserve the previous file and store when disk writes fail", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "lawyercord-settings-"));
    const file = join(directory, "settings.json");
    const initial = { plugins: { Sound: { volume: 20 } } };
    fs.writeFileSync(file, JSON.stringify(initial));
    const handlers = new Map<string, (event: unknown, value: unknown, path?: string, expected?: string) => void>();
    const errors: unknown[][] = [];
    let failure = "write";
    const evaluate = (path: string, modules: Record<string, unknown> = {}) => {
        const compiled = transpileModule(readFileSync(path, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        return runInNewContext(`${compiled}\nexports;`, { exports: {}, require: (name: string) => modules[name], console: { ...console, error: (...values: unknown[]) => errors.push(values) } });
    };
    try {
        const { RendererSettings } = evaluate("src/main/settings.ts", {
            "@shared/IpcEvents": { IpcEvents: { GET_SETTINGS_DIR: "directory", GET_SETTINGS: "get", SET_SETTINGS: "set" } },
            "@shared/SettingsStore": evaluate("src/shared/SettingsStore.ts"),
            "@utils/mergeDefaults": evaluate("src/utils/mergeDefaults.ts"),
            electron: { ipcMain: { handle: (name: string, handler: (event: unknown, value: unknown, path?: string, expected?: string) => void) => handlers.set(name, handler), on() {} } },
            fs: {
                ...fs,
                writeFileSync: (path: string, data: string) => {
                    if (failure === "write") {
                        fs.writeFileSync(path, "partial");
                        throw new Error(`Disk full at ${path}`);
                    }
                    fs.writeFileSync(path, data);
                },
                renameSync: (source: string, target: string) => {
                    if (failure === "rename") throw new Error(`Access denied at ${target}`);
                    fs.renameSync(source, target);
                }
            },
            "./utils/constants": { SETTINGS_DIR: directory, SETTINGS_FILE: file, NATIVE_SETTINGS_FILE: join(directory, "native.json") }
        });
        const save = handlers.get("set");
        assert.ok(save);
        const changes: number[] = [];
        RendererSettings.addChangeListener("plugins.Sound.volume", (value: number) => changes.push(value));
        const next = { plugins: { Sound: { volume: 70 } } };
        for (failure of ["write", "rename"]) {
            assert.throws(() => save(undefined, next, "plugins.Sound.volume"), /^Error: Failed to save settings\.$/);
            assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), initial);
            assert.equal(RendererSettings.plain.plugins.Sound.volume, 20);
            assert.deepEqual(changes, []);
        }
        failure = "";
        save(undefined, next, "plugins.Sound.volume");
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
        assert.equal(RendererSettings.plain.plugins.Sound.volume, 70);
        assert.deepEqual(changes, [70]);
        assert.throws(() => save(undefined, initial, "plugins.Sound.volume", JSON.stringify(initial)), /Settings changed during sync/);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
        assert.equal(RendererSettings.plain.plugins.Sound.volume, 70);
        assert.deepEqual(changes, [70]);
        const checkpoint = { ...next, cloud: { settingsSyncVersion: 10 } };
        save(undefined, checkpoint, undefined, JSON.stringify(next));
        assert.throws(() => save(undefined, initial, "plugins.Sound.volume", JSON.stringify(next)), /Settings changed during sync/);
        save(undefined, initial, "plugins.Sound.volume", JSON.stringify(checkpoint));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), initial);
        assert.deepEqual(changes, [70, 20]);
        assert.equal(errors.length, 2);
    } finally {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("backup imports validate every selected section before changing settings or storage", async () => {
    const initial = { themeLinks: ["old"], plugins: { Sound: { enabled: true } }, cloud: { url: "https://local.invalid", authenticated: true, settingsSync: true, settingsSyncVersion: 10 } };
    const plain = structuredClone(initial);
    const writes: unknown[] = [];
    const modules: Record<string, unknown> = {
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/Settings": { PlainSettings: plain, DefaultSettings: defaultSettings },
        "@utils/Logger": { Logger: class {} },
        "@utils/web": {},
        "@webpack/common": {},
        "..": { DataStore: { setMany: async (value: unknown) => { writes.push(value); } } }
    };
    const { importSettings } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, structuredClone, require: (name: string) => modules[name],
        VencordNative: { settings: { set: async (value: unknown) => { writes.push(value); } }, quickCss: { set: async (value: unknown) => { writes.push(value); } } }
    });
    await assert.rejects(importSettings("private backup contents"), /Invalid settings backup JSON\./);
    for (const value of [
        { settings: { themeLinks: ["new"] }, quickCss: 17 },
        { settings: { themeLinks: ["new"] }, dataStore: {} },
        { settings: { themeLinks: ["new"] }, quickCss: "new", dataStore: [["valid", 1], ["missing value"]] },
        { settings: "invalid" }, { settings: [] }, { settings: null },
        { settings: { plugins: false } }, { settings: { plugins: { Sound: null } } },
        { settings: { plugins: { Sound: { enabled: "yes" } } } },
        { settings: { cloud: null } }, { settings: { cloud: { authenticated: 1 } } },
        { settings: { themeLinks: "url" } }, { settings: { themeLinks: [17] } },
        { settings: { notifications: { timeout: "long" } } },
        { settings: {}, dataStore: [[{}, "value"]] }, { settings: {}, dataStore: [[null, "value"]] },
        null, [], 5
    ]) {
        await assert.rejects(importSettings(JSON.stringify(value)));
        assert.deepEqual(plain, initial);
        assert.equal(writes.length, 0);
    }
    await assert.rejects(importSettings('{"settings":{"plugins":{"__proto__":{"polluted":true}}}}'));
    await assert.rejects(importSettings('{"settings":{"notifications":{"timeout":1e400}}}'));
    assert.deepEqual(plain, initial);
    assert.equal(writes.length, 0);
    await importSettings(JSON.stringify({ settings: { themeLinks: ["new"], plugins: { Sound: { volume: 20 } } }, quickCss: "", dataStore: [[["key", 2], { saved: true }]] }));
    assert.deepEqual(Array.from(plain.themeLinks), ["new"]);
    assert.deepEqual(plain.plugins.Sound, { enabled: true, volume: 20 });
    assert.equal(writes.length, 3);
    writes.length = 0;
    await importSettings('{"quickCss":"","settings":false,"dataStore":false}', "css");
    assert.deepEqual(writes, [""]);
    writes.length = 0;
    await importSettings('{"quickCss":""}', "all", true);
    assert.deepEqual(writes, [""]);
    writes.length = 0;
    await importSettings('{"dataStore":[[1e400,"value"],[[],"empty key"]]}', "datastore");
    const pairs = writes[0];
    assert.ok(Array.isArray(pairs));
    assert.equal(pairs[0][0], Infinity);
    assert.deepEqual(Array.from(pairs[1][0]), []);
    await importSettings('{"settings":{"plugins":{"FuturePlugin":{"enabled":false,"custom":[null,false,{"future":true}]}}}}', "plugins");
    assert.deepEqual(JSON.parse(JSON.stringify(plain)).plugins.FuturePlugin, { enabled: false, custom: [null, false, { future: true }] });
    const cloud = plain.cloud;
    const downloaded = { settings: { cloud: { url: "https://remote.invalid", authenticated: false, settingsSync: false, settingsSyncVersion: 99 }, plugins: { Sound: { enabled: false } } } };
    await importSettings(JSON.stringify(downloaded), "all", true);
    assert.equal(plain.cloud, cloud);
    assert.deepEqual(plain.cloud, initial.cloud, "Cloud downloads must preserve local service and authentication settings");
    assert.equal(plain.plugins.Sound.enabled, false);
    await importSettings(JSON.stringify(downloaded), "plugins");
    assert.deepEqual(plain.cloud, downloaded.settings.cloud, "Explicit offline restores may restore cloud configuration");
});

test("runtime import failures report partial application without undoing newer edits", async () => {
    for (const failedSection of ["settings", "css", "datastore"]) {
        const plain = { plugins: { Sound: { volume: 20 } } };
        const writes: string[] = [];
        const failure = new Error("Storage unavailable");
        let rejectWrite: ((error: Error) => void) | undefined;
        const write = async (section: string) => {
            writes.push(section);
            if (section === failedSection) await new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
        };
        const modules: Record<string, unknown> = {
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@api/Settings": { PlainSettings: plain, DefaultSettings: defaultSettings },
            "@utils/Logger": { Logger: class {} },
            "@utils/web": {},
            "@webpack/common": {},
            "..": { DataStore: { setMany: () => write("datastore") } }
        };
        const { importSettings } = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, structuredClone, require: (name: string) => modules[name],
            VencordNative: { settings: { set: () => write("settings") }, quickCss: { set: () => write("css") } }
        });
        const pending = importSettings('{"settings":{"plugins":{"Sound":{"volume":70}}},"quickCss":"new","dataStore":[["key",1]]}');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(rejectWrite);
        assert.equal(plain.plugins.Sound.volume, failedSection === "settings" ? 20 : 70);
        plain.plugins.Sound.volume = 90;
        rejectWrite(failure);
        await assert.rejects(pending, (error: unknown) => {
            assert.ok(error !== null && typeof error === "object" && "message" in error && "cause" in error);
            assert.match(String(error.message), /Some changes may already have been applied/);
            assert.equal(error.cause, failure);
            return true;
        });
        assert.equal(plain.plugins.Sound.volume, 90);
        assert.deepEqual(writes, ["settings", "css", "datastore"].slice(0, ["settings", "css", "datastore"].indexOf(failedSection) + 1));
    }
});

test("cloud settings imports stage changes and reject newer persisted settings", async () => {
    for (const change of ["none", "persisted", "cloud", "renderer"]) {
        const plain = { cloud: { settingsSyncVersion: 1, url: "https://first.invalid" }, plugins: { Sound: { volume: 20 } } };
        let persisted = { ...structuredClone(plain), otherWindow: true };
        let release: (() => void) | undefined;
        let changed = false;
        const modules: Record<string, unknown> = {
            "@api/Settings": { PlainSettings: plain, DefaultSettings: defaultSettings },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class {} },
            "..": { DataStore: { entries: async () => [] } }
        };
        const api = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, structuredClone, require: (name: string) => modules[name] ?? {},
            VencordNative: {
                settings: {
                    get: () => structuredClone(persisted),
                    set: async (next: typeof persisted, _path?: string, expected?: string) => {
                        await new Promise<void>(resolve => { release = resolve; });
                        if (JSON.stringify(persisted) !== expected) throw new Error("Settings conflict");
                        persisted = structuredClone(next);
                    }
                },
                quickCss: { get: async () => "" }
            }
        });
        const expected = await api.captureCloudImportState();
        const pending = api.importSettings('{"settings":{"plugins":{"Sound":{"volume":70}}}}', "all", true, () => {
            if (changed) throw new Error("Local edit");
        }, expected);
        assert.equal(plain.plugins.Sound.volume, 20);
        assert.equal(persisted.plugins.Sound.volume, 20);
        assert.ok(release);
        if (change === "persisted") persisted.plugins.Sound.volume = 90;
        if (change === "cloud") persisted.cloud.url = "https://second.invalid";
        if (change === "renderer") {
            plain.plugins.Sound.volume = 90;
            changed = true;
        }
        release();
        if (change === "none") {
            await pending;
            assert.equal(plain.plugins.Sound.volume, 70);
            assert.equal(expected.settings, JSON.stringify(persisted));
        } else {
            await assert.rejects(pending, /Settings import did not finish/);
            assert.equal(plain.plugins.Sound.volume, change === "renderer" ? 90 : 20);
            if (change === "persisted") assert.equal(persisted.plugins.Sound.volume, 90);
            if (change === "cloud") assert.equal(persisted.cloud.url, "https://second.invalid");
        }
        assert.equal(persisted.otherWindow, true);
    }
});

test("backups read only requested sections and never omit failed required data", async () => {
    const reads: string[] = [];
    const notifications: { type: string; }[] = [];
    const failure = new Error("Database read failed");
    let failedSection = "datastore";
    let saves = 0;
    const read = (section: string, value: unknown) => {
        reads.push(section);
        if (failedSection === section) throw failure;
        return value;
    };
    const modules: Record<string, unknown> = {
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/web": { saveFile: () => { saves++; } },
        "@webpack/common": { Toasts: { show: (toast: { type: string }) => notifications.push(toast), genId: () => "test", Type: { FAILURE: "failure", MESSAGE: "message" } } },
        "..": { DataStore: { entries: async () => read("datastore", [["audio", { name: "saved" }]]) } }
    };
    const { exportSettings, downloadSettingsBackup } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name], IS_DISCORD_DESKTOP: false,
        VencordNative: { settings: { get: () => read("plugins", { plugins: {} }) }, quickCss: { get: async () => read("css", "") } }
    });
    await assert.rejects(exportSettings({}), (error: unknown) => error === failure);
    await assert.rejects(downloadSettingsBackup("all"), (error: unknown) => error === failure);
    assert.equal(saves, 0);
    assert.deepEqual(notifications.map(value => value.type), ["failure"]);
    for (const [type, expected, failing] of [
        ["plugins", { settings: { plugins: {} } }, "css"],
        ["css", { quickCss: "" }, "plugins"],
        ["datastore", { dataStore: [["audio", { name: "saved" }]] }, "plugins"]
    ] as const) {
        reads.length = 0;
        failedSection = failing;
        assert.deepEqual(JSON.parse(await exportSettings({ type })), expected);
        assert.deepEqual(reads, [type]);
    }
    failedSection = "datastore";
    reads.length = 0;
    assert.deepEqual(JSON.parse(await exportSettings({ syncDataStore: false })), { settings: { plugins: {} }, quickCss: "" });
    assert.deepEqual(reads, ["plugins", "css"]);
});

test("backups reject DataStore values that JSON would silently discard or change", async () => {
    let entries: unknown = [];
    let files = 0;
    const modules: Record<string, unknown> = {
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/web": { saveFile: () => { files++; } },
        "@webpack/common": { Toasts: { show() {}, genId: () => "test", Type: { FAILURE: "failure" } } },
        "..": { DataStore: { entries: async () => entries } }
    };
    const { exportSettings, downloadSettingsBackup } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name], IS_DISCORD_DESKTOP: false,
        VencordNative: { settings: { get: () => ({}) }, quickCss: { get: async () => "" } }
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [new Uint8Array([1, 2]).buffer, new Uint8Array([1]), new Blob(["saved icon"]), new Date(0), new Map([["saved", 1]]), new Set([1]), Infinity, NaN, undefined, 1n, cyclic]) {
        entries = [["saved", { nested: value }]];
        await assert.rejects(exportSettings({ type: "datastore" }), /JSON backup format cannot preserve/);
        await assert.rejects(downloadSettingsBackup("all"), /JSON backup format cannot preserve/);
    }
    entries = [[Infinity, "saved"]];
    await assert.rejects(exportSettings({ type: "datastore" }), /JSON backup format cannot preserve/);
    assert.equal(files, 0);
    entries = [["saved", { list: [null, true, 2, "text"], empty: {} }]];
    assert.deepEqual(JSON.parse(await exportSettings({ type: "datastore" })), { dataStore: entries });
});

test("cloud data round trips the aggregate DataStore record and empty CSS", async () => {
    const nativeSettings = { plugins: {}, cloud: { url: "https://local.invalid", authenticated: true, settingsSyncVersion: 1 } };
    const records: [string, unknown][] = [["CustomSounds", { saved: true }], ["VoiceStats", { seconds: 42 }]];
    const syncedRecords = records.slice();
    const localKeys = ["Vencord_cloudSecret", "Vencord_cloudManifest", "Vencord_cloudApiVersions", "Vencord_cloudManifest:https://first.invalid:first", "Vencord_cloudManifest:https://second.invalid:second"];
    for (const key of localKeys) records.push([key, { local: true }]);
    const writes: unknown[] = [];
    const css: string[] = [];
    const modules: Record<string, unknown> = {
        "@shared/readResponseText": jsonResponseReader,
        "@api/DataStore": { entries: async () => records, set: async (key: string, value: unknown) => writes.push([key, value]) },
        "@api/Notifications": {},
        "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
        "@utils/localStorage": {},
        "@utils/Logger": { Logger: class {} },
        "@utils/native": {},
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@utils/web": {},
        "@webpack/common": {},
        fflate: {},
        "./cloudSetup": {},
        "..": { DataStore: { setMany: async (entries: unknown) => writes.push(entries) } }
    };
    const globals = {
        require: (name: string) => modules[name], TextEncoder, TextDecoder, Uint8Array, atob,
        VencordNative: { settings: { get: () => nativeSettings, set: async () => {} }, quickCss: { get: async () => "", set: async (value: string) => css.push(value) } }
    };
    const offline = runInNewContext(`${outputText}\nexports;`, { structuredClone, ...globals, exports: {} });
    modules["./offline"] = offline;
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const { buildLocalData, applyDownloads } = runInNewContext(`${compiled}\n({ buildLocalData, applyDownloads: downloads => applyDownloads(downloads, { assertCurrent() {} }) });`, { ...globals, exports: {} });
    const local = await buildLocalData();
    const settingsJson = new TextDecoder().decode(local.get("settings"));
    assert.deepEqual(JSON.parse(settingsJson), { plugins: {} });
    nativeSettings.cloud.settingsSyncVersion++;
    assert.equal(new TextDecoder().decode((await buildLocalData()).get("settings")), settingsJson, "A local sync timestamp must not change the uploaded settings checksum");
    assert.deepEqual(JSON.parse(await offline.exportSettings({ type: "plugins", cloud: true })), { settings: { plugins: {} } });
    assert.deepEqual(JSON.parse(await offline.exportSettings({ type: "plugins" })), { settings: nativeSettings });
    assert.equal(local.has("quickCss"), true, "Cleared CSS must replace an older cloud value");
    assert.equal(new TextDecoder().decode(local.get("quickCss")), "");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(local.get("dataStore"))), syncedRecords);
    const download = (key: string, value: string) => ({ key, value: Buffer.from(value).toString("base64") });
    assert.equal(await applyDownloads([
        download("dataStore", JSON.stringify(records)),
        download("quickCss", "")
    ]), true);
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [syncedRecords]);
    assert.deepEqual(css, [""]);
    await applyDownloads([download("dataStore/legacy", '{"kept":true}')]);
    assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1))), [["legacy", { kept: true }]]);
    for (const aggregateFirst of [true, false]) {
        const aggregate = download("dataStore", '[["shared",1],["aggregate",true]]');
        const legacy = download("dataStore/shared", "2");
        const before = writes.length;
        assert.equal(await applyDownloads(aggregateFirst ? [aggregate, legacy] : [legacy, aggregate]), true);
        assert.equal(writes.length, before + 1, "All DataStore entries use one validated batch");
        const restored = new Map<string, unknown>(JSON.parse(JSON.stringify(writes.at(-1))));
        assert.equal(restored.get("shared"), aggregateFirst ? 2 : 1);
        assert.equal(restored.get("aggregate"), true);
    }
    const count = writes.length;
    await applyDownloads(localKeys.map(key => download(`dataStore/${key}`, '{"remote":true}')));
    assert.equal(writes.length, count, "Remote data must not replace local credentials or sync bookkeeping");
    await assert.rejects(applyDownloads([download("dataStore", '[[null,1]]')]));
    assert.equal(writes.length, count);
    await offline.importSettings(JSON.stringify({ settings: {}, dataStore: records }), "all", true);
    assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1))), syncedRecords, "Legacy cloud bundles also preserve local credentials");
    await offline.importSettings(JSON.stringify({ dataStore: records }), "datastore");
    assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1))), records, "Explicit offline restores retain their existing complete-record behavior");
    records.push(["binary", new Uint8Array([1, 2]).buffer]);
    await assert.rejects(buildLocalData(), /JSON backup format cannot preserve/);
});

test("cloud checkpoints preserve persisted fields and reject intervening settings writes", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const direction of ["getCloudSettings", "putCloudSettings"]) for (const stage of ["none", "response", "checkpoint"]) {
        const plain = { cloud: { settingsSyncVersion: 1 }, plugins: { Sound: { value: "original" } } };
        let persisted = { ...structuredClone(plain), cloud: { ...plain.cloud, otherWindow: true }, otherWindow: true };
        const storage = { Vencord_settingsDirty: "true" };
        const notifications: { color: string }[] = [];
        let manifests = 0;
        let edited = false;
        const store = {
            get: async (key: string) => key === "Vencord_cloudApiVersions" ? { "https://first.invalid": version } : undefined,
            entries: async () => [], set: async () => manifests++
        };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": store, "..": { DataStore: store },
            "@api/Settings": { PlainSettings: plain, Settings: plain, DefaultSettings: defaultSettings },
            "@api/Notifications": { showNotification: (value: { color: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const remote = { plugins: { Sound: { value: "remote" } } };
        const globals = {
            require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, atob, btoa, crypto, IS_WEB: true,
            VencordNative: {
                settings: {
                    get: () => structuredClone(persisted),
                    set: async (next: typeof persisted, _path?: string, expected?: string) => {
                        if (stage === "checkpoint" && next.cloud.settingsSyncVersion !== 1) {
                            persisted.plugins.Sound.value = "newer";
                            edited = true;
                        }
                        if (JSON.stringify(persisted) !== expected) throw new Error("Settings conflict");
                        persisted = structuredClone(next);
                    }
                },
                quickCss: { get: async () => "" }
            },
            fetch: async () => {
                if (stage === "response") {
                    persisted.plugins.Sound.value = "newer";
                    edited = true;
                }
                return {
                    ok: true, status: 200, headers: { get: () => "2" },
                    json: async () => ({ written: 2, errors: [], uploaded: [], server_manifest: [], downloads: [{ key: "settings", version: 2, checksum: "synthetic", value: btoa(JSON.stringify(remote)) }] }),
                    body: compressedBody(async () => JSON.stringify({ settings: remote }))
                };
            }
        };
        modules["./offline"] = runInNewContext(`${outputText}\nexports;`, { ...globals, exports: {}, structuredClone });
        const api = runInNewContext(`${compiled}\nexports;`, { ...globals, exports: {} });
        await api[direction](true);
        assert.equal(persisted.otherWindow, true);
        assert.equal(persisted.cloud.otherWindow, true);
        assert.equal(plain.cloud.settingsSyncVersion, edited ? 1 : persisted.cloud.settingsSyncVersion);
        assert.equal(edited, stage !== "none");
        assert.equal(persisted.plugins.Sound.value, edited ? "newer" : version === "v1" && direction === "putCloudSettings" ? "original" : "remote");
        assert.equal(storage.Vencord_settingsDirty, edited ? "true" : undefined);
        assert.equal(manifests, !edited && version === "v2" ? 1 : 0);
        assert.equal(notifications.some(({ color }) => color === "var(--red-360)"), edited);
        assert.equal(notifications.length, 1);
    }
});

test("cloud JSON failures do not copy response contents into logs or notifications", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const scenario of ["get", "put", "delete", "timestamp", "settings", "dataStore", "dataStore/legacy"]) {
        const legacy = scenario === "timestamp";
        const writes: string[] = [];
        const logs: string[] = [];
        const notifications: { body: string; color?: string }[] = [];
        const plain = { cloud: { settingsSyncVersion: 1 } };
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": { readResponseText },
            "@api/DataStore": { get: async () => legacy ? { "https://first.invalid": "v1" } : undefined, entries: async () => [], set: async () => writes.push("manifest") },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { body: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error(...args: unknown[]) { logs.push(args.map(String).join(" ")); } } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), exportSettings: async () => "{}", omitCloudSettings: () => ({}), serializeDataStore: JSON.stringify, isLocalDataStoreKey: () => false, importSettings: async () => writes.push("import") },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, Uint8Array, btoa, atob, crypto,
            VencordNative: { settings: { get: () => plain, set: async () => writes.push("settings") }, quickCss: { get: async () => "" } },
            fetch: async () => ["settings", "dataStore", "dataStore/legacy"].includes(scenario)
                ? Response.json({ server_manifest: [], uploaded: [], errors: [], downloads: [{ key: scenario, version: 1, checksum: "test", value: btoa("SECRET_DO_NOT_LOG") }] })
                : new Response("SECRET_DO_NOT_LOG")
        });
        if (scenario === "put" || legacy) await api.putCloudSettings(true);
        else if (scenario === "delete") await api.deleteCloudSettings();
        else assert.equal(await api.getCloudSettings(true), false);
        assert.deepEqual(writes, [], scenario);
        assert.equal(plain.cloud.settingsSyncVersion, 1);
        assert.equal(storage.Vencord_settingsDirty, "true");
        assert.equal(notifications[0]?.color, "var(--red-360)");
        assert.equal(logs.length, 1);
        assert.doesNotMatch(logs.join(" ") + JSON.stringify(notifications), /SECRET/, scenario);
        assert.match(notifications[0].body, /invalid JSON/i);
    }
});

test("cloud JSON responses stop oversized streams before writes and allow retry", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const operation of ["getCloudSettings", "putCloudSettings", "deleteCloudSettings", "putV1"]) {
        const legacy = operation === "putV1";
        const limit = (legacy ? 1 : 128) * 1024 * 1024;
        let oversized = true;
        let cancelled = false;
        let sent = 0;
        let response: Response | undefined;
        const writes: string[] = [];
        const notifications: { color?: string }[] = [];
        const plain = { cloud: { settingsSyncVersion: 1 } };
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": { readResponseText },
            "@api/DataStore": { get: async () => legacy ? { "https://first.invalid": "v1" } : undefined, entries: async () => [], set: async () => writes.push("manifest") },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { color?: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), exportSettings: async () => "{}", omitCloudSettings: () => ({}), serializeDataStore: JSON.stringify },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, Uint8Array, btoa, crypto,
            VencordNative: { settings: { get: () => plain, set: async () => writes.push("settings") }, quickCss: { get: async () => "" } },
            fetch: async () => {
                const value = legacy ? { written: 2 } : operation === "deleteCloudSettings" ? { entries: [] } : { server_manifest: [], downloads: [], uploaded: [], errors: [] };
                if (!oversized) return Response.json(value);
                const prefix = new TextEncoder().encode(JSON.stringify(value));
                const chunk = new Uint8Array(64 * 1024).fill(32);
                response = new Response(new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (sent === 0) { controller.enqueue(prefix); sent += prefix.length; return; }
                        if (sent === limit + 1) { controller.close(); return; }
                        const count = Math.min(chunk.length, limit + 1 - sent);
                        controller.enqueue(chunk.subarray(0, count));
                        sent += count;
                    },
                    cancel() { cancelled = true; }
                }, { highWaterMark: 0 }), { headers: { "Content-Length": "1" } });
                return response;
            }
        });
        const run = () => api[legacy ? "putCloudSettings" : operation](true);
        await run();
        assert.deepEqual(writes, [], operation);
        assert.equal(cancelled, true, operation);
        assert.equal(response?.body?.locked, false);
        assert.equal(plain.cloud.settingsSyncVersion, 1);
        assert.equal(storage.Vencord_settingsDirty, "true");
        assert.equal(notifications[0]?.color, "var(--red-360)");
        oversized = false;
        notifications.length = 0;
        await run();
        assert.ok(notifications.length > 0, "A retry must not be blocked by the failed request");
        assert.notEqual(notifications[0]?.color, "var(--red-360)");
    }
});

test("legacy downloads bound compressed and expanded bytes before importing", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const limit = 128 * 1024 * 1024;
    const text = JSON.stringify({ settings: { plugins: { Test: { text: "\u20ac\u{1f98a}".repeat(7000) } } } });
    const normal = deflateSync(new TextEncoder().encode(text));
    const chunks: Uint8Array[] = [];
    const compressor = new Deflate(chunk => chunks.push(chunk));
    compressor.push(new TextEncoder().encode("{}"));
    const padding = new Uint8Array(1024 * 1024).fill(32);
    for (let written = 2; written < limit + 1; written += padding.length)
        compressor.push(padding.subarray(0, Math.min(padding.length, limit + 1 - written)));
    compressor.push(new Uint8Array(), true);
    const expanded = Buffer.concat(chunks);
    for (const failure of ["expanded", "compressed", "truncated", "invalid", "empty", "read", "none"]) {
        let retry = false;
        let cancelled = false;
        let response: Response | undefined;
        const imports: string[] = [];
        let saves = 0;
        const notifications: { color?: string }[] = [];
        const plain = { cloud: { settingsSyncVersion: 1 } };
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": { readResponseText },
            "@api/DataStore": { get: async () => ({ "https://first.invalid": "v1" }) },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { color?: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), importSettings: async (value: string) => { JSON.parse(value); imports.push(value); } },
        };
        const { getCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextDecoder, Uint8Array, TransformStream, DecompressionStream, Response, IS_WEB: true,
            VencordNative: { settings: { get: () => ({}), set: async () => saves++ } },
            fetch: async () => {
                const mode = retry ? "none" : failure;
                const bytes = mode === "expanded" ? expanded : mode === "truncated" ? normal.subarray(0, -1) : mode === "invalid" ? new Uint8Array([255]) : normal;
                let position = 0;
                response = new Response(new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (mode === "read") { controller.error(new Error("Interrupted body")); return; }
                        if (mode === "empty") { controller.close(); return; }
                        if (mode === "compressed") {
                            const block = new Uint8Array(65540).fill(32);
                            block.set([0, 255, 255, 0, 0]);
                            if (position === 0) block.set([123, 125], 5);
                            controller.enqueue(block);
                            position += block.length;
                            return;
                        }
                        if (position >= bytes.length) { if (mode !== "expanded") controller.close(); return; }
                        const end = mode === "expanded" ? bytes.length : Math.min(position + 7, bytes.length);
                        controller.enqueue(bytes.subarray(position, end));
                        position = end;
                    },
                    cancel() { cancelled = true; }
                }, { highWaterMark: 0 }), { headers: { etag: "2", "Content-Length": "1" } });
                return response;
            }
        });
        assert.equal(await getCloudSettings(), failure === "none", failure);
        assert.equal(saves, failure === "none" ? 1 : 0, failure);
        assert.deepEqual(imports, failure === "none" ? [text] : [], failure);
        if (failure !== "none") {
            assert.equal(plain.cloud.settingsSyncVersion, 1);
            assert.equal(storage.Vencord_settingsDirty, "true");
            assert.equal(notifications[0]?.color, "var(--red-360)");
            await new Promise<void>(resolve => setImmediate(resolve));
            if (failure === "expanded" || failure === "compressed") assert.equal(cancelled, true, failure);
            assert.equal(response?.body?.locked, false);
            retry = true;
            assert.equal(await getCloudSettings(), true);
            assert.deepEqual(imports, [text]);
        }
    }
});

test("cloud downloads validate every record before writing any section", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const download = (key: string, text: string) => ({ key, value: btoa(text) });
    for (const invalid of [
        download("settings", "{"), download("settings", '{"plugins":false}'),
        download("dataStore", "null"), download("dataStore", "[[null,1]]"),
        download("dataStore/legacy", "{"), download("dataStore/legacy", '{"__proto__":{"enabled":true}}'),
        { key: "dataStore", value: "%" }, download("quickCss", "duplicate")
    ]) {
        const writes: string[] = [];
        const plain = { plugins: {} };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/Settings": { PlainSettings: plain, DefaultSettings: defaultSettings },
            "@api/DataStore": { set: async () => writes.push("legacy") },
            "..": { DataStore: { setMany: async () => writes.push("datastore") } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class {} }
        };
        const globals = {
            require: (name: string) => modules[name] ?? {}, TextDecoder, Uint8Array, atob,
            VencordNative: { settings: { set: async () => writes.push("settings") }, quickCss: { set: async () => writes.push("css") } }
        };
        modules["./offline"] = runInNewContext(`${outputText}\nexports;`, { ...globals, exports: {} });
        const applyDownloads = runInNewContext(`${compiled}\n(downloads => applyDownloads(downloads, { assertCurrent() {} }));`, { ...globals, exports: {} });
        const valid = [download("quickCss", "first")];
        if (invalid.key !== "settings") valid.push(download("settings", '{"plugins":{"Sound":{"enabled":false}}}'));
        await assert.rejects(applyDownloads([...valid, invalid]));
        assert.deepEqual(writes, [], invalid.key);
        assert.deepEqual(plain, { plugins: {} });
    }
});

test("legacy cloud sync waits for local settings persistence before reporting success", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const direction of ["putV1", "getV1"]) {
        const notifications: unknown[] = [];
        const storage: Record<string, string> = { Vencord_settingsDirty: "true" };
        const plain = { cloud: { settingsSyncVersion: 1 } };
        const saveStarted = Promise.withResolvers<void>();
        let rejectSave: ((reason: Error) => void) | undefined;
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": {},
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/native": {},
            "@webpack/common": {},
            fflate: { deflateSync: (value: Uint8Array) => value },
            "./cloudSetup": { getCloudUrl: () => new URL("https://sync.invalid"), getCloudAuth: async () => "test" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), exportSettings: async (options: { cloud?: boolean }) => { assert.equal(options.cloud, true); return "{}"; }, importSettings: async () => {} }
        };
        const entry = runInNewContext(`${compiled}\n({ putV1, getV1 });`, {
            exports: {}, require: (name: string) => modules[name], URL, AbortSignal, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, Uint8Array, IS_WEB: true,
            fetch: async () => ({ ok: true, status: 200, json: async () => ({ written: 2 }), headers: { get: () => "2" }, body: compressedBody(async () => "{}") }),
            VencordNative: { settings: { get: () => ({}), set: () => new Promise<void>((_resolve, reject) => { rejectSave = reject; saveStarted.resolve(); }) } }
        });
        let settled = false;
        const pending = entry[direction]({ url: new URL("https://sync.invalid"), assertCurrent() {} }, true, true).then(
            () => { settled = true; },
            (error: unknown) => { settled = true; return error; }
        );
        await Promise.race([saveStarted.promise, pending]);
        assert.ok(rejectSave);
        assert.equal(settled, false, `${direction} must await the local save`);
        assert.equal(notifications.length, 0);
        assert.equal(storage.Vencord_settingsDirty, "true");
        const failure = new Error("Failed to save settings.");
        rejectSave(failure);
        assert.equal(await pending, failure);
        assert.equal(notifications.length, 0);
        assert.equal(storage.Vencord_settingsDirty, "true");
    }
});

test("legacy sync rejects invalid timestamps without treating local edit times as cache validators", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const force of [false, true]) for (const direction of ["getCloudSettings", "putCloudSettings"]) for (const written of [7, undefined, null, "", "wrong", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 2, 8]) {
        const valid = written === 0 || written === 2 || written === 7 || written === 8;
        const applied = valid && (direction === "putCloudSettings" || force || written >= 7);
        let saves = 0;
        let imports = 0;
        let bodyReads = 0;
        let requestHeaders: RequestInit["headers"];
        const notifications: { color?: string }[] = [];
        const plain = { cloud: { settingsSyncVersion: 7 } };
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async () => ({ "https://first.invalid": "v1" }) },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { color?: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), exportSettings: async () => "{}", importSettings: async () => imports++ },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, IS_WEB: true,
            VencordNative: { settings: { get: () => ({}), set: async () => saves++ } },
            fetch: async (_url: URL, init: RequestInit) => {
                requestHeaders = init.headers;
                if (direction === "getCloudSettings" && written === 7 && new Headers(init.headers).get("If-None-Match") === "7")
                    return { ok: false, status: 304 };
                return {
                    ok: true, status: 200, json: async () => ({ written }),
                    headers: { get: () => written == null ? null : String(written) },
                    body: compressedBody(async () => { bodyReads++; return "{}"; })
                };
            }
        });
        await api[direction](true, force);
        assert.equal(saves, applied ? 1 : 0, `${direction}/${String(written)}`);
        assert.equal(imports, applied && direction === "getCloudSettings" ? 1 : 0);
        assert.equal(bodyReads, imports);
        assert.equal(plain.cloud.settingsSyncVersion, applied ? written : 7);
        assert.equal(storage.Vencord_settingsDirty, applied ? undefined : "true");
        assert.equal(notifications.length, 1);
        if (!valid) assert.equal(notifications[0].color, "var(--red-360)");
        if (direction === "getCloudSettings") assert.equal(new Headers(requestHeaders).has("If-None-Match"), false);
    }
});

test("cloud configuration changes persist locally without changing sync timestamps or scheduling uploads", () => {
    for (const file of ["src/api/Settings.ts", "src/Vencord.ts"]) {
        const source = createSourceFile(file, readFileSync(file, "utf8"), ScriptTarget.Latest, true);
        let listener: Node | undefined;
        const visit = (node: Node) => {
            if (!listener && isCallExpression(node) && isPropertyAccessExpression(node.expression)
                && node.expression.name.text === "addGlobalChangeListener") listener = node.arguments[0];
            node.forEachChild(visit);
        };
        visit(source);
        assert.ok(listener);
        const compiled = transpileModule(`const listener = ${listener.getText(source)};`, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        for (const path of ["cloud", "cloud.url", "cloud.authenticated", "cloud.settingsSync", "cloud.settingsSyncVersion", "", "plugins.Sound.enabled", "themeLinks", "cloudish"]) {
            const plain = { cloud: { settingsSyncVersion: 5 } };
            let saves = 0;
            let dirty = 0;
            let scheduled = 0;
            const callback = runInNewContext(`${compiled}\nlistener;`, {
                SettingsStore: { plain }, Date: { now: () => 100 },
                VencordNative: { settings: { set: async () => { saves++; } } },
                markLocalSettingsDirty: () => dirty++, saveSettingsOnFrequentAction: () => scheduled++
            });
            callback(plain, path);
            const cloudOnly = path === "cloud" || path.startsWith("cloud.");
            if (file === "src/api/Settings.ts") {
                assert.equal(saves, 1);
                assert.equal(plain.cloud.settingsSyncVersion, cloudOnly ? 5 : 100, path);
            } else {
                assert.equal(dirty, cloudOnly ? 0 : 1, path);
                assert.equal(scheduled, dirty, path);
            }
        }
    }
});

test("startup tracks edits before credential lookup and after initially disconnected or failed startup", async () => {
    const source = createSourceFile("Vencord.ts", readFileSync("src/Vencord.ts", "utf8"), ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === "syncSettings");
    assert.ok(declaration);
    const compiled = transpileModule(declaration.getText(source), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const fail of [false, true]) {
        let finishRead: ((value: unknown) => void) | undefined;
        let rejectRead: ((reason: Error) => void) | undefined;
        let dirty = 0;
        let queued = 0;
        let uploads = 0;
        let scheduled: (() => Promise<void>) | undefined;
        const listeners: ((data: unknown, path: string) => void)[] = [];
        const settings = { cloud: { authenticated: false, settingsSync: true } };
        const syncSettings = runInNewContext(`${compiled}\nsyncSettings;`, {
            Settings: settings,
            SettingsStore: { addGlobalChangeListener: (callback: (data: unknown, path: string) => void) => listeners.push(callback) },
            UserStore: { getCurrentUser: () => ({ id: "first" }) },
            getAuthorization: () => new Promise((resolve, reject) => { finishRead = resolve; rejectRead = reject; }),
            debounce: (callback: () => Promise<void>) => { scheduled = callback; return () => queued++; },
            markLocalSettingsDirty: () => dirty++, shouldCloudSync: () => true,
            putCloudSettings: async () => uploads++
        });
        const pending: Promise<void> = syncSettings();
        assert.equal(listeners.length, 1, "Tracking must exist before the first startup await");
        listeners[0](settings, "plugins.Sound.enabled");
        assert.equal(dirty, 1);
        assert.equal(queued, 1);
        assert.ok(finishRead);
        assert.ok(rejectRead);
        if (fail) {
            const rejected = assert.rejects(pending, /Synthetic read failure/);
            rejectRead(new Error("Synthetic read failure"));
            await rejected;
        } else {
            finishRead(undefined);
            await pending;
        }
        assert.ok(scheduled);
        await scheduled();
        assert.equal(uploads, 0);
        settings.cloud.authenticated = true;
        listeners[0](settings, "plugins.Sound.enabled");
        await scheduled();
        assert.equal(dirty, 2);
        assert.equal(uploads, 1, "Connecting later must not require restarting to track subsequent edits");
        assert.equal(listeners.length, 1);
    }
});

test("automatic cloud upload retries a busy operation and rechecks sync preferences", async () => {
    const source = createSourceFile("Vencord.ts", readFileSync("src/Vencord.ts", "utf8"), ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === "syncSettings");
    assert.ok(declaration);
    const compiled = transpileModule(declaration.getText(source), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    let scheduled: (() => Promise<void>) | undefined;
    let queued = 0;
    let uploads = 0;
    let busy = true;
    let signedIn = false;
    const settings = { cloud: { authenticated: false, settingsSync: true } };
    const syncSettings = runInNewContext(`${compiled}\nsyncSettings;`, {
        Settings: settings, SettingsStore: { addGlobalChangeListener() {} },
        UserStore: { getCurrentUser: () => signedIn ? { id: "first" } : undefined },
        getAuthorization: async () => "synthetic", areLocalSettingsDirty: () => true, getCloudSyncDirection: () => "both",
        debounce: (callback: () => Promise<void>, delay: number) => { assert.equal(delay, 60_000); scheduled = callback; return () => queued++; },
        shouldCloudSync: () => true,
        putCloudSettings: async () => { uploads++; return busy ? false : undefined; }
    });
    await syncSettings();
    assert.ok(scheduled);
    settings.cloud.authenticated = true;
    await scheduled();
    assert.equal(queued, 1, "A busy cloud operation must not consume the only scheduled upload");
    settings.cloud.settingsSync = false;
    await scheduled();
    assert.equal(uploads, 1, "A retry must honor disabled sync");
    settings.cloud.settingsSync = true;
    busy = false;
    await scheduled();
    assert.equal(uploads, 2);
    assert.equal(queued, 1, "Completed attempts must not create a retry loop");
    signedIn = true;
    busy = true;
    await syncSettings();
    assert.equal(queued, 2, "Startup must also reschedule an upload blocked by another operation");
});

test("startup uses the current account credential and discards lookup results after owner changes", async () => {
    const source = createSourceFile("Vencord.ts", readFileSync("src/Vencord.ts", "utf8"), ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === "syncSettings");
    assert.ok(declaration);
    const compiled = transpileModule(declaration.getText(source), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const secret of [undefined, "", 17, "synthetic"]) for (const change of ["none", "account", "service", "logged-out"]) {
        let userId = change === "logged-out" ? undefined : "first";
        let pulls = 0;
        let notifications = 0;
        const settings = { cloud: { authenticated: true, settingsSync: true, url: "https://first.invalid" } };
        const lookup = async () => {
            if (change === "account") userId = "second";
            if (change === "service") settings.cloud.url = "https://second.invalid";
            return secret;
        };
        const syncSettings = runInNewContext(`${compiled}\nsyncSettings;`, {
            Settings: settings, SettingsStore: { addGlobalChangeListener: () => {} },
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            dsGet: async () => { await lookup(); return { "https://other.invalid:other": "unrelated" }; },
            getAuthorization: lookup,
            debounce: () => () => {}, getCloudSyncDirection: () => "both", shouldCloudSync: () => true,
            areLocalSettingsDirty: () => false, getCloudSettings: async () => { pulls++; return false; },
            showNotification: () => notifications++, SettingsRouter: {}
        });
        await syncSettings();
        const valid = secret === "synthetic";
        assert.equal(pulls, valid && change === "none" ? 1 : 0);
        assert.equal(notifications, !valid && change === "none" ? 1 : 0);
        assert.equal(settings.cloud.authenticated, valid || change !== "none");
    }
});

test("automatic cloud sync uses the displayed default and respects each direction", () => {
    const { outputText } = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const storage: Record<string, string> = {};
    const { shouldCloudSync } = runInNewContext(`${outputText}\nexports;`, {
        exports: {},
        require: (name: string) => name === "@utils/localStorage"
            ? { localStorage: new Proxy(storage, { get: (target, key: string) => key === "getItem" ? (key: string) => target[key] ?? null : target[key] }) }
            : name === "@utils/Logger" ? { Logger: class { } } : {}
    });
    for (const [direction, push, pull] of [[undefined, true, true], ["both", true, true], ["push", true, false], ["pull", false, true], ["manual", false, false]] as const) {
        if (direction === undefined) delete storage.Vencord_cloudSyncDirection;
        else storage.Vencord_cloudSyncDirection = direction;
        assert.equal(shouldCloudSync("push"), push, `${direction}: push`);
        assert.equal(shouldCloudSync("pull"), pull, `${direction}: pull`);
    }
});

test("desktop backup exports await native saving and report rejected saves", async () => {
    const notifications: { type: string; }[] = [];
    const modules: Record<string, unknown> = {
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/web": {},
        "@webpack/common": {
            moment: () => ({ format: () => "2026-09-26" }),
            Toasts: { show: (toast: { type: string }) => notifications.push(toast), genId: () => "test", Type: { FAILURE: "failure" } }
        },
        "..": { DataStore: {} }
    };
    let finishSave: ((value: unknown) => void) | undefined;
    let failSave: ((error: Error) => void) | undefined;
    const { downloadSettingsBackup } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name], IS_DISCORD_DESKTOP: true, TextEncoder,
        VencordNative: { settings: { get: () => ({ plugins: {} }) } },
        DiscordNative: { fileManager: { saveWithDialog: (data: Uint8Array, filename: string) => {
            assert.equal(filename, "lawyercord-plugins-backup-2026-09-26.json");
            assert.deepEqual(JSON.parse(new TextDecoder().decode(data)), { settings: { plugins: {} } });
            return new Promise<unknown>((resolve, reject) => { finishSave = resolve; failSave = reject; });
        } } }
    });
    for (const reject of [false, true]) {
        let settled = false;
        const failure = new Error("Native save failed");
        const outcome = downloadSettingsBackup("plugins").then(
            () => { settled = true; },
            (error: unknown) => { settled = true; return error; }
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false, "Export must remain pending while native saving is pending");
        assert.ok(finishSave);
        assert.ok(failSave);
        if (reject) failSave(failure);
        else finishSave(undefined);
        assert.equal(await outcome, reject ? failure : undefined);
    }
    assert.deepEqual(notifications.map(value => value.type), ["failure"]);
});

test("failed cloud downloads and deletions do not advance the manifest or report success", async () => {
    const { outputText } = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    let writes = 0;
    let notifications: { color: string; }[] = [];
    let response: unknown;
    let importFails = true;
    let saveFails = false;
    const events: string[] = [];
    const modules: Record<string, unknown> = {
        "@shared/readResponseText": jsonResponseReader,
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/DataStore": { get: async () => undefined, entries: async () => [], set: async () => { events.push("manifest"); writes++; } },
        "@api/Notifications": { showNotification: (data: { color: string; }) => notifications.push(data) },
        "@api/Settings": { PlainSettings: { cloud: {} } },
        "@utils/localStorage": { localStorage: {} },
        "@utils/Logger": { Logger: class { info() { } error() { } } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
        "./cloudSetup": { getCloudUrl: () => new URL("https://cloud.example"), getCloudAuth: async () => "test" },
        "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), omitCloudSettings: (settings: object) => settings, serializeDataStore: JSON.stringify, importSettings: async () => { if (importFails) throw new Error("Import failed"); } }
    };
    const { getCloudSettings, putCloudSettings, deleteCloudSettings } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, atob, btoa, crypto, IS_WEB: true,
        fetch: async (_url: URL, init: RequestInit) => init.method === "DELETE"
            ? { ok: false, status: 500 }
            : { ok: true, json: async () => response },
        VencordNative: { settings: { get: () => ({}), set: async () => { events.push("settings"); if (saveFails) throw new Error("Save failed"); writes++; } }, quickCss: { get: async () => "" } }
    });
    for (const [downloads, errors] of [
        [[{ key: "settings", version: 2, checksum: "synthetic", value: btoa("{}") }], []],
        [[], [{ key: "settings", error: "Server failed" }]]
    ]) {
        response = { downloads, errors, server_manifest: [], uploaded: [] };
        notifications = [];
        assert.equal(await getCloudSettings(), false);
        assert.equal(writes, 0);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].color, "var(--red-360)");
    }
    response = { entries: [{ key: "settings", version: 1, checksum: "synthetic" }] };
    notifications = [];
    await deleteCloudSettings();
    assert.equal(writes, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].color, "var(--red-360)");
    importFails = false;
    response = { downloads: [{ key: "settings", version: 2, checksum: "synthetic", value: btoa("{}") }], errors: [], server_manifest: [{ key: "settings", version: 2, checksum: "synthetic" }], uploaded: [] };
    for (const sync of [getCloudSettings, putCloudSettings]) {
        writes = 0;
        events.length = 0;
        notifications = [];
        saveFails = true;
        await sync(true);
        assert.equal(writes, 0, "Failed settings persistence must not acknowledge the cloud manifest");
        assert.deepEqual(events, ["settings"]);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].color, "var(--red-360)");
        events.length = 0;
        notifications = [];
        saveFails = false;
        await sync(true);
        assert.deepEqual(events, ["settings", "manifest"]);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].color, "var(--green-360)");
    }
});

test("cloud uploads and downloads discard obsolete responses and stop subsequent writes", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const direction of ["getCloudSettings", "putCloudSettings"]) {
        const stages = ["version", "auth", "response", "body", "checkpoint"];
        if (version === "v2" || direction === "getCloudSettings") stages.push("settings", "css", "datastore");
        if (version === "v2") stages.push("manifest-save");
        for (const change of ["account", "service", "none"]) for (const stage of stages) {
            let userId = "first";
            let service = "https://first.invalid";
            let changed = false;
            let settingsSaves = 0;
            const events: string[] = [];
            const storage = { Vencord_settingsDirty: "true" };
            const plain = { cloud: { settingsSyncVersion: 1, authenticated: true }, plugins: { Sound: { enabled: true } } };
            const pause = async (event: string) => {
                events.push(event);
                assert.equal(changed, false, `Unexpected ${event} after ${version}/${direction}/${change}/${stage}`);
                if (event === stage && change !== "none") {
                    changed = true;
                    if (change === "account") userId = "second";
                    else service = "https://second.invalid";
                }
            };
            const bundle = { settings: { plugins: { Sound: { enabled: false } } }, quickCss: "", dataStore: [["plugin", 1]] };
            const store = {
                get: async (key: string) => { if (key === "Vencord_cloudApiVersions") { await pause("version"); return { "https://first.invalid": version }; } },
                entries: async () => [],
                set: async () => pause("manifest-save"),
                setMany: async () => pause("datastore"),
                updateMany: async (entries: [unknown, (value: unknown) => unknown][]) => { entries.forEach(([, update]) => update(undefined)); await pause("datastore"); }
            };
            const modules: Record<string, unknown> = {
                "@shared/readResponseText": jsonResponseReader,
                "@api/DataStore": store,
                "..": { DataStore: store },
                "@api/Notifications": { showNotification: () => { events.push("notification"); assert.equal(changed, false); } },
                "@api/Settings": { PlainSettings: plain, Settings: plain, DefaultSettings: defaultSettings },
                "@utils/localStorage": { localStorage: storage },
                "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
                "@utils/Logger": { Logger: class { info() {} error() {} } },
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
                fflate: { deflateSync: (value: Uint8Array) => value },
                "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => { await pause("auth"); return "synthetic"; } }
            };
            const globals = {
                require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, Uint8Array, atob, btoa, crypto, IS_WEB: true,
                VencordNative: {
                    settings: { get: () => plain, set: async () => pause(++settingsSaves === 1 && (version === "v2" || direction === "getCloudSettings") ? "settings" : "checkpoint") },
                    quickCss: { get: async () => "", set: async () => pause("css") }
                },
                fetch: async (url: URL) => {
                    assert.equal(url.origin, "https://first.invalid");
                    await pause("response");
                    return {
                        ok: true, status: 200, headers: { get: () => "2" },
                        body: compressedBody(async () => { await pause("body"); return JSON.stringify(bundle); }),
                        json: async () => {
                            await pause("body");
                            return { written: 2, errors: [], uploaded: [], server_manifest: [], downloads: Object.entries(bundle).map(([key, value]) => ({ key, version: 2, checksum: "synthetic", value: btoa(key === "quickCss" ? String(value) : JSON.stringify(value)) })) };
                        }
                    };
                }
            };
            modules["./offline"] = runInNewContext(`${outputText}\nexports;`, { structuredClone, ...globals, exports: {} });
            const api = runInNewContext(`${compiled}\nexports;`, { ...globals, exports: {} });
            await api[direction]();
            assert.ok(events.includes(stage), `${version}/${direction}/${stage} must be exercised`);
            if (change !== "none") {
                assert.equal(events.at(-1), stage);
                assert.equal(storage.Vencord_settingsDirty, "true");
            } else {
                assert.equal(storage.Vencord_settingsDirty, undefined);
            }
        }
    }
});

test("cloud sync preserves edits made while responses or local saves are pending", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const direction of ["getCloudSettings", "putCloudSettings"]) for (const stage of ["response", "save"]) {
        const plain = { cloud: { settingsSyncVersion: 1 }, plugins: { Sound: { value: "original" } } };
        const storage: Record<string, unknown> = { Vencord_settingsDirty: "true" };
        storage.setItem = (key: string, value: string) => { storage[key] = value; };
        let markChanged = () => {};
        let edited = false;
        let retry = false;
        let manifests = 0;
        const notifications: { color: string }[] = [];
        const edit = () => {
            plain.plugins.Sound.value = "newer";
            edited = true;
            markChanged();
        };
        const store = {
            get: async (key: string) => key === "Vencord_cloudApiVersions" ? { "https://first.invalid": version } : undefined,
            entries: async () => [], set: async () => manifests++
        };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": store, "..": { DataStore: store },
            "@api/Settings": { PlainSettings: plain, Settings: plain, DefaultSettings: defaultSettings },
            "@api/Notifications": { showNotification: (value: { color: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const remote = { plugins: { Sound: { value: "remote" } } };
        const entry = { key: "settings", checksum: "synthetic", version: 2 };
        const globals = {
            require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, atob, btoa, crypto, IS_WEB: true,
            VencordNative: { settings: { get: () => plain, set: async () => { if (stage === "save" && !edited) edit(); } }, quickCss: { get: async () => "" } },
            fetch: async (_url: URL, init: RequestInit) => {
                if (stage === "response" && !edited) edit();
                if (retry) {
                    const payload = version === "v2"
                        ? JSON.parse(atob(JSON.parse(String(init.body)).uploads.find((entry: { key: string }) => entry.key === "settings").value))
                        : JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).settings;
                    assert.equal(payload.plugins.Sound.value, "newer");
                }
                return {
                    ok: true, status: 200, headers: { get: () => "2" },
                    json: async () => ({ written: 2, errors: [], uploaded: [], server_manifest: [entry], downloads: retry ? [] : [{ ...entry, value: btoa(JSON.stringify(remote)) }] }),
                    body: compressedBody(async () => JSON.stringify({ settings: remote }))
                };
            }
        };
        modules["./offline"] = runInNewContext(`${outputText}\nexports;`, { structuredClone, ...globals, exports: {} });
        const api = runInNewContext(`${compiled}\nexports;`, { ...globals, exports: {} });
        markChanged = api.markLocalSettingsDirty;
        await api[direction](true);
        assert.equal(edited, true);
        assert.equal(plain.plugins.Sound.value, "newer", `${version}/${direction}/${stage}`);
        assert.equal(storage.Vencord_settingsDirty, "true");
        assert.equal(manifests, 0);
        assert.deepEqual(notifications.map(value => value.color), ["var(--red-360)"]);
        retry = true;
        await api.putCloudSettings(true);
        assert.equal(plain.plugins.Sound.value, "newer");
        assert.equal(storage.Vencord_settingsDirty, undefined);
        assert.equal(manifests, version === "v2" ? 1 : 0);
        assert.equal(notifications.length, 2);
    }
});

test("cloud operations cannot overlap and a completed or failed operation releases the next attempt", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const operations = ["getCloudSettings", "putCloudSettings", "deleteCloudSettings", "eraseAllCloudData"];
    for (const first of operations) for (const second of operations) for (const fail of [false, true]) {
        let requests = 0;
        let signalStarted = () => {};
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        let finish: ((value: unknown) => void) | undefined;
        let reject: ((error: Error) => void) | undefined;
        const notifications: { body: string }[] = [];
        const plain = { cloud: { authenticated: true, settingsSyncVersion: 1 } };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async () => undefined, entries: async () => [], set: async () => {} },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { body: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: {} },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic", deauthorizeCloud: async () => {} },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), omitCloudSettings: (value: object) => value, serializeDataStore: JSON.stringify }
        };
        const response = { ok: true, json: async () => ({ errors: [], uploaded: [], downloads: [], server_manifest: [], entries: [] }) };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextEncoder, crypto, btoa,
            VencordNative: { settings: { get: () => plain, set: async () => {} }, quickCss: { get: async () => "" } },
            fetch: async () => {
                requests++;
                return requests === 1 ? new Promise((resolve, fail) => { finish = resolve; reject = fail; signalStarted(); }) : response;
            }
        });
        const pending = api[first](first !== "getCloudSettings");
        await started;
        assert.ok(finish);
        assert.ok(reject);
        const blocked = await api[second](true);
        if (second === "putCloudSettings") assert.equal(blocked, false);
        assert.equal(requests, 1, second);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0].body, /still running/);
        if (fail) reject(new Error("Synthetic network failure"));
        else finish(response);
        await pending;
        await api.getCloudSettings(false);
        assert.equal(requests, 2, "The operation must release its slot even after failure");
    }
});

test("cloud request timeouts cover response bodies and release the operation for retry", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const operation of ["getCloudSettings", "putCloudSettings", "deleteCloudSettings", "eraseAllCloudData"]) for (const stage of ["headers", "body"]) {
        if (stage === "body" && (operation === "eraseAllCloudData" || (version === "v1" && operation === "deleteCloudSettings"))) continue;
        const controllers: AbortController[] = [];
        let signal: AbortSignal | null | undefined;
        let requests = 0;
        let writes = 0;
        const notifications: unknown[] = [];
        let retry = false;
        let signalStarted = () => {};
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        const stall = (signal: AbortSignal | null | undefined) => new Promise<never>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        const plain = { cloud: { authenticated: true, settingsSyncVersion: 1 } };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async (key: string) => key === "Vencord_cloudApiVersions" ? { "https://first.invalid": version } : undefined, entries: async () => [], set: async () => writes++ },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@utils/localStorage": { localStorage: {} },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic", deauthorizeCloud: async () => {} },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), omitCloudSettings: (value: object) => value, serializeDataStore: JSON.stringify, exportSettings: async () => "{}", importSettings: async () => writes++ },
            fflate: { deflateSync: (value: Uint8Array) => value }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextEncoder, TextDecoder, TransformStream, DecompressionStream, Response, crypto, btoa,
            AbortSignal: { timeout: (milliseconds: number) => { assert.equal(milliseconds, 120_000); const controller = new AbortController(); controllers.push(controller); return controller.signal; } },
            VencordNative: { settings: { get: () => plain, set: async () => writes++ }, quickCss: { get: async () => "" } },
            fetch: async (_url: URL, init: RequestInit) => {
                requests++;
                signal = init.signal;
                signalStarted();
                if (!retry && stage === "headers") return stall(signal);
                return {
                    ok: true, status: 200, headers: { get: () => "2" },
                    json: async () => retry ? { written: 2, errors: [], uploaded: [], downloads: [], server_manifest: [], entries: [] } : stall(signal),
                    body: compressedBody(async () => retry ? "{}" : stall(signal))
                };
            }
        });
        const pending = api[operation](false);
        await started;
        assert.ok(signal, `${version}/${operation}/${stage} must have a timeout signal`);
        assert.equal(controllers.length, 1);
        controllers[0].abort(new Error("Synthetic timeout"));
        await pending;
        assert.equal(writes, 0);
        assert.equal(notifications.length, 1, "Timeouts must reach the public failure handler");
        retry = true;
        await api[operation](false);
        assert.equal(requests, 2);
        assert.equal(controllers.length, 2);
    }
});

test("obsolete cloud failures cannot deauthorize another account or start fallback requests", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const status of [401, 404, 500]) for (const during of ["response", "fallback"]) {
        if (during === "fallback" && (version !== "v2" || status !== 404)) continue;
        let service = "https://first.invalid";
        let requests = 0;
        let notifications = 0;
        let updates = 0;
        const plain = { cloud: { authenticated: true, settingsSyncVersion: 1 } };
        const versions: Record<string, string> = { "https://first.invalid": version };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": {
                get: async (key: string) => key === "Vencord_cloudApiVersions" ? versions : [],
                update: async (_key: string, updater: (map: Record<string, string>) => unknown) => {
                    updates++;
                    service = "https://second.invalid";
                    updater(versions);
                }
            },
            "@api/Notifications": { showNotification: () => notifications++ },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }) }
        };
        const { getCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
            fetch: async () => { requests++; if (during === "response") service = "https://second.invalid"; return { status, ok: false }; }
        });
        assert.equal(await getCloudSettings(), false);
        assert.equal(requests, 1);
        assert.equal(notifications, 0);
        assert.equal(plain.cloud.authenticated, true);
        assert.equal(updates, during === "fallback" ? 1 : 0);
        assert.equal(versions["https://second.invalid"], undefined);
        if (during === "fallback") assert.equal(versions["https://first.invalid"], "v1");
    }
});

test("invalid cloud response envelopes fail before local writes or manifest acknowledgment", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const entry = { key: "settings", version: 1, checksum: "synthetic" };
    const valid = { errors: [], uploaded: [], server_manifest: [entry], downloads: [{ ...entry, value: btoa("{}") }] };
    for (const response of [
        { ...valid, downloads: [...valid.downloads, { ...entry, key: "unsupported", value: "" }] },
        { ...valid, downloads: [...valid.downloads, { ...entry, key: "dataStore/", value: "" }] },
        { ...valid, server_manifest: null }, { ...valid, uploaded: null }, { ...valid, errors: {} },
        { ...valid, downloads: [...valid.downloads, { ...entry, value: 17 }] },
        { ...valid, server_manifest: [{ ...entry, version: "wrong" }] },
        { ...valid, server_manifest: [{ ...entry, checksum: null }] },
        null, [], {}
    ]) {
        const writes: string[] = [];
        const notifications: { color: string }[] = [];
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async () => undefined, set: async () => writes.push("manifest") },
            "@api/Settings": { PlainSettings: { cloud: {} } },
            "@api/Notifications": { showNotification: (value: { color: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), importSettings: async () => writes.push("import") }
        };
        const { getCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextDecoder, atob, IS_WEB: true,
            VencordNative: { settings: { set: async () => writes.push("settings") } },
            fetch: async () => ({ ok: true, json: async () => response })
        });
        assert.equal(await getCloudSettings(), false);
        assert.deepEqual(writes, []);
        assert.equal(storage.Vencord_settingsDirty, "true");
        assert.deepEqual(notifications.map(value => value.color), ["var(--red-360)"]);
    }
});

test("cloud manifests belong to one account and service without claiming the ownerless legacy record", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    let userId = "first";
    let service = "https://first.invalid";
    const legacy = [{ key: "settings", version: 999, checksum: "ownerless" }];
    const records = new Map<string, unknown>([["Vencord_cloudManifest", legacy]]);
    const observed: unknown[] = [];
    const contexts = [["first", "https://first.invalid"], ["second", "https://first.invalid"], ["first", "https://second.invalid"]];
    const modules: Record<string, unknown> = {
        "@shared/readResponseText": jsonResponseReader,
        "@api/DataStore": { get: async (key: string) => records.get(key), set: async (key: string, value: unknown) => { records.set(key, value); } },
        "@api/Notifications": { showNotification: () => {} },
        "@api/Settings": { PlainSettings: { cloud: {} } },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@utils/localStorage": { localStorage: {} },
        "@utils/Logger": { Logger: class { info() {} error() {} } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => "synthetic" },
        "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }), importSettings: async () => {} }
    };
    const manifest = () => [{ key: "settings", version: 1, checksum: `${service}/${userId}` }];
    const { getCloudSettings, deleteCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal, TextDecoder, atob, IS_WEB: true,
        VencordNative: { settings: { get: () => ({}), set: async () => {} } },
        fetch: async (url: URL, init: RequestInit) => {
            if (url.pathname === "/v2/sync") {
                observed.push(JSON.parse(String(init.body)).client_manifest);
                return { ok: true, json: async () => ({ errors: [], uploaded: [], server_manifest: manifest(), downloads: [{ key: "settings", version: 2, checksum: "synthetic", value: btoa("{}") }] }) };
            }
            return { ok: true, json: async () => ({ entries: [] }) };
        }
    });
    for (const expectedExisting of [false, true]) for (const [user, url] of contexts) {
        userId = user;
        service = url;
        assert.equal(await getCloudSettings(false), true);
        assert.deepEqual(observed.at(-1), expectedExisting ? manifest() : []);
    }
    userId = "first";
    service = "https://first.invalid";
    await deleteCloudSettings();
    for (const [user, url] of contexts) {
        userId = user;
        service = url;
        await getCloudSettings(false);
        assert.deepEqual(observed.at(-1), user === "first" && url === "https://first.invalid" ? [] : manifest());
    }
    assert.equal(records.get("Vencord_cloudManifest"), legacy, "The old record has no known account owner and must remain untouched");
});

test("cloud deletion stops when its account or service changes", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const version of ["v1", "v2"]) for (const change of ["account", "service", "none"]) {
        const stages = version === "v1" ? ["version", "auth", "delete"] : ["version", "auth", "manifest", "body", "delete", "manifest-save", "settings-save"];
        for (const stage of stages) {
            let userId = "first";
            let service = "https://first.invalid";
            const events: string[] = [];
            const plain = { cloud: { settingsSyncVersion: 5 } };
            const pause = async (event: string) => {
                events.push(event);
                if (event === stage) {
                    if (change === "account") userId = "second";
                    if (change === "service") service = "https://second.invalid";
                }
            };
            const modules: Record<string, unknown> = {
                "@shared/readResponseText": jsonResponseReader,
                "@api/DataStore": {
                    get: async () => { await pause("version"); return { "https://first.invalid": version, "https://second.invalid": version }; },
                    set: async () => pause("manifest-save")
                },
                "@api/Notifications": { showNotification: () => events.push("notification") },
                "@api/Settings": { PlainSettings: plain, Settings: plain },
                "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
                "@utils/Logger": { Logger: class { info() {} error() {} } },
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
                "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => { await pause("auth"); return "synthetic"; } }
            };
            const { deleteCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
                exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
                VencordNative: { settings: { get: () => ({}), set: async () => pause("settings-save") } },
                fetch: async (url: URL, init: RequestInit) => {
                    assert.equal(url.origin, "https://first.invalid", "Authorization must never move to another service");
                    await pause(init.method === "DELETE" ? "delete" : "manifest");
                    return { ok: true, json: async () => { await pause("body"); return { entries: [{ key: "settings", version: 1, checksum: "synthetic" }] }; } };
                }
            });
            await deleteCloudSettings();
            const expected = change === "none" ? [...stages, "notification"] : stages.slice(0, stages.indexOf(stage) + 1);
            assert.deepEqual(events, expected, `${version}, ${change}, ${stage}`);
            if (change !== "none" && !["manifest-save", "settings-save"].includes(stage))
                assert.equal(plain.cloud.settingsSyncVersion, 5);
        }
    }
});

test("cloud deletion validates the complete manifest before deleting any entries", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const manifest of [null, {}, { entries: null }, { entries: [{ key: "valid", version: 1, checksum: "synthetic" }, { version: 1, checksum: "synthetic" }] }]) {
        let deletes = 0;
        let writes = 0;
        let notifications = 0;
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async () => undefined, set: async () => writes++ },
            "@api/Notifications": { showNotification: () => notifications++ },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" }
        };
        const { deleteCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
            fetch: async (_url: URL, init: RequestInit) => { if (init.method === "DELETE") deletes++; return { ok: true, json: async () => manifest }; }
        });
        await deleteCloudSettings();
        assert.equal(deletes, 0);
        assert.equal(writes, 0);
        assert.equal(notifications, 1);
    }
});

test("cloud deletion sends one request at a time and stops after failure or owner changes", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const change of ["none", "http", "throw", "account", "service"]) {
        let userId = "first";
        let service = "https://first.invalid";
        const plain = { cloud: { settingsSyncVersion: 7 } };
        const deletes: string[] = [];
        const writes: string[] = [];
        const notifications: { color?: string }[] = [];
        const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
        let requests = 0;
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { get: async () => undefined, set: async () => writes.push("manifest") },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { color?: string }) => notifications.push(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
            "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => "synthetic" },
            "./offline": { captureCloudImportState: async () => ({ quickCss: "", dataStore: new Map() }) }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
            VencordNative: { settings: { get: () => ({}), set: async () => writes.push("settings") } },
            fetch: async (url: URL, init: RequestInit) => {
                requests++;
                if (init.method === "DELETE") {
                    deletes.push(url.href);
                    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
                }
                return { ok: true, json: async () => ({ entries: ["a", "b", "c"].map(key => ({ key, version: 1, checksum: "synthetic" })), errors: [], uploaded: [], downloads: [], server_manifest: [] }) };
            }
        });
        let settled = false;
        const operation = api.deleteCloudSettings().then(() => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(deletes, ["https://first.invalid/v2/data/a"]);
        assert.equal(settled, false);
        await api.getCloudSettings(false);
        assert.equal(requests, 2, "Pending deletion still owns the operation");
        const first = pending.shift();
        assert.ok(first);
        if (change === "account") userId = "second";
        if (change === "service") service = "https://second.invalid";
        if (change === "throw") first.reject(new Error("Synthetic network failure"));
        else first.resolve({ ok: change !== "http", status: change === "http" ? 500 : 204 });
        await new Promise<void>(resolve => setImmediate(resolve));
        if (change === "none") {
            for (const key of ["b", "c"]) {
                assert.equal(deletes.at(-1), `https://first.invalid/v2/data/${key}`);
                assert.equal(pending.length, 1);
                const next = pending.shift();
                assert.ok(next);
                next.resolve({ ok: key !== "b", status: key === "b" ? 404 : 204 });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            assert.deepEqual(writes, ["manifest", "settings"]);
            assert.equal(plain.cloud.settingsSyncVersion, 0);
            assert.equal(notifications.at(-1)?.color, "var(--green-360)");
        } else {
            assert.equal(deletes.length, 1);
            assert.deepEqual(writes, []);
            assert.equal(plain.cloud.settingsSyncVersion, 7);
            assert.equal(notifications.length, change === "account" || change === "service" ? 0 : 1);
        }
        await operation;
        const beforeRetry = requests;
        await api.getCloudSettings(false);
        assert.equal(requests, beforeRetry + 1, "Completion releases the operation");
    }
});

test("cloud erasure stops after account or service changes without affecting the new owner", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const fail of ["none", "throw", "http"]) for (const change of ["account", "service", "none"]) for (const stage of ["auth", "response", "deauthorize", "manifest"]) {
        if (fail === "http" && stage !== "response") continue;
        let userId = "first";
        let service = "https://first.invalid";
        const events: string[] = [];
        const settings = { cloud: { authenticated: true } };
        const pause = async (event: string) => {
            events.push(event);
            if (event === stage) {
                if (change === "account") userId = "second";
                if (change === "service") service = "https://second.invalid";
                if (fail === "throw") throw new Error("Synthetic failure");
            }
        };
        const modules: Record<string, unknown> = {
            "@shared/readResponseText": jsonResponseReader,
            "@api/DataStore": { set: async () => pause("manifest") },
            "@api/Settings": { Settings: settings },
            "@api/Notifications": { showNotification: () => events.push("notification") },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
            "./cloudSetup": {
                getCloudUrl: () => new URL(service),
                getCloudAuth: async () => { await pause("auth"); return "synthetic"; },
                deauthorizeCloud: async () => { assert.equal(userId, "first"); assert.equal(service, "https://first.invalid"); await pause("deauthorize"); }
            }
        };
        const { eraseAllCloudData } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, AbortSignal,
            fetch: async (url: URL) => { assert.equal(url.origin, "https://first.invalid"); await pause("response"); return { ok: fail !== "http", status: fail === "http" ? 500 : 200 }; }
        });
        await eraseAllCloudData();
        const stages = ["auth", "response", "deauthorize", "manifest", "notification"];
        const completed = stages.slice(0, stages.indexOf(stage) + 1);
        assert.deepEqual(events, change === "none" ? (fail !== "none" ? [...completed, "notification"] : stages) : completed, `${fail}/${change}/${stage}`);
        if (change !== "none" && ["auth", "response"].includes(stage)) assert.equal(settings.cloud.authenticated, true);
    }
});

test("backup imports await file reading, preserve empty CSS, and never log backup content", async () => {
    const css: string[] = [];
    const logs: unknown[] = [];
    const notifications: unknown[] = [];
    let finishRead: ((value: string) => void) | undefined;
    const modules: Record<string, unknown> = {
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
        "@utils/Logger": { Logger: class { error() { } } },
        "@utils/web": { chooseFile: async () => ({ text: () => new Promise<string>(resolve => { finishRead = resolve; }) }) },
        "@webpack/common": { Toasts: { show: (toast: unknown) => notifications.push(toast), genId: () => "test", Type: { SUCCESS: "success", FAILURE: "failure" } } },
        "..": { DataStore: { setMany: async () => { } } }
    };
    const { importSettings, uploadSettingsBackup } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, structuredClone, require: (name: string) => modules[name], IS_DISCORD_DESKTOP: false,
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

test("cloud imports preserve CSS and DataStore edits made after their snapshot", async () => {
    for (const change of ["css", "updated", "deleted", "created", "none"]) {
        let css = "original";
        const records = new Map<string, unknown>([["first", 0], ["second", "original"]]);
        const store = {
            entries: async () => [...records],
            updateMany: async (entries: [string, (value: unknown) => unknown][]) => {
                const updates = entries.map(([key, update]) => [key, update(records.get(key))] as const);
                updates.forEach(([key, value]) => records.set(key, value));
            }
        };
        const modules: Record<string, unknown> = {
            "..": { DataStore: store },
            "@api/Settings": { PlainSettings: {}, DefaultSettings: defaultSettings },
            "@utils/Logger": { Logger: class {} },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) }
        };
        const api = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, structuredClone, require: (name: string) => modules[name] ?? {},
            VencordNative: { settings: { get: () => ({}) }, quickCss: {
                get: async () => css,
                set: async (value: string, expected?: string) => {
                    if (expected !== undefined && css !== expected) throw new Error("CSS conflict");
                    css = value;
                }
            } }
        });
        const expected = await api.captureCloudImportState();
        if (change === "css") css = "new local edit";
        if (change === "updated") records.set("second", "new local edit");
        if (change === "deleted") records.delete("second");
        if (change === "created") records.set("third", "new local edit");
        const dataStore = [["first", 1], ["second", "remote"], ["third", "remote"], ["first", 2], ["VencordQuickCss", "duplicate CSS"]];
        const importing = api.importSettings(JSON.stringify({ quickCss: "remote CSS", dataStore }), "all", true, undefined, expected);
        if (change === "none") {
            await importing;
            assert.equal(css, "remote CSS");
            assert.equal(records.get("first"), 2, "Repeated keys retain last-record precedence");
            assert.equal(records.get("second"), "remote");
            assert.equal(records.has("VencordQuickCss"), false, "CSS must not be written again through the DataStore payload");
        } else {
            await assert.rejects(importing, /did not finish/);
            assert.equal(records.get("first"), 0, "A conflict must not commit earlier DataStore entries");
            if (change === "css") assert.equal(css, "new local edit");
            if (change === "updated") assert.equal(records.get("second"), "new local edit");
            if (change === "deleted") assert.equal(records.has("second"), false);
            if (change === "created") assert.equal(records.get("third"), "new local edit");
        }
    }
});
