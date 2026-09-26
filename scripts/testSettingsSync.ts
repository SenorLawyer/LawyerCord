/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isCallExpression, isPropertyAccessExpression, isVariableStatement, JsxEmit, ModuleKind, type Node, ScriptTarget, transpileModule } from "typescript";

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

test("obsolete cloud authorization callbacks cannot save credentials or change authentication", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSetup.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "cloudSetup.tsx"
    }).outputText;
    for (const change of ["storage", "config-status", "config-shape", "config-protocol", "callback-origin", "callback-path", "callback-status", "read", "configuration", "account", "service", "deauthorize", "newer", "invalid", "none"]) {
        let userId = "first";
        const settings = { cloud: { url: "https://first.invalid", authenticated: false } };
        const requests: ((value: unknown) => void)[] = [];
        const notifications: unknown[] = [];
        let modal: { callback: (value: { location: string }) => Promise<void> } | undefined;
        let records: Record<string, string> = {};
        const modules: Record<string, unknown> = {
            "@api/DataStore": { get: async () => { if (change === "storage") throw new Error("Storage unavailable"); return { ...records }; }, update: async (_key: string, fn: (value: Record<string, string>) => Record<string, string>) => { records = fn(records); } },
            "@api/Settings": { Settings: settings },
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, OAuth2AuthorizeModal: "modal", openModal: (render: (props: object) => typeof modal) => { modal = render({}); } }
        };
        const { authorizeCloud, deauthorizeCloud } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL,
            React: { createElement: (_type: unknown, props: unknown) => props },
            fetch: () => new Promise(resolve => requests.push(resolve))
        });
        const configuration = { ok: change !== "config-status", status: 500, json: async () => change === "config-shape" ? null : ({ clientId: "test", redirectUri: change === "config-protocol" ? "javascript:alert(1)" : "https://first.invalid/callback" }) };
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
        if (change === "configuration") userId = "second";
        requests.shift()?.(configuration);
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
        let newer: Promise<void> | undefined;
        if (change === "account") userId = "second";
        if (change === "service") settings.cloud.url = "https://second.invalid";
        if (change === "deauthorize") await deauthorizeCloud();
        if (change === "newer") {
            newer = authorizeCloud();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        finishResponse({ ok: change !== "callback-status", status: 500, json: async () => ({ secret: change === "invalid" ? 17 : "synthetic" }) });
        await pending;
        if (change === "none") {
            assert.deepEqual(records, { "https://first.invalid:first": "synthetic" });
            assert.equal(settings.cloud.authenticated, true);
            assert.equal(notifications.length, 1);
            continue;
        }
        if (change === "invalid" || change === "callback-status") {
            assert.deepEqual(records, {});
            assert.equal(settings.cloud.authenticated, false);
            assert.equal(notifications.length, 1);
            continue;
        }
        assert.deepEqual(records, {}, change);
        assert.equal(settings.cloud.authenticated, false, change);
        assert.equal(notifications.length, 0, change);
        if (newer) {
            requests.shift()?.(configuration);
            await newer;
        }
    }
});

test("desktop settings saves preserve the previous file and store when disk writes fail", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "lawyercord-settings-"));
    const file = join(directory, "settings.json");
    const initial = { plugins: { Sound: { volume: 20 } } };
    fs.writeFileSync(file, JSON.stringify(initial));
    const handlers = new Map<string, (event: unknown, value: unknown, path?: string) => void>();
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
            electron: { ipcMain: { handle: (name: string, handler: (event: unknown, value: unknown, path?: string) => void) => handlers.set(name, handler), on() {} } },
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
        exports: {}, require: (name: string) => modules[name],
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
            exports: {}, require: (name: string) => modules[name],
            VencordNative: { settings: { set: () => write("settings") }, quickCss: { set: () => write("css") } }
        });
        const pending = importSettings('{"settings":{"plugins":{"Sound":{"volume":70}}},"quickCss":"new","dataStore":[["key",1]]}');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(rejectWrite);
        assert.equal(plain.plugins.Sound.volume, 70);
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
    const offline = runInNewContext(`${outputText}\nexports;`, { ...globals, exports: {} });
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
    assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1))), ["legacy", { kept: true }]);
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

