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
import { createSourceFile, isVariableStatement, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

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
    const initial = { themeLinks: ["old"], plugins: { Sound: { enabled: true } } };
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
    const records: [string, unknown][] = [["CustomSounds", { saved: true }], ["VoiceStats", { seconds: 42 }]];
    const syncedRecords = records.slice();
    const localKeys = ["Vencord_cloudSecret", "Vencord_cloudManifest", "Vencord_cloudApiVersions"];
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
        VencordNative: { settings: { get: () => ({}), set: async () => {} }, quickCss: { get: async () => "", set: async (value: string) => css.push(value) } }
    };
    const offline = runInNewContext(`${outputText}\nexports;`, { ...globals, exports: {} });
    modules["./offline"] = offline;
    const compiled = transpileModule(readFileSync("src/api/SettingsSync/cloudSync.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const { buildLocalData, applyDownloads } = runInNewContext(`${compiled}\n({ buildLocalData, applyDownloads });`, { ...globals, exports: {} });
    const local = await buildLocalData();
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
            "@utils/Logger": { Logger: class { info() {} error() {} } },
            "@utils/native": {},
            "@webpack/common": {},
            fflate: { deflateSync: (value: Uint8Array) => value, inflateSync: (value: Uint8Array) => value },
            "./cloudSetup": { getCloudUrl: () => new URL("https://sync.invalid"), getCloudAuth: async () => "test" },
            "./offline": { exportSettings: async () => "{}", importSettings: async () => {} }
        };
        const entry = runInNewContext(`${compiled}\n({ putV1, getV1 });`, {
            exports: {}, require: (name: string) => modules[name], URL, TextEncoder, TextDecoder, Uint8Array, IS_WEB: true,
            fetch: async () => ({ ok: true, status: 200, json: async () => ({ written: 2 }), headers: { get: () => "2" }, arrayBuffer: async () => new TextEncoder().encode("{}").buffer }),
            VencordNative: { settings: { set: () => new Promise<void>((_resolve, reject) => { rejectSave = reject; }) } }
        });
        let settled = false;
        const pending = entry[direction](true, true).then(
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
        "./cloudSetup": { getCloudUrl: () => new URL("https://cloud.example"), getCloudAuth: async () => "test" },
        "./offline": { serializeDataStore: JSON.stringify, importSettings: async () => { if (importFails) throw new Error("Import failed"); } }
    };
    const { getCloudSettings, putCloudSettings, deleteCloudSettings } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => modules[name] ?? {}, URL, TextEncoder, TextDecoder, atob, btoa, crypto, IS_WEB: true,
        fetch: async (_url: URL, init: RequestInit) => init.method === "DELETE"
            ? { ok: false, status: 500 }
            : { ok: true, json: async () => response },
        VencordNative: { settings: { get: () => ({}), set: async () => { events.push("settings"); if (saveFails) throw new Error("Save failed"); writes++; } }, quickCss: { get: async () => "" } }
    });
    for (const [downloads, errors] of [
        [[{ key: "settings", value: btoa("{}") }], []],
        [[], [{ key: "settings", error: "Server failed" }]]
    ]) {
        response = { downloads, errors, server_manifest: [], uploaded: [] };
        notifications = [];
        assert.equal(await getCloudSettings(), false);
        assert.equal(writes, 0);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].color, "var(--red-360)");
    }
    response = { entries: [{ key: "settings" }] };
    notifications = [];
    await deleteCloudSettings();
    assert.equal(writes, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].color, "var(--red-360)");
    importFails = false;
    response = { downloads: [{ key: "settings", value: btoa("{}") }], errors: [], server_manifest: [{ key: "settings", version: 2 }], uploaded: [] };
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