test("legacy cloud sync waits for local settings persistence before reporting success", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const direction of ["putV1", "getV1"]) {
        const notifications: unknown[] = [];
        const storage: Record<string, string> = { Vencord_settingsDirty: "true" };
        const plain = { cloud: { settingsSyncVersion: 1 } };
        let rejectSave: ((reason: Error) => void) | undefined;
        const modules: Record<string, unknown> = {
            "@api/DataStore": {},
            "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/native": {},
            "@webpack/common": {},
            fflate: { deflateSync: (value: Uint8Array) => value, inflateSync: (value: Uint8Array) => value },
            "./cloudSetup": { getCloudUrl: () => new URL("https://sync.invalid"), getCloudAuth: async () => "test" },
            "./offline": { exportSettings: async (options: { cloud?: boolean }) => { assert.equal(options.cloud, true); return "{}"; }, importSettings: async () => {} }
        };
        const entry = runInNewContext(`${compiled}\n({ putV1, getV1 });`, {
            exports: {}, require: (name: string) => modules[name], URL, TextEncoder, TextDecoder, Uint8Array, IS_WEB: true,
            fetch: async () => ({ ok: true, status: 200, json: async () => ({ written: 2 }), headers: { get: () => "2" }, arrayBuffer: async () => new TextEncoder().encode("{}").buffer }),
            VencordNative: { settings: { set: () => new Promise<void>((_resolve, reject) => { rejectSave = reject; }) } }
        });
        let settled = false;
        const pending = entry[direction]({ url: new URL("https://sync.invalid"), assertCurrent() {} }, true, true).then(
            () => { settled = true; },
            (error: unknown) => { settled = true; return error; }
        );
        await new Promise<void>(resolve => setImmediate(resolve));
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

test("legacy sync rejects invalid timestamps and forced downloads bypass cache validation", async () => {
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const force of [false, true]) for (const direction of ["getCloudSettings", "putCloudSettings"]) for (const written of [undefined, null, "", "wrong", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 2, 8]) {
        const valid = written === 0 || written === 2 || written === 8;
        const applied = valid && (direction === "putCloudSettings" || force || written >= 7);
        let saves = 0;
        let imports = 0;
        let bodyReads = 0;
        let requestHeaders: RequestInit["headers"];
        const notifications: { color?: string }[] = [];
        const plain = { cloud: { settingsSyncVersion: 7 } };
        const storage = { Vencord_settingsDirty: "true" };
        const modules: Record<string, unknown> = {
            "@api/DataStore": { get: async () => ({ "https://first.invalid": "v1" }) },
            "@api/Settings": { PlainSettings: plain, Settings: plain },
            "@api/Notifications": { showNotification: (value: { color?: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { exportSettings: async () => "{}", importSettings: async () => imports++ },
            fflate: { deflateSync: (value: Uint8Array) => value, inflateSync: (value: Uint8Array) => value }
        };
        const api = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextEncoder, TextDecoder, IS_WEB: true,
            VencordNative: { settings: { set: async () => saves++ } },
            fetch: async (_url: URL, init: RequestInit) => {
                requestHeaders = init.headers;
                return {
                    ok: true, status: 200, json: async () => ({ written }),
                    headers: { get: () => written == null ? null : String(written) },
                    arrayBuffer: async () => { bodyReads++; return new TextEncoder().encode("{}").buffer; }
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
        if (direction === "getCloudSettings") assert.equal(new Headers(requestHeaders).has("If-None-Match"), !force);
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
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@api/DataStore": { get: async () => undefined, entries: async () => [], set: async () => { events.push("manifest"); writes++; } },
        "@api/Notifications": { showNotification: (data: { color: string; }) => notifications.push(data) },
        "@api/Settings": { PlainSettings: { cloud: {} } },
        "@utils/localStorage": { localStorage: {} },
        "@utils/Logger": { Logger: class { info() { } error() { } } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
        "./cloudSetup": { getCloudUrl: () => new URL("https://cloud.example"), getCloudAuth: async () => "test" },
        "./offline": { omitCloudSettings: (settings: object) => settings, serializeDataStore: JSON.stringify, importSettings: async () => { if (importFails) throw new Error("Import failed"); } }
    };
    const { getCloudSettings, putCloudSettings, deleteCloudSettings } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextEncoder, TextDecoder, atob, btoa, crypto, IS_WEB: true,
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
                setMany: async () => pause("datastore")
            };
            const modules: Record<string, unknown> = {
                "@api/DataStore": store,
                "..": { DataStore: store },
                "@api/Notifications": { showNotification: () => { events.push("notification"); assert.equal(changed, false); } },
                "@api/Settings": { PlainSettings: plain, Settings: plain, DefaultSettings: defaultSettings },
                "@utils/localStorage": { localStorage: storage },
                "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
                "@utils/Logger": { Logger: class { info() {} error() {} } },
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
                fflate: { deflateSync: (value: Uint8Array) => value, inflateSync: (value: Uint8Array) => value },
                "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => { await pause("auth"); return "synthetic"; } }
            };
            const globals = {
                require: (name: string) => modules[name] ?? {}, URL, TextEncoder, TextDecoder, Uint8Array, atob, btoa, crypto, IS_WEB: true,
                VencordNative: {
                    settings: { get: () => plain, set: async () => pause(++settingsSaves === 1 && (version === "v2" || direction === "getCloudSettings") ? "settings" : "checkpoint") },
                    quickCss: { get: async () => "", set: async () => pause("css") }
                },
                fetch: async (url: URL) => {
                    assert.equal(url.origin, "https://first.invalid");
                    await pause("response");
                    return {
                        ok: true, status: 200, headers: { get: () => "2" },
                        arrayBuffer: async () => { await pause("body"); return new TextEncoder().encode(JSON.stringify(bundle)).buffer; },
                        json: async () => {
                            await pause("body");
                            return { written: 2, errors: [], uploaded: [], server_manifest: [], downloads: Object.entries(bundle).map(([key, value]) => ({ key, version: 2, checksum: "synthetic", value: btoa(key === "quickCss" ? String(value) : JSON.stringify(value)) })) };
                        }
                    };
                }
            };
            modules["./offline"] = runInNewContext(`${outputText}\nexports;`, { ...globals, exports: {} });
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
            "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => "synthetic" }
        };
        const { getCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL,
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
            "@api/DataStore": { get: async () => undefined, set: async () => writes.push("manifest") },
            "@api/Settings": { PlainSettings: { cloud: {} } },
            "@api/Notifications": { showNotification: (value: { color: string }) => notifications.push(value) },
            "@utils/localStorage": { localStorage: storage },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" },
            "./offline": { importSettings: async () => writes.push("import") }
        };
        const { getCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextDecoder, atob, IS_WEB: true,
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
        "@api/DataStore": { get: async (key: string) => records.get(key), set: async (key: string, value: unknown) => { records.set(key, value); } },
        "@api/Notifications": { showNotification: () => {} },
        "@api/Settings": { PlainSettings: { cloud: {} } },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@utils/localStorage": { localStorage: {} },
        "@utils/Logger": { Logger: class { info() {} error() {} } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./cloudSetup": { getCloudUrl: () => new URL(service), getCloudAuth: async () => "synthetic" },
        "./offline": { importSettings: async () => {} }
    };
    const manifest = () => [{ key: "settings", version: 1, checksum: `${service}/${userId}` }];
    const { getCloudSettings, deleteCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextDecoder, atob, IS_WEB: true,
        VencordNative: { settings: { set: async () => {} } },
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
                exports: {}, require: (name: string) => modules[name] ?? {}, URL,
                VencordNative: { settings: { set: async () => pause("settings-save") } },
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
            "@api/DataStore": { get: async () => undefined, set: async () => writes++ },
            "@api/Notifications": { showNotification: () => notifications++ },
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) } },
            "./cloudSetup": { getCloudUrl: () => new URL("https://first.invalid"), getCloudAuth: async () => "synthetic" }
        };
        const { deleteCloudSettings } = runInNewContext(`${compiled}\nexports;`, {
            exports: {}, require: (name: string) => modules[name] ?? {}, URL,
            fetch: async (_url: URL, init: RequestInit) => { if (init.method === "DELETE") deletes++; return { ok: true, json: async () => manifest }; }
        });
        await deleteCloudSettings();
        assert.equal(deletes, 0);
        assert.equal(writes, 0);
        assert.equal(notifications, 1);
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
            exports: {}, require: (name: string) => modules[name] ?? {}, URL,
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
