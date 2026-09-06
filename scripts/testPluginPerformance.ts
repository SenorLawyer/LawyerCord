/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { proxyLazy, SYM_LAZY_GET } from "../src/utils/lazy";

test("theme validation belongs to the current URL and cancels obsolete requests", async () => {
    let state: unknown = null;
    let effect: () => (() => void) | undefined;
    const pending: Array<{ signal: AbortSignal; resolve: (response: object) => void; }> = [];
    const { OnlineThemesSection } = loadSource("src/components/settings/tabs/themes/OnlineThemes.tsx", {
        "@components/Button": { Button: "button" }, "@components/FormSwitch": {}, "@components/Heading": {},
        "@components/Link": {}, "@components/Notice": { Notice: {} }, "@components/Paragraph": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/margins": { Margins: {} },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) },
            useState: () => [state, (value: unknown) => { state = value; }],
            useEffect: (callback: typeof effect) => { effect = callback; },
        },
    }, { AbortController, fetch: (_url: string, options: { signal: AbortSignal; }) => new Promise(resolve => pending.push({ signal: options.signal, resolve })) });
    const render = (link: string) => OnlineThemesSection({ currentThemeLink: link, enableOnlineThemes: true });
    const addButton = (tree: { children: Array<{ children?: Array<{ type: string; props: { disabled: boolean; }; }>; }>; }) => tree.children.flatMap(child => child?.children ?? []).find(child => child.type === "button");
    const valid = { ok: true, headers: { get: () => "text/css" }, body: { cancel: async () => {} } };
    render("https://example.com/first.css");
    const cleanup = effect();
    cleanup?.();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, true);
    effect();
    pending[0].resolve(valid);
    await setImmediate();
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, true);
    pending[1].resolve(valid);
    await setImmediate();
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, false);
    assert.equal(addButton(render("https://example.com/third.css"))?.props.disabled, true);
});

test("number settings accept decimals without changing the displayed value", () => {
    const states: unknown[] = [];
    const saved: unknown[] = [];
    const { NumberSetting } = loadSource("src/components/settings/tabs/plugins/components/NumberSetting.tsx", {
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ ...props, children }) },
            useState(initial: unknown) {
                const index = states.push(initial) - 1;
                return [initial, (value: unknown) => { states[index] = value; }];
            },
        },
        "./Common": { resolveError: () => null },
    });
    const tree = NumberSetting({ setting: { type: 1, default: 0 }, pluginSettings: {}, definedSettings: {}, id: "number", onChange: (value: unknown) => saved.push(value) });
    for (const value of ["1.5", "-0.25", "1e3", "9007199254740992"]) {
        tree.children[0].onChange(value);
        assert.equal(saved.at(-1), Number(value));
        assert.equal(states[0], value);
    }
});

test("plugin reset restores selected defaults without changing definitions", () => {
    const source = readFileSync("src/components/settings/tabs/plugins/PluginModal.tsx", "utf8");
    const resetSource = source.slice(source.indexOf("function resetSettings("), source.indexOf("export function openWarningModal("));
    const code = transpileModule(resetSource, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const reset = runInNewContext(code + "\nresetSettings;", {
        OptionType: { SELECT: 1, STRING: 2 },
        Toasts: { show() {}, genId: () => "test", Type: { SUCCESS: 1 }, Position: { TOP: 1 } },
    });
    const def = Object.freeze({
        choice: Object.freeze({ type: 1, options: [{ value: "first" }, { value: "default", default: true }] }),
        text: Object.freeze({ type: 2, default: "original" }),
    });
    const store = { choice: "first", text: "changed", enabled: true };
    reset({ name: "Fixture", settings: { def, store } });
    assert.equal(store.choice, "default");
    assert.equal(store.text, "original");
    assert.equal(store.enabled, true);
});

test("editable text begins each edit with the current parent value", () => {
    const states: unknown[] = [];
    let cursor = 0;
    const { EditableText } = loadSource("src/components/settings/EditableText.tsx", {
        "@components/BaseText": {},
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: object) => props },
            useEffect() {}, useRef: () => ({ current: null }),
            useState(initial: unknown) {
                const index = cursor++;
                if (index >= states.length) states.push(initial);
                return [states[index], (value: unknown) => { states[index] = value; }];
            },
        },
    });
    const render = (value: string) => { cursor = 0; return EditableText({ value, onChange() {} }); };
    render("original");
    render("updated elsewhere").onClick();
    assert.equal(render("updated elsewhere").value, "updated elsewhere");
});

test("disabled links remove navigation and click activation", () => {
    const { Link } = loadSource("src/components/Link.tsx", {
        "@utils/misc": { classes: () => "" },
    }, { React: { createElement: (_type: unknown, props: object) => props } });
    const onClick = () => {};
    const props = { href: "https://example.com", onClick, tabIndex: 0 };
    const disabled = Link({ ...props, disabled: true });
    assert.equal(disabled.href, undefined);
    assert.equal(disabled.onClick, undefined);
    assert.equal(disabled.tabIndex, -1);
    assert.equal(disabled["aria-disabled"], true);
    const enabled = Link(props);
    assert.equal(enabled.href, props.href);
    assert.equal(enabled.onClick, onClick);
    assert.equal(enabled.tabIndex, 0);
});

test("compatibility text does not mutate caller-owned styles", () => {
    const { TextCompat } = loadSource("src/components/BaseText.tsx", {
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/misc": { classes: () => "" },
    }, { React: { createElement: (_component: unknown, props: object) => props } });
    const style = Object.freeze({ color: "red", margin: 4 });
    const result = TextCompat({ color: "text-muted", style, children: "Text" });
    assert.equal(style.color, "red");
    assert.equal(result.style.margin, 4);
    assert.equal(result.style.color, "var(--text-muted, var(--text-default))");
    assert.notEqual(result.style, style);
});

test("stopped emoji whitelist startup cannot restore stale entries", async () => {
    let finish: (value: object[]) => void = () => {};
    const { default: plugin } = loadSource("src/equicordplugins/whitelistedEmojis/index.tsx", {
        "@api/index": { DataStore: { get: () => new Promise(resolve => { finish = resolve; }) } },
        "@api/Settings": { definePluginSettings: () => ({ store: { defaultEmojis: true, serverEmojis: true } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@utils/web": {}, "@webpack/common": {},
    });
    const emoji = { type: "emoji", id: "1", name: "test" };
    const first = plugin.start();
    plugin.stop();
    finish([emoji]);
    await first;
    assert.equal(plugin.filterEmojis([emoji]).length, 0);
    const second = plugin.start();
    finish([emoji]);
    await second;
    assert.equal(plugin.filterEmojis([emoji]).length, 1);
    assert.deepEqual(Object.keys(plugin.contextMenus).sort(), ["expression-picker", "guild-context"]);
});

test("webpack tar archives contain only the supplied byte view", () => {
    const { default: TarFile } = loadSource("src/equicordplugins/webpackTarball/tar.ts", {});
    const tar = new TarFile();
    const backing = Uint8Array.from([99, 1, 2, 3, 88]);
    tar.addFile("first.bin", backing.subarray(1, 4));
    tar.addFile("second.bin", Uint8Array.from([4, 5]));
    const archive = Buffer.concat(tar.buffers.map((value: ArrayBuffer) => Buffer.from(value)));
    assert.deepEqual(Array.from(archive.subarray(512, 515)), [1, 2, 3]);
    assert.equal(archive.subarray(1024, 1034).toString(), "second.bin");
    assert.equal(archive.length, 2048);
});

test("voice statistics retain fractional seconds across periodic saves", () => {
    let now = 1000;
    const { sessionStarts, totalsByUser, flushActiveSessions, getLiveSeconds } = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@api/DataStore": {}, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": {},
    }, { Date: { now: () => now } }, "({ sessionStarts, totalsByUser, flushActiveSessions, getLiveSeconds })");
    sessionStarts.set("friend", now);
    for (now of [31_400, 61_800, 92_200]) flushActiveSessions();
    assert.equal(totalsByUser.get("friend"), 91);
    assert.equal(sessionStarts.get("friend"), 92_000);
    now = 93_000;
    assert.equal(getLiveSeconds("friend"), 92);
});

test("transcription worker cancellation aborts model downloads and startup failures settle", async () => {
    let instance: { onmessage?: (event: object) => Promise<void>; onerror?: () => void; } = {};
    let signal: AbortSignal | undefined;
    let writes = 0;
    let terminations = 0;
    let revocations = 0;
    const errors: Error[] = [];
    const { TranscriptionWorker } = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/utils.ts", {
        "@api/index": { DataStore: { get: async () => undefined, set: async () => { writes++; } } },
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": { lodash: { isArrayBuffer: () => false } },
    }, {
        Blob, AbortController,
        URL: class extends URL {
            static createObjectURL() { return "blob:worker"; }
            static revokeObjectURL() { revocations++; }
        },
        Worker: class {
            constructor() { instance = this; }
            onmessage?: (event: object) => Promise<void>;
            onerror?: () => void;
            terminate() { terminations++; }
            postMessage() {}
        },
        fetch: async (_url: string, options: RequestInit) => {
            signal = options.signal ?? undefined;
            return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
        },
    });
    const worker = new TranscriptionWorker(() => {}, () => {}, (error: Error) => errors.push(error), () => {});
    const pending = instance.onmessage?.({ data: { type: "fetch_request", id: "model", url: "https://huggingface.co/model" } });
    await setImmediate();
    assert.equal(signal?.aborted, false);
    worker.terminate();
    await pending;
    assert.equal(signal?.aborted, true);
    assert.equal(writes, 0);
    assert.equal(errors.length, 0);
    worker.terminate();
    assert.equal(terminations, 1);
    assert.equal(revocations, 1);
    new TranscriptionWorker(() => {}, () => {}, (error: Error) => errors.push(error), () => {});
    instance.onerror?.();
    instance.onerror?.();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /worker failed/);
    assert.equal(terminations, 2);
    assert.equal(revocations, 2);
});

test("voice transcription downloads reject untrusted URLs and bound streamed audio", async () => {
    const validation = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/audioValidation.ts", {});
    const audio = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]);
    let calls = 0;
    let cancelled = 0;
    let released = 0;
    let chunks = [audio];
    let length: string | null = null;
    let ok = true;
    let failure = false;
    const { fetchAudio } = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/native.ts", {
        "./audioValidation": validation,
    }, {
        URL, Buffer, AbortSignal,
        fetch: async (_url: URL, options: RequestInit) => {
            calls++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            if (failure) throw new Error("secret signed URL or local path");
            return {
                ok, headers: { get: () => length },
                body: {
                    cancel: async () => { cancelled++; },
                    getReader: () => ({
                        read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
                        cancel: async () => { cancelled++; },
                        releaseLock: () => { released++; },
                    }),
                },
            };
        },
    });
    for (const url of [null, 123, "bad", "https://evil.test/a", "http://cdn.discordapp.com/a", "https://user@cdn.discordapp.com/a", "https://cdn.discordapp.com:444/a", "https://cdn.discordapp.com/" + "x".repeat(8192)])
        await assert.rejects(fetchAudio({}, url), /Blocked an untrusted/);
    assert.equal(calls, 0);
    const url = "https://cdn.discordapp.com/attachments/a.ogg";
    assert.deepEqual(Buffer.from(await fetchAudio({}, url)), Buffer.from(audio));
    assert.equal(released, 1);
    chunks = [new Uint8Array(25 * 1024 * 1024), audio];
    await assert.rejects(fetchAudio({}, url), /under 25 MB/);
    assert.equal(cancelled, 1);
    assert.equal(released, 2);
    length = String(25 * 1024 * 1024 + 1);
    await assert.rejects(fetchAudio({}, url), /under 25 MB/);
    assert.equal(cancelled, 2);
    length = null;
    ok = false;
    await assert.rejects(fetchAudio({}, url), /Could not download/);
    assert.equal(cancelled, 3);
    ok = true;
    chunks = [new TextEncoder().encode("<html>no audio</html>")];
    await assert.rejects(fetchAudio({}, url), /Could not download/);
    failure = true;
    await assert.rejects(fetchAudio({}, url), (error: Error) => {
        assert.equal(error.message.includes("secret"), false);
        return true;
    });
});

test("voice activity lookups cannot log into a stopped or different session", async () => {
    for (const change of ["none", "stop", "account", "channel"]) {
        let account = "first";
        let channel = "voice";
        let lookups = 0;
        const entries: object[] = [];
        let finish: (value: { name: string; }) => void = () => {};
        const actions = { get fetchApplication() {
            lookups++;
            return () => new Promise(resolve => { finish = resolve; });
        } };
        const { default: plugin } = loadSource("src/equicordplugins/voiceChannelLog/index.tsx", {
            "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
            "@vencord/discord-types/enums": { ChannelType: {} },
            "@webpack": { findByPropsLazy: () => actions },
            "@webpack/common": { ApplicationStore: { getApplication: () => undefined }, UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getVoiceChannelId: () => channel } },
            "./components/LogsButton": {}, "./components/VoiceChannelLogModal": {},
            "./logs": { addLogEntry: (entry: object) => entries.push(entry), setCallStartTime() {} },
            "./settings": { __esModule: true, default: { store: { logActivity: true } } },
        });
        assert.equal(lookups, 0);
        plugin.flux.EMBEDDED_ACTIVITY_UPDATE_V2({ applicationId: "app", location: { channel_id: "voice" }, participants: [{ user_id: "participant" }] });
        assert.equal(lookups, 1);
        if (change === "stop") plugin.stop();
        if (change === "account") account = "second";
        if (change === "channel") channel = "other";
        finish({ name: "Activity" });
        await setImmediate();
        assert.equal(entries.length, change === "none" ? 1 : 0);
    }
});

test("voice panel selectors read current media settings and device lists", () => {
    let volume = 20;
    let selected = "first";
    const devices: Record<string, { id: string; name: string; }> = { first: { id: "first", name: "First" } };
    const media = { getOutputVolume: () => volume, getOutputDeviceId: () => selected, getOutputDevices: () => devices };
    const hooks: Array<() => unknown> = [];
    const { OutputVolumeComponent, OutputDeviceComponent } = loadSource("src/equicordplugins/vcPanelSettings/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/BaseText": {}, "@components/Heading": {}, "@components/Link": {},
        "@utils/constants": { Devs: {} }, "@utils/misc": { identity: (value: unknown) => value },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            MediaEngineStore: media, lodash: { isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) },
            useStateFromStores: (stores: object[], selector: () => unknown) => {
                assert.equal(stores[0], media);
                hooks.push(selector);
                return selector();
            },
        },
    }, { React: { createElement: () => null, Fragment: "fragment" } }, "({ OutputVolumeComponent, OutputDeviceComponent })");
    assert.equal(hooks.length, 0);
    OutputVolumeComponent();
    OutputDeviceComponent();
    volume = 70;
    selected = "second";
    devices.second = { id: "second", name: "Second" };
    assert.equal(hooks[0](), 70);
    assert.equal(hooks[1](), "second");
    assert.equal(JSON.stringify(hooks[2]()), JSON.stringify(Object.values(devices)));
});

test("voice buttons apply server actions to the selected user", () => {
    const settings = { useServer: true, serverSelf: false };
    const calls: string[] = [];
    const react = { createElement: (_type: unknown, props: object) => ({ props }) };
    const source = loadSource("src/equicordplugins/voiceButtons/utils.tsx", {
        "./settings": { settings: { store: settings } },
        "@webpack": { findComponentByCodeLazy: () => null, findStoreLazy: () => ({ isLocalSoundboardMuted: () => false }) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice", mute: false, deaf: false }) },
            PermissionsBits: {}, PermissionStore: { can: () => true },
            MediaEngineStore: { isSelfMute: () => false, isSelfDeaf: () => false, isLocalMute: () => false, isLocalVideoDisabled: () => false },
            GuildActions: { setServerMute: (_guild: string, id: string) => calls.push(`serverMute:${id}`), setServerDeaf: (_guild: string, id: string) => calls.push(`serverDeaf:${id}`) },
            VoiceActions: { toggleSelfMute: () => calls.push("selfMute"), toggleSelfDeaf: () => calls.push("selfDeaf"), toggleLocalMute: (id: string) => calls.push(`localMute:${id}`) },
        },
    }, { React: react });
    for (const id of ["other", "self"]) {
        source.UserMuteButton({ user: { id } }).props.onClick();
        source.UserDeafenButton({ user: { id } }).props.onClick();
    }
    assert.deepEqual(calls, ["serverMute:other", "serverDeaf:other", "selfMute", "selfDeaf"]);
    settings.serverSelf = true;
    source.UserMuteButton({ user: { id: "self" } }).props.onClick();
    source.UserDeafenButton({ user: { id: "self" } }).props.onClick();
    assert.deepEqual(calls.slice(-2), ["serverMute:self", "serverDeaf:self"]);
    settings.useServer = false;
    source.UserMuteButton({ user: { id: "other" } }).props.onClick();
    assert.equal(calls.at(-1), "localMute:other");
});

test("installer builds settle subprocess failures without exposing process details", async () => {
    let finish: (error: Error | null) => void = () => {};
    const mocks: Record<string, object> = {
        "child_process": { exec: (command: string, options: { cwd: string; }, callback: (error: Error | null) => void) => {
            assert.equal(command, "pnpm build --dev");
            assert.equal(options.cwd, path.resolve("fixture"));
            finish = callback;
        } },
        "electron": {}, "fs": {}, "fs/promises": {}, path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`./misc/${name}.txt`] = { __esModule: true, default: "" };
    const { build } = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), process: { env: {} } }, "({ build })");
    for (const error of [new Error("Missing shell at private path"), new Error("Build exited with private output")]) {
        const pending = build();
        finish(error);
        await assert.rejects(pending, { message: "Could not build LawyerCord. Try building from the terminal." });
    }
    const pending = build();
    finish(null);
    assert.equal(await pending, undefined);
});

test("installer uninstall settles missing, cancelled, failed and successful requests", async () => {
    let confirmation = 0;
    let removals = 0;
    let failRemoval = false;
    let builds = 0;
    const root = path.resolve("fixture/src/userplugins");
    const mocks: Record<string, object> = {
        "child_process": {},
        "electron": { dialog: { showMessageBox: async () => ({ response: confirmation }) } },
        "fs": { realpathSync: (value: string) => path.resolve(value) },
        "fs/promises": { rm: async (directory: string) => {
            assert.equal(directory, path.join(root, "plugin"));
            if (failRemoval) throw new Error("Removal failed");
            removals++;
        } },
        path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`./misc/${name}.txt`] = { __esModule: true, default: "" };
    const native = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, {
        __dirname: path.resolve("fixture/dist"), onBuild: async () => { builds++; },
    }, "({ ...exports, configure: plugins => { getUserplugins = async () => plugins; build = onBuild; } })");
    native.configure([]);
    await assert.rejects(native.rmPlugin(null, "plugin"), { message: "Plugin not found." });
    native.configure([{ name: "Example", directory: "plugin" }]);
    await assert.rejects(native.rmPlugin(null, "plugin"), { message: "Uninstall cancelled." });
    assert.equal(removals, 0);
    confirmation = 1;
    failRemoval = true;
    await assert.rejects(native.rmPlugin(null, "plugin"), { message: "Could not uninstall the plugin." });
    assert.equal(builds, 0);
    failRemoval = false;
    assert.equal(await native.rmPlugin(null, "plugin"), "Done");
    assert.equal(removals, 1);
    assert.equal(builds, 1);
});

test("installer update commands reject traversal and directories linked outside the plugin root", async t => {
    const prefix = path.join(tmpdir(), "lawyercord-installer-");
    const temporary = mkdtempSync(prefix);
    t.after(() => {
        assert.ok(temporary.startsWith(prefix));
        rmSync(temporary, { recursive: true, force: true });
    });
    const root = path.join(temporary, "src/userplugins");
    mkdirSync(path.join(root, "valid"), { recursive: true });
    const outside = path.join(temporary, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    let commands = 0;
    const mocks: Record<string, object> = {
        "child_process": { exec: () => { commands++; throw new Error("Unexpected command"); } },
        "electron": {}, "fs": { realpathSync }, "fs/promises": {}, path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`./misc/${name}.txt`] = { __esModule: true, default: "" };
    const native = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.join(temporary, "dist") }, "({ ...exports, getPluginDirectory })");
    assert.equal(native.getPluginDirectory("valid"), realpathSync(path.join(root, "valid")));
    for (const name of ["../outside", "..", ".", outside, "linked", "missing", "", null, 1]) {
        await assert.rejects(native.isUpdateAvailableForPlugin(null, name), { message: "Invalid plugin directory." });
        await assert.rejects(native.updatePlugin(null, name), { message: "Invalid plugin directory." });
    }
    assert.equal(commands, 0);
});

test("installer update reviews render repository metadata as text", () => {
    const mocks: Record<string, object> = {
        "@main/settings": {}, "child_process": {}, "electron": {}, "fs": {}, "fs/promises": {},
        path,
        "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`./misc/${name}.txt`] = { __esModule: true, default: readFileSync(`src/equicordplugins/userpluginInstaller.dev/misc/${name}.txt`, "utf8") };
    const { formatCommitMessages, generateUpdatePluginContent } = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: "/fixture/dist", Buffer }, "({ formatCommitMessages, generateUpdatePluginContent })");
    const commit = formatCommitMessages('<script>document.title="install"</script>////////1234567////////123456789////////<img src=x onerror=alert(1)> & text', "https://github.com/example/plugin");
    const url = generateUpdatePluginContent({ name: "Example", description: "Description", remote: "https://github.com/example/plugin", commit });
    const html = Buffer.from(url.split(",")[1], "base64").toString("utf8");
    assert.equal(html.includes('<script>document.title="install"</script>'), false);
    assert.equal(html.includes("<img src=x"), false);
    assert.ok(html.includes("&lt;img src=x"));
    assert.ok(html.includes("&amp; text"));
    assert.ok(html.includes('href="https://github.com/example/plugin/commit/123456789"'));
});

test("installer subscriptions keep unique identities and allow self-removal", () => {
    const { VariableWithCallbacks } = loadSource("src/equicordplugins/userpluginInstaller.dev/VariableWithCallbacks.ts", {}, { Date: { now: () => 1 } });
    const value = new VariableWithCallbacks(0);
    const calls: number[] = [];
    const first = value.registerCallback((current: number, id: number) => {
        calls.push(current);
        value.deregisterCallback(id);
    });
    const second = value.registerCallback((current: number) => calls.push(current * 10));
    assert.notEqual(first, second);
    value.value(1);
    assert.deepEqual(calls, [1, 10]);
    value.value(2);
    assert.deepEqual(calls, [1, 10, 20]);
    value.deregisterCallback(second);
    value.value(3);
    assert.deepEqual(calls, [1, 10, 20]);
});

test("toast shutdown settles pending notifications and releases its root", async () => {
    let unmounts = 0;
    let removals = 0;
    let roots = 0;
    const notifications = loadSource("src/equicordplugins/toastNotifications/components/Notifications.tsx", {
        "@equicordplugins/toastNotifications/index": { settings: { store: { maxNotifications: 3 } } },
        "@webpack/common": { createRoot: () => {
            roots++;
            return { render() {}, unmount() { unmounts++; } };
        } },
        "./NotificationComponent": { __esModule: true, default: "notification" },
    }, {
        React: { createElement: () => ({}), Fragment: "fragment" },
        document: { createElement: () => ({ remove() { removals++; } }), body: { append() {} } },
    });
    let settled = 0;
    const pending = [1, 2].map(id => notifications.showNotification({ title: String(id), body: "", permanent: true }).then(() => { settled++; }));
    notifications.teardownNotifications();
    await setImmediate();
    assert.equal(settled, 2);
    await Promise.all(pending);
    assert.equal(unmounts, 1);
    assert.equal(removals, 1);
    const next = notifications.showNotification({ title: "Next", body: "" });
    assert.equal(roots, 2);
    notifications.teardownNotifications();
    await next;
    assert.equal(unmounts, 2);
});

test("URL highlighting clears compiled matches when the last pattern is removed", () => {
    const store = { patterns: [{ pattern: "example.com", color: "#123456" }], boldUrls: false, highlightEmbeds: true };
    const { plugin, updatePatterns } = loadSource("src/equicordplugins/urlHighlighter/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/Button": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Heading": {},
        "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => null },
        "@webpack/common": {},
    }, {}, "({ plugin: exports.default, updatePatterns })");
    const props = { href: "https://example.com" };
    assert.equal(plugin.getProps(props).style["--vc-url-hl-color"], "#123456");
    updatePatterns([]);
    assert.equal(Object.keys(plugin.getProps(props)).length, 0);
    updatePatterns([{ pattern: "example.com", color: "#654321" }]);
    assert.equal(plugin.getProps(props).style["--vc-url-hl-color"], "#654321");
});

test("UniversalMention reads current users and DM membership on each lookup", () => {
    const settings = { onlyDMUsers: false };
    let users: Record<string, { id: string; }> = { first: { id: "first" } };
    const dms = new Set<string>();
    const { default: plugin } = loadSource("src/equicordplugins/universalMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@components/Notice": { Notice: {} },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            UserStore: { getUsers: () => users },
            ChannelStore: { getDMFromUserId: (id: string) => dms.has(id) },
        },
    });
    assert.deepEqual(Array.from(plugin.useFilter(), (user: { id: string; }) => user.id), ["first"]);
    users = { second: { id: "second" } };
    assert.deepEqual(Array.from(plugin.useFilter(), (user: { id: string; }) => user.id), ["second"]);
    settings.onlyDMUsers = true;
    assert.equal(plugin.useFilter().length, 0);
    dms.add("second");
    assert.equal(plugin.useFilter(true)[0].userId, "second");
    users = {};
    assert.equal(plugin.useFilter().length, 0);
});

test("tone indicators preserve empty descriptions and resolve aliases without prototype properties", () => {
    const settings = { prefix: "/", customIndicators: "empty=; _constructor=Constructor alias" };
    const { default: plugin } = loadSource("src/equicordplugins/toneIndicators/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/text": loadSource("src/utils/text.ts", {}),
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React: { createElement: (type: unknown, props: object) => ({ type, props }) } },
        "./indicators": loadSource("src/equicordplugins/toneIndicators/indicators.ts", {}),
        "./ToneIndicator": { __esModule: true, default: "indicator" },
    });
    const empty = plugin.patchToneIndicators("keep /empty intact");
    assert.equal(Array.from(empty).join(""), "keep /empty intact");
    const alias = plugin.patchToneIndicators("/constructor");
    assert.equal(alias.props.desc, "Constructor alias");
    assert.equal(plugin.patchToneIndicators("/srs").props.desc, "Serious");
    settings.prefix = "+";
    assert.equal(plugin.patchToneIndicators("+srs").props.desc, "Serious");
});

test("RandomVoice discards join actions and screen sources after cancellation", async () => {
    let account = "first";
    let channelId = "channel";
    let tick: () => void = () => {};
    let cleared = 0;
    let actions = 0;
    let streams = 0;
    const pending: Array<(sources: object[]) => void> = [];
    const { plugin, runAfterVoiceJoin, startChannelStream, cancelPendingJoin } = loadSource("src/equicordplugins/randomVoice/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@api/UserArea": {}, "@components/Button": {}, "@components/Switch": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@shared/debounce": {}, "@utils/constants": { Devs: {}, EquicordDevs: {}, IS_MAC: false },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack": { findByCodeLazy: (code: string) => code.includes("STREAM_START")
            ? () => streams++ : () => new Promise(resolve => pending.push(resolve)) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId }) },
            SelectedChannelStore: { getVoiceChannelId: () => channelId },
            PermissionStore: { can: () => true }, PermissionsBits: {},
            MediaEngineStore: { getMediaEngine: () => ({}) },
        },
    }, {
        window: { removeEventListener() {} },
        setInterval: (callback: () => void) => { tick = callback; return 1; },
        clearInterval: () => cleared++,
    }, "({ plugin: exports.default, runAfterVoiceJoin, startChannelStream, cancelPendingJoin })");
    runAfterVoiceJoin("channel", [() => actions++]);
    plugin.stop();
    assert.equal(cleared, 1);
    tick();
    assert.equal(actions, 0, "a queued timer cannot run actions after stop");
    const channel = { id: "channel", guild_id: "guild", type: 2, isGuildStageVoice: () => false };
    const stopped = startChannelStream(channel);
    plugin.stop();
    pending[0]([{ id: "screen", name: "screen" }]);
    await stopped;
    assert.equal(streams, 0);
    const switched = startChannelStream(channel);
    channelId = "other";
    pending[1]([{ id: "screen", name: "screen" }]);
    await switched;
    assert.equal(streams, 0);
    channelId = "channel";
    const replaced = startChannelStream(channel);
    cancelPendingJoin();
    pending[2]([{ id: "screen", name: "screen" }]);
    await replaced;
    assert.equal(streams, 0);
    const differentAccount = startChannelStream(channel);
    account = "second";
    pending[3]([{ id: "screen", name: "screen" }]);
    await differentAccount;
    assert.equal(streams, 0);
    const valid = startChannelStream(channel);
    pending[4]([{ id: "screen", name: "screen" }]);
    await valid;
    assert.equal(streams, 1);
});

test("timezone dialog stays open when the database rejects a save", async () => {
    let succeeds = false;
    let closed = 0;
    const saved: string[] = [];
    const { SetTimezoneModal } = loadSource("src/equicordplugins/timezones/TimezoneModal.tsx", {
        "@api/DataStore": {}, "@components/Heading": {}, "@utils/margins": { Margins: {} },
        "@webpack/common": { Modal: "modal", useState: () => ["UTC", () => {}], useEffect() {}, useMemo: () => [] },
        ".": { settings: { store: {} } },
        "./database": {
            setTimezone: async () => succeeds,
            setUserDatabaseTimezone: async (_userId: string, value: string) => saved.push(value),
        },
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } });
    const modal = SetTimezoneModal({ userId: "user", database: true, modalProps: { onClose: () => closed++ } });
    await modal.props.actions[0].onClick();
    assert.equal(closed, 0);
    assert.equal(saved.length, 0);
    succeeds = true;
    await modal.props.actions[0].onClick();
    assert.equal(closed, 1);
    assert.deepEqual(saved, ["UTC"]);
});

test("video shortcut reads live settings and waits until invocation to access the media store", () => {
    let ready = false;
    let enabled = false;
    let listener: ((event: object) => void) | undefined;
    const settings = { keyBind: "KeyX", reqCtrl: true, reqShift: true, reqAlt: false };
    const dispatched: boolean[] = [];
    const common = {
        get MediaEngineStore() {
            assert.equal(ready, true, "store access must be deferred");
            return { isVideoEnabled: () => enabled };
        },
        FluxDispatcher: { dispatch: (event: { enabled: boolean; }) => dispatched.push(event.enabled) },
    };
    const { default: plugin } = loadSource("src/equicordplugins/toggleVideoBind/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ plain: settings }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": common,
    }, { document: {
        addEventListener: (_type: string, callback: typeof listener) => { listener = callback; },
        removeEventListener: (_type: string, callback: typeof listener) => { assert.equal(callback, listener); listener = undefined; },
    } });
    ready = true;
    plugin.start();
    const event = { code: "KeyX", ctrlKey: true, shiftKey: true, altKey: false, repeat: false };
    listener?.(event);
    assert.deepEqual(dispatched, [true]);
    enabled = true;
    settings.keyBind = "KeyY";
    listener?.(event);
    listener?.({ ...event, code: "KeyY", repeat: true });
    listener?.({ ...event, code: "KeyY", altKey: true });
    assert.equal(dispatched.length, 1);
    listener?.({ ...event, code: "KeyY" });
    assert.deepEqual(dispatched, [true, false]);
    plugin.stop();
    assert.equal(listener, undefined);
});

test("failed theme downloads preserve the installed stylesheet", async () => {
    let contents = ".existing { color: red; }";
    let status = 503;
    const { downloadTheme } = loadSource("src/equicordplugins/themeLibrary/native.ts", {
        "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => file },
        "@main/utils/constants": { THEMES_DIR: "themes" },
        fs: { writeFileSync: (_file: string, content: string) => { contents = content; } },
    }, { fetch: async () => new Response(status === 200 ? ".new { color: blue; }" : "Service unavailable", { status }) });
    const theme = { name: "existing", id: "123", content: "metadata" };
    await assert.rejects(downloadTheme(null, theme), /download/i);
    assert.equal(contents, ".existing { color: red; }");
    status = 200;
    await downloadTheme(null, theme);
    assert.equal(contents, ".new { color: blue; }");
});

test("theme library requests preserve authentication in Headers objects", async () => {
    const { themeRequest } = loadSource("src/equicordplugins/themeLibrary/components/ThemeTab.tsx", {
        "@api/DataStore": {}, "@api/Settings": {}, "@components/ErrorCard": {},
        "@components/Heading": {}, "@components/Icons": {}, "@components/Paragraph": {},
        "@components/settings": { wrapTab: (component: unknown) => component },
        "@equicordplugins/themeLibrary/types": { SearchStatus: {} },
        "@utils/Logger": { Logger: class {} }, "@utils/margins": {}, "@utils/misc": {},
        "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": {}, "./ThemeCard": {},
    }, {
        fetch: async (_url: string, options: RequestInit) => {
            const headers = new Headers(options.headers);
            assert.equal(headers.get("Authorization"), "Bearer test-token");
            assert.equal(headers.get("Accept"), "application/json");
            return new Response("{}");
        },
    });
    await themeRequest("/likes/get", { headers: new Headers({ Authorization: "Bearer test-token", Accept: "application/json" }) });
});

test("Song Spotlight validation does not trust a failed render cached as valid", async () => {
    const handlers = await import("@song-spotlight/api/handlers");
    const util = await import("@song-spotlight/api/util");
    let requests = 0;
    let exists = false;
    const native = loadSource("src/equicordplugins/songSpotlight.desktop/native.ts", {
        "@song-spotlight/api/handlers": handlers,
        "@song-spotlight/api/util": util,
        electron: { net: { fetch: async () => {
            requests++;
            return new Response(JSON.stringify(exists ? { id: 123 } : {}));
        } } },
    });
    try {
        handlers.clearCache();
        const song = { service: "soundcloud", type: "track", id: "123" };
        assert.equal(await native.renderSong(null, song), null);
        assert.equal(await native.validateSong(null, song), false);
        assert.equal(requests, 2, "validation checks the service after a failed render");
        exists = true;
        assert.equal(await native.validateSong(null, song), true);
        assert.equal(requests, 3, "an earlier missing result does not permanently reject the song");
    } finally {
        handlers.clearCache();
        util.setFetchHandler(fetch);
    }
});

test("Song Spotlight album playback advances in numeric track order", () => {
    let next: number | undefined;
    const { default: AudioPlayer } = loadSource("src/equicordplugins/songSpotlight.desktop/ui/components/AudioPlayer.tsx", {
        "@equicordplugins/songSpotlight.desktop/lib/utils": {},
        "@equicordplugins/songSpotlight.desktop/settings": {},
        "@webpack/common": {
            useMemo: (factory: () => unknown) => factory(),
            useRef: (current: unknown) => ({ current }),
            useCallback: (callback: unknown) => callback,
            useEffect() {},
        },
    }, { React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) } });
    const tree = AudioPlayer({
        audioRef: { current: undefined }, playing: 1,
        list: Array.from({ length: 12 }, (_, index) => ({ audio: { previewUrl: String(index) } })),
        setPlaying: (index: number | undefined) => { next = index; }, setLoadedAudio() {},
    });
    const item = tree.children[0][0].props;
    for (const index of [11, 10, 2, 1]) item.handleLoaded(index, true);
    item.handleStopped(1, true);
    assert.equal(next, 2);
    item.handleStopped(2, true);
    assert.equal(next, 10);
    item.handleStopped(10, true);
    assert.equal(next, 11);
    item.handleStopped(11, true);
    assert.equal(next, undefined);
});

test("Song Spotlight metadata ignores replaced songs and unmounted requests", async () => {
    let state: unknown;
    let deps: unknown[] = [];
    let effect: (() => (() => void)) | undefined;
    let cleanup: (() => void) | undefined;
    let updates = 0;
    const common = {
        useState: (initial: unknown) => {
            state ??= initial;
            return [state, (next: unknown) => { state = next; updates++; }];
        },
        useEffect: (next: () => () => void, nextDeps: unknown[]) => {
            if (nextDeps.some((value, index) => value !== deps[index])) {
                deps = nextDeps;
                effect = next;
            }
        },
    };
    const commit = () => {
        if (!effect) return;
        cleanup?.();
        cleanup = effect();
        effect = undefined;
    };
    const requests: Array<{ resolve(value: object): void; reject(error: Error): void; }> = [];
    const { useAwaiter } = loadSource("src/utils/react.tsx", {
        "@webpack/common": common, "./misc": {}, "./lazyReact": {},
    });
    const { useRender } = loadSource("src/equicordplugins/songSpotlight.desktop/service.ts", {
        "@song-spotlight/api/util": { sid: (song: { id: string; }) => song.id },
        "@utils/react": { useAwaiter },
    }, { VencordNative: { pluginHelpers: { SongSpotlight: {
        renderSong: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    } } } });
    useRender({ id: "first" });
    commit();
    useRender({ id: "second" });
    commit();
    requests[1].resolve({ label: "second" });
    await setImmediate();
    assert.equal(useRender({ id: "second" }).render.label, "second");
    requests[0].resolve({ label: "first" });
    await setImmediate();
    assert.equal(useRender({ id: "second" }).render.label, "second");
    assert.equal(useRender({ id: "third" }).render, null, "old metadata disappears before the new effect runs");
    commit();
    requests[2].reject(new Error("missing"));
    await setImmediate();
    assert.equal(useRender({ id: "third" }).failed, true);
    assert.equal(useRender({ id: "fourth" }).failed, false);
    commit();
    cleanup?.();
    const previous = updates;
    requests[3].resolve({ label: "unmounted" });
    await setImmediate();
    assert.equal(updates, previous);
});

test("Song Spotlight keeps refreshes, logout and pending data bound to their account", async () => {
    let account = "first";
    const requests: Array<{ url: URL; options: RequestInit; resolve(response: Response): void; }> = [];
    const common = {
        UserStore: { getCurrentUser: () => ({ id: account }) },
        showToast() {}, Toasts: { Type: {} },
        zustandPersist: (definition: unknown) => definition,
        zustandCreate: (definition: (set: (next: object) => void, get: () => object) => object) => {
            let state = definition(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        },
    };
    const storeMocks = {
        "@webpack/common": common,
        "@utils/lazy": { proxyLazy: (factory: () => object) => factory() },
        "@api/index": { DataStore: {} },
    };
    const authModule = loadSource("src/equicordplugins/songSpotlight.desktop/lib/stores/AuthorizationStore.ts", storeMocks);
    const songModule = loadSource("src/equicordplugins/songSpotlight.desktop/lib/stores/SongStore.ts", storeMocks);
    const auth = authModule.useAuthorizationStore;
    const songs = songModule.useSongStore;
    auth.getState().setToken("first-access", "first-refresh", "first");
    auth.getState().setToken("second-access", "second-refresh", "second");
    const api = loadSource("src/equicordplugins/songSpotlight.desktop/lib/api.ts", {
        "@webpack/common": common, "./stores/AuthorizationStore": authModule, "./stores/SongStore": songModule,
    }, {
        URL, Headers,
        fetch: (url: URL, options: RequestInit) => new Promise<Response>(resolve => requests.push({ url, options, resolve })),
    });
    const first = api.authFetch(new URL("api/data", api.apiConstants.api), { method: "PUT", body: "first songs" });
    const firstRejected = assert.rejects(first, /account changed/);
    requests[0].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    assert.equal(requests[1].options.body, "first-access");
    account = "second";
    const second = api.authFetch(new URL("api/data", api.apiConstants.api));
    requests[2].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    assert.equal(requests[3].options.body, "second-access", "accounts never share a refresh");
    requests[1].resolve(new Response("first-renewed"));
    await firstRejected;
    assert.equal(requests.length, 4, "an account switch must not retry the old PUT");
    assert.equal(auth.getState().getToken("first").access, "first-renewed");
    assert.equal(auth.getState().getToken("second").access, "second-access");
    requests[3].resolve(new Response("second-renewed"));
    await setImmediate();
    assert.equal(new Headers(requests[4].options.headers).get("Authorization"), "second-renewed");
    requests[4].resolve(new Response("[]"));
    await second;

    const pending = api.authFetch(new URL("api/data", api.apiConstants.api));
    const signedOut = assert.rejects(pending);
    requests[5].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    auth.getState().deleteTokens();
    requests[6].resolve(new Response("must-not-restore"));
    await signedOut;
    assert.equal(auth.getState().getToken("second"), undefined);
    assert.equal(auth.getState().getToken("first").access, "first-renewed");

    account = "first";
    songs.getState().update({ userId: "second", data: ["keep"] });
    const save = api.saveData(["first song"]);
    account = "second";
    requests[7].resolve(new Response("true"));
    await save;
    assert.deepEqual(Array.from(songs.getState().users.first.data), ["first song"]);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    account = "first";
    const read = api.getData();
    account = "second";
    requests[8].resolve(new Response('["read first"]'));
    await read;
    assert.deepEqual(Array.from(songs.getState().users.first.data), ["read first"]);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    account = "first";
    const deletion = api.deleteData();
    auth.getState().setToken("new-login", "new-refresh", "first");
    auth.getState().setToken("keep-login", "keep-refresh", "second");
    account = "second";
    requests[9].resolve(new Response("true"));
    await deletion;
    assert.equal(songs.getState().users.first, undefined);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    assert.equal(auth.getState().getToken("first").access, "new-login");
    assert.equal(auth.getState().getToken("second").access, "keep-login");
    account = "first";
    const refreshedDeletion = api.deleteData();
    requests[10].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    requests[11].resolve(new Response("new-login-refreshed"));
    await setImmediate();
    requests[12].resolve(new Response("true"));
    await refreshedDeletion;
    assert.equal(auth.getState().getToken("first"), undefined, "deletion signs out the same refresh session");
    assert.equal(auth.getState().getToken("second").access, "keep-login");
    await assert.rejects(api.authFetch("https://other.example/api/data"), /Invalid Song Spotlight URL/);
    assert.equal(requests.length, 13, "foreign URLs never receive credentials");
});

test("Song Spotlight OAuth accepts only its redirect and the initiating account", async () => {
    let account = "first";
    let token: object | undefined;
    let callback: (value: { location: string; }) => Promise<void> = async () => assert.fail("modal missing");
    const requests: Array<{ options: RequestInit; resolve(response: Response): void; }> = [];
    const writes: string[] = [];
    const redirectURL = "https://dc.songspotlight.nexpid.xyz/api/auth/authorize";
    const { presentOAuth2Modal } = loadSource("src/equicordplugins/songSpotlight.desktop/lib/oauth2.tsx", {
        "@vencord/discord-types/enums": { ApplicationIntegrationType: {} },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            OAuth2AuthorizeModal: "modal", openModal: (render: (props: object) => void) => render({}),
            showToast() {}, Toasts: { Type: {} },
        },
        "./api": { apiConstants: { oauth2: { redirectURL } }, getData: async () => {} },
        "./utils": { logger: { error() {} } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({
            getToken: () => token,
            setToken: (_access: string, _refresh: string, userId: string) => writes.push(userId),
        }) } },
    }, {
        URL,
        React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; } },
        fetch: (_url: URL, options: RequestInit) => new Promise<Response>(resolve => requests.push({ options, resolve })),
    });
    presentOAuth2Modal();
    await callback({ location: "https://other.example/api/auth/authorize?code=code" });
    await callback({ location: "https://dc.songspotlight.nexpid.xyz/other?code=code" });
    assert.equal(requests.length, 0);
    const first = callback({ location: `${redirectURL}?code=code` });
    assert.equal(requests[0].options.headers, undefined, "the code exchange does not send stored credentials");
    assert.equal(requests[0].options.redirect, "error");
    account = "second";
    requests[0].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await first;
    assert.equal(writes.length, 0);
    presentOAuth2Modal();
    const superseded = callback({ location: `${redirectURL}?code=code` });
    token = {};
    requests[1].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await superseded;
    assert.equal(writes.length, 0);
    presentOAuth2Modal();
    const valid = callback({ location: `${redirectURL}?code=code` });
    requests[2].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await valid;
    assert.deepEqual(writes, ["second"]);
});

function loadComponent(path: string, hooks: Record<string, unknown> = {}, additionalMocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@webpack/common": { React, TextInput: "input", ...hooks },
        "@components/BaseText": { BaseText: "div" },
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "./Common": { SettingsSection: "section", resolveError: (result: boolean | string) => result === true ? null : result || "Invalid input provided" },
        "@utils/css": { classNameFactory: (prefix: string) => (...names: string[]) => names.map(name => prefix + name).join(" ") },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") },
        ...additionalMocks
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

test("hidden channel member requests omit missing owners and duplicate IDs", () => {
    const requests: { userIds: string[]; }[] = [];
    let ownerId: string | undefined;
    const enums = {
        ...loadSource("packages/discord-types/enums/channel.ts", {}),
        ...loadSource("packages/discord-types/enums/voice.ts", {})
    };
    const { default: Screen } = loadSource("src/plugins/showHiddenChannels/components/HiddenChannelLockScreen.tsx", {
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@plugins/permissionsViewer": { __esModule: true, default: { name: "PermissionsViewer" } },
        "@plugins/permissionsViewer/components/RolesAndUsersPermissions": {},
        "@plugins/permissionsViewer/utils": {},
        "@utils/misc": { classes: () => "" },
        "@utils/text": {},
        "@vencord/discord-types/enums": enums,
        "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({}), findComponentByCodeLazy: () => null },
        "@webpack/common": {
            GuildStore: { getGuild: () => ownerId ? { ownerId } : undefined },
            GuildMemberStore: { getMember: () => null },
            FluxDispatcher: { dispatch: (request: { userIds: string[]; }) => requests.push(request) },
            PermissionStore: { can: () => false }, PermissionsBits: {},
            useState: () => [[], () => {}], useEffect: (effect: () => void) => effect()
        },
        "..": { cl: () => "", settings: { use: () => ({}) } }
    }, { React: { createElement: () => null } });
    const channel = { id: "channel", guild_id: "guild", type: 0, permissionOverwrites: {}, isNSFW: () => false, isForumChannel: () => false, isGuildVoice: () => false, isGuildStageVoice: () => false, hasFlag: () => false };
    Screen({ channel });
    assert.equal(requests.length, 0);
    ownerId = "owner";
    Screen({ channel: { ...channel, permissionOverwrites: { owner: { type: 1, id: "owner" }, other: { type: 1, id: "other" } } } });
    assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0].userIds), ["owner", "other"]);
});

test("quest progress uses the current Discord store after automation removal", () => {
    const taskTypes = new Proxy({}, { get: (_target, key) => key });
    const task = { type: "WATCH_VIDEO", target: 100 };
    const quest = { id: "quest", config: { taskConfigV2: { tasks: { WATCH_VIDEO: task } } }, userStatus: { progress: { WATCH_VIDEO: { value: 25 } } } };
    const { getQuestPanelPercentComplete } = loadSource("src/equicordplugins/questify/utils/questState.ts", {
        "@vencord/discord-types/enums": { QuestTaskType: taskTypes },
        "@webpack/common": { QuestStore: { getQuest: () => quest } },
        "../settings/access": {},
        "../settings/def": {},
        "./filtering": {}
    });
    assert.equal(getQuestPanelPercentComplete({ quest: { id: "quest" } }).percentComplete, 0.25);
    quest.userStatus.progress.WATCH_VIDEO.value = 80;
    assert.equal(getQuestPanelPercentComplete({ quest: { id: "quest" }, percentCompleteText: "native" }).percentCompleteText, "80%");
    assert.equal(getQuestPanelPercentComplete({ quest: null }), null);
});

test("quest settings migration removes retired automation state and preserves preferences", () => {
    const current = { enabled: true, migrationVersion: 1, questButtonDisplay: "never", ignoredQuestIDs: { questIDs: ["keep"] }, resumeQuestIDs: { user: ["old"] }, autoCompleteQuestTypes: { WATCH_VIDEO: true } };
    const plain = { plugins: { Questify: current } };
    let saves = 0;
    const mocks = {
        "@api/Settings": { PlainSettings: plain, SettingsStore: { markAsChanged: () => saves++ }, definePluginSettings: (value: object) => value },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/types": { OptionType: {} },
        "../components/questButtonSettings": {},
        "../components/questFeaturesSetting": {},
        "../components/questNotificationsSetting": {},
        "../components/questTilesSetting": {},
        "../components/reorderQuestsSetting": {},
        "./def": { defaultQuestOrder: [] }
    };
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(current.migrationVersion, 2);
    assert.equal(current.questButtonDisplay, "never");
    assert.deepEqual(current.ignoredQuestIDs, { questIDs: ["keep"] });
    assert.equal("resumeQuestIDs" in current, false);
    assert.equal("autoCompleteQuestTypes" in current, false);
    assert.equal(saves, 1);
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(saves, 1);
    current.migrationVersion = 0;
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(plain.plugins.Questify.migrationVersion, 2);
    assert.equal(plain.plugins.Questify.enabled, true);
    assert.equal(saves, 2);
});

test("quest sort settings keep every status exactly once", () => {
    const defaults = ["UNCLAIMED", "CLAIMED", "IGNORED", "EXPIRED"];
    const mocks = {
        "../settings/access": {},
        "../settings/def": { defaultQuestOrder: defaults },
        "../settings/rerender": {},
        "../settings/ignoredQuests": {},
        "./questState": {},
        "./ui": { q: (value: string) => value },
        "./shared": {}
    };
    const sanitizers = [
        loadSource("src/equicordplugins/questify/components/reorderQuestsSetting.tsx", mocks, {}, "sanitizeQuestOrder"),
        loadSource("src/equicordplugins/questify/utils/questTiles.ts", mocks, {}, "getValidQuestOrder")
    ];
    for (const sanitize of sanitizers) {
        assert.deepEqual(Array.from(sanitize(["EXPIRED", "EXPIRED", "invalid", "CLAIMED"])), ["EXPIRED", "CLAIMED", "UNCLAIMED", "IGNORED"]);
        assert.deepEqual(Array.from(sanitize(null)), defaults);
        assert.deepEqual(Array.from(sanitize(defaults)), defaults);
    }
});

test("quest names only remove a separate Quest suffix", () => {
    const { normalizeQuestName } = loadSource("src/equicordplugins/questify/utils/filtering.ts", {});
    for (const [name, expected] of [
        [" Conquest ", "CONQUEST"], ["Request", "REQUEST"], ["Game Quest", "GAME"],
        ["Game   Quest ", "GAME"], ["Quest", ""], ["Game", "GAME"]
    ]) {
        assert.equal(normalizeQuestName({ config: { messages: { questName: name } } }), expected);
    }
});

test("profile images fall back after failed guild downloads", async () => {
    const urls: string[] = [];
    let blobReads = 0;
    const processImage = loadSource("src/equicordplugins/profileSets/utils/profile.ts", {
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@webpack": { findStoreLazy: () => ({}) },
        "@webpack/common": {}
    }, {
        fetch: async (url: string) => {
            urls.push(url);
            return { ok: !url.includes("/guilds/"), blob: async () => { blobReads++; return {}; } };
        },
        FileReader: class {
            result = "data:image/png;base64,fixture";
            onloadend = () => {};
            readAsDataURL() { this.onloadend(); }
        }
    }, "processImage");
    assert.equal(await processImage("avatar", "user", "avatar", "guild", true), "data:image/png;base64,fixture");
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/guilds\/guild\/users\/user\/avatars\//);
    assert.match(urls[1], /\/avatars\/user\//);
    assert.equal(blobReads, 1);
});

test("primary stream audio reads stores initialized after module evaluation", () => {
    const common: Record<string, unknown> = {};
    const logic = loadSource("src/equicordplugins/primaryStreamAudio/logic.ts", {});
    const { default: plugin } = loadSource("src/equicordplugins/primaryStreamAudio/index.ts", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": common,
        "./logic": logic
    }, { document: { querySelectorAll: () => [] } });
    const first = { id: "owner-a", _speakingFlags: 2 };
    const second = { id: "owner-b", _speakingFlags: 2 };
    plugin.getAudioElementVolume(first);
    assert.equal(plugin.getAudioElementVolume(second), 1);
    let selected = "owner-a";
    common.SelectedChannelStore = { getVoiceChannelId: () => "channel" };
    common.ChannelRTCStore = { getSelectedParticipant: () => ({ stream: { channelId: "channel", ownerId: selected } }) };
    assert.equal(plugin.getAudioElementVolume(second), 0);
    assert.equal(plugin.getAudioElementVolume(first), 1);
    selected = "owner-b";
    assert.equal(plugin.getAudioElementVolume(first), 0);
    assert.equal(plugin.getAudioElementVolume(second), 1);
});

test("background audio position effects settle after clamping", () => {
    type Position = { left: number; top: number; } | null;
    let position: Position = null;
    let refIndex = 0;
    const effects: (() => void)[] = [];
    const viewport = { innerWidth: 800, innerHeight: 600 };
    const widget = { getBoundingClientRect: () => ({ width: 200, height: 100 }) };
    const render = loadSource("src/equicordplugins/persistentAudioPlayback/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 1 } },
        "@webpack/common": { React: {
            useReducer: () => [0, () => {}],
            useState: () => [position, (update: (current: Position) => Position) => { position = update(position); }],
            useRef: () => ({ current: refIndex++ === 1 ? widget : null }),
            useCallback: (callback: () => void) => callback,
            useEffect: (effect: () => void) => effects.push(effect)
        } }
    }, { window: viewport }, "DetachedAudioWidget");
    render();
    const clamp = effects[effects.length - 1];
    clamp();
    assert.equal(position, null);
    const dragged = { left: 100, top: 100 };
    position = dragged;
    clamp();
    assert.equal(position, dragged);
    viewport.innerWidth = 250;
    viewport.innerHeight = 180;
    clamp();
    assert.equal(JSON.stringify(position), JSON.stringify({ left: 42, top: 72 }));
    const clamped = position;
    clamp();
    assert.equal(position, clamped);
});

test("new plugin notifications return failures to the flux dispatcher", async () => {
    const { default: plugin } = loadSource("src/equicordplugins/newPluginsManager/index.tsx", {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./knownSettings": {},
        "./NewPluginsModal": { openNewPluginsModal: async () => { throw new Error("Storage unavailable"); } }
    });
    await assert.rejects(plugin.flux.POST_CONNECTION_OPEN(), /Storage unavailable/);
});

test("Tidal clears the previous track and position on an empty playback update", () => {
    let changes = 0;
    const { TidalStore: store } = loadSource("src/equicordplugins/musicControls/tidal/TidalStore.ts", {
        "@utils/Logger": { Logger: class {} },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() { changes++; } } }, FluxDispatcher: {} },
        "../settings": { settings: { store: {} } }
    }, { WebSocket: class { addEventListener() {} } });
    const fields = { track: { id: 1, title: "Song", artist: { name: "Artist" }, duration: 120 }, currentTime: 15, playing: true };
    store.socket.onChange({ type: "update", all: true, fields });
    const track = store.track;
    assert.equal(track.name, "Song");
    assert.equal(store.mPosition, 15000);
    store.socket.onChange({ type: "update", all: true, fields: { ...fields, currentTime: 16 } });
    assert.equal(store.track, track);
    assert.equal(store.mPosition, 16000);
    store.socket.onChange({ type: "update", all: true, fields: { track: null, currentTime: 0, playing: false } });
    assert.equal(store.track, null);
    assert.equal(store.mPosition, 0);
    assert.equal(store.isPlaying, false);
    assert.equal(changes, 3);
});

test("MusicControls reconnects cached Tidal stores without initializing unused stores", async () => {
    const cached = Symbol("cached");
    const tidal: Record<symbol, object> = {};
    const lyrics: Record<symbol, object> = {};
    const calls: string[] = [];
    const { default: plugin } = loadSource("src/equicordplugins/musicControls/index.tsx", {
        "@components/ErrorBoundary": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/lazy": { SYM_LAZY_CACHED: cached },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./settings": { settings: { store: {} }, toggleHoverControls() {} },
        "./spotify/lyrics/api": { migrateOldLyrics: async () => {} },
        "./spotify/lyrics/components/lyrics": {},
        "./spotify/PlayerComponent": {},
        "./tidal/lyrics/components/lyrics": {},
        "./tidal/lyrics/providers/store": { TidalLrcStore: lyrics },
        "./tidal/TidalPlayer": {},
        "./tidal/TidalStore": { TidalStore: tidal }
    });
    await plugin.start();
    plugin.stop();
    assert.equal(calls.length, 0);
    tidal[cached] = { socket: { reconnect: () => calls.push("connect") }, destroy: () => calls.push("disconnect") };
    lyrics[cached] = { init: () => calls.push("subscribe"), destroy: () => calls.push("unsubscribe") };
    for (let i = 0; i < 2; i++) {
        await plugin.start();
        plugin.stop();
    }
    assert.deepEqual(calls, ["connect", "subscribe", "unsubscribe", "disconnect", "connect", "subscribe", "unsubscribe", "disconnect"]);
});

test("Tidal lyrics resume after shutdown and ignore old requests", async () => {
    const listeners = new Set<() => void>();
    const requests: ((lyrics: { time: number; text: string; }[]) => void)[] = [];
    const tidal = {
        track: { id: "track" },
        addChangeListener: (listener: () => void) => listeners.add(listener),
        removeChangeListener: (listener: () => void) => listeners.delete(listener)
    };
    const { TidalLrcStore: store } = loadSource("src/equicordplugins/musicControls/tidal/lyrics/providers/store.ts", {
        "@api/Notifications": { showNotification() {} },
        "@equicordplugins/musicControls/settings": { settings: { store: {} } },
        "@equicordplugins/musicControls/tidal/lyrics/api": { getLyrics: () => new Promise(resolve => requests.push(resolve)) },
        "@equicordplugins/musicControls/tidal/TidalStore": { TidalStore: tidal },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() {} } }, FluxDispatcher: {} }
    });
    store.init();
    store.init();
    assert.equal(listeners.size, 1);
    assert.equal(requests.length, 1);
    store.destroy();
    assert.equal(listeners.size, 0);
    store.init();
    assert.equal(listeners.size, 1);
    assert.equal(requests.length, 2);
    requests[0]([{ time: 0, text: "old" }]);
    await setImmediate();
    assert.equal(store.lyrics, null);
    requests[1]([{ time: 0, text: "current" }]);
    await setImmediate();
    assert.equal(store.lyrics[0].text, "current");
    store.destroy();
    assert.equal(listeners.size, 0);
});

test("lyrics fetching respects disabled fallback for either selected provider", async () => {
    for (const lyricsProvider of ["Spotify", "LRCLIB"]) {
        for (const fallbackProvider of [false, true]) {
            const calls: string[] = [];
            const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/api.tsx", {
                "@api/index": { DataStore: { get: async () => ({}), set: async () => {} } },
                "@equicordplugins/musicControls/settings": { settings: { store: { lyricsProvider, fallbackProvider } } },
                "./providers/types": { Provider: { Spotify: "Spotify", Lrclib: "LRCLIB" } },
                "./providers/SpotifyAPI": { getLyricsSpotify: async () => { calls.push("Spotify"); return null; } },
                "./providers/lrclibAPI": { getLyricsLrclib: async () => { calls.push("LRCLIB"); return null; } }
            });
            assert.equal(await module.getLyrics({ id: "track" }), null);
            assert.deepEqual(calls, fallbackProvider ? [lyricsProvider, lyricsProvider === "Spotify" ? "LRCLIB" : "Spotify"] : [lyricsProvider]);
        }
    }
});

test("LRCLIB preserves timestamp precision and bracketed lyric text", async () => {
    const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/providers/lrclibAPI/index.ts", {
        "@equicordplugins/musicControls/spotify/lyrics/providers/types": { Provider: { Lrclib: "LRCLIB" } }
    }, { URLSearchParams, fetch: async () => ({ ok: true, json: async () => ({
        syncedLyrics: "[ar:Artist]\n[00:24]First [echo]\n[01:02.345]Second\n[02:03.5]♪\ninvalid\n[00:99]invalid seconds"
    }) }) });
    const result = await module.getLyricsLrclib({ name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration: 200000 });
    assert.equal(JSON.stringify(result.lyricsVersions.LRCLIB), JSON.stringify([
        { time: 24, text: "First [echo]" }, { time: 62.345, text: "Second" }, { time: 123.5, text: null }
    ]));
});

test("music lyrics translation uses the selected target language", async () => {
    const requests: URL[] = [];
    const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/providers/translator/index.ts", {
        "@equicordplugins/musicControls/settings": { settings: { store: { translateTo: "nl" } } },
        "@equicordplugins/musicControls/spotify/lyrics/providers/types": { Provider: { Translated: "Translated", Romanized: "Romanized" } }
    }, { URLSearchParams, fetch: async (url: string) => {
        requests.push(new URL(url));
        return { ok: true, json: async () => ({ sentences: [{ trans: "Hallo" }] }) };
    } });
    const lyrics = await module.lyricsAlternativeFetchers.Translated([{ time: 1, text: "Hello" }]);
    assert.equal(requests[0].searchParams.get("tl"), "nl");
    assert.equal(lyrics[0].text, "Hallo");
    assert.equal(lyrics[0].time, 1);
});

test("static sticker conversion labels PNG output and releases its temporary URL", async () => {
    const files: File[] = [];
    let revoked = 0;
    class TestImage {
        width = 200;
        height = 100;
        onload = () => {};
        set src(_value: string) { this.onload(); }
    }
    const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
        "@ffmpeg/ffmpeg": { FFmpeg: class {} }, "@utils/discord": {},
        "@vencord/discord-types/enums": {},
        "@webpack/common": {
            PendingReplyStore: { getPendingReply: () => null }, DraftStore: { getDraft: () => "" },
            ChannelStore: { getChannel: () => ({ id: "channel" }) },
            UploadHandler: { promptToUpload: (uploads: File[]) => files.push(...uploads) }
        },
        ".": { settings: { store: { promptToUpload: true } } },
        "./utils": { corsFetch: async () => ({ ok: true, blob: async () => new Blob() }) }
    }, {
        File, Blob, Image: TestImage,
        URL: class extends URL {
            static createObjectURL() { return "blob:fixture"; }
            static revokeObjectURL() { revoked++; }
        },
        document: { createElement: () => ({
            getContext: () => ({ drawImage() {} }),
            toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob(["PNG fixture"], { type }))
        }) }
    });
    for (const filename of ["cat.jpg", "cat", ""]) {
        await module.sendSticker({ channelId: "channel", sticker: { image: "https://example.com/", filename }, ctrlKey: false, shiftKey: false });
    }
    assert.deepEqual(files.map(file => file.name), ["cat.png", "cat.png", "sticker.png"]);
    assert.equal(files.every(file => file.type === "image/png"), true);
    assert.equal(revoked, 3);
});

test("mic loopback stop restores only deafening applied by the plugin", async () => {
    for (const initiallyDeaf of [false, true]) {
        let deaf = initiallyDeaf;
        let finish: () => void = () => {};
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        const module = loadSource("src/equicordplugins/micLoopbackTester/index.tsx", {
            "@api/UserArea": {}, "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: "self" }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
                MediaEngineStore: { isSelfDeaf: () => deaf },
                VoiceActions: {
                    setLoopback: (_name: string, active: boolean) => active ? Promise.resolve() : stopped,
                    toggleSelfDeaf: () => { deaf = !deaf; }
                }
            }
        }, {}, "({ plugin: exports.default, enableLoopback })");
        await module.enableLoopback();
        assert.equal(deaf, true);
        const pending = module.plugin.stop();
        assert.equal(deaf, true);
        finish();
        await pending;
        assert.equal(deaf, initiallyDeaf);
    }
});

test("middle click settings preserve paste protection and stopped listeners stay removed", () => {
    const listeners = new Map<string, (event: object) => void>();
    const store = { openScope: "links", pasteScope: "always", pasteThreshold: 100 };
    const plugin = loadSource("src/equicordplugins/middleClickTweaks/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/index": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} }
    }, { document: {
        addEventListener: (name: string, callback: (event: object) => void) => listeners.set(name, callback),
        removeEventListener: (name: string, callback: (event: object) => void) => {
            assert.equal(listeners.get(name), callback);
            listeners.delete(name);
        }
    } }).default;
    plugin.start();
    store.openScope = "none";
    plugin.settings.def.openScope.onChange?.("none");
    listeners.get("mouseup")?.({ button: 1 });
    assert.equal(plugin.isPastingDisabled(true), true);
    plugin.stop();
    store.openScope = "links";
    plugin.settings.def.openScope.onChange?.("links");
    assert.equal(listeners.size, 0);
});

test("logger export iteration preserves stored attachment URLs without populating display caches", async () => {
    const record = { message_id: "1", message: { attachments: [{ url: "https://example.com/image.png", proxy_url: "https://example.com/proxy.png" }] } };
    const module = loadSource("src/equicordplugins/messageLoggerEnhanced/db.ts", {
        "@webpack/common": {},
        idb: { openDB: async () => ({ transaction: () => ({ store: { openCursor: async () => ({ value: record, continue: async () => null }) } }) }) },
        "./utils": {}, "./utils/cleanUp": { stripTransientRenderState: () => assert.fail("Export must not prepare display records") },
        "./utils/constants": {},
        "./utils/saveImage": { getAttachmentBlobUrl: () => assert.fail("Export must not read attachment files") }
    });
    await setImmediate();
    const batches: (typeof record)[][] = [];
    for await (const batch of module.iterateAllMessagesIDB()) batches.push(batch);
    assert.equal(batches.length, 1);
    assert.equal(batches[0][0], record);
    assert.equal(record.message.attachments[0].url, "https://example.com/image.png");
    assert.equal(module.cachedMessages.size, 0);
});

test("native logger imports preserve Unicode across bounded chunks", async () => {
    const text = "a".repeat(65535) + "🛒é終";
    const bytes = Buffer.from(text);
    let position = 0;
    let closed = 0;
    const module = loadSource("src/equicordplugins/messageLoggerEnhanced/native/import.ts", {
        "node:crypto": { randomUUID: () => "fixture" },
        "node:fs/promises": { open: async () => ({
            async read(target: Buffer, offset: number, length: number) {
                assert.equal(length, 65536);
                const bytesRead = bytes.copy(target, offset, position, position + length);
                position += bytesRead;
                return { bytesRead };
            },
            async close() { closed++; }
        }) },
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["fixture.json"] }) } }
    }, { Buffer, TextDecoder });
    const id = await module.startNativeLogImport({});
    let result = "";
    for (;;) {
        const chunk = await module.readNativeLogChunk({}, id, Number.MAX_SAFE_INTEGER);
        if (chunk === null) break;
        result += chunk;
    }
    assert.equal(result, text);
    await module.closeNativeLogImport({}, id);
    assert.equal(closed, 1);
});

test("MessageBurst retains outgoing text until its edit resolves", async () => {
    for (const success of [false, true]) {
        let finish: () => void = () => {};
        const edit = new Promise<void>((resolve, reject) => { finish = () => success ? resolve() : reject(new Error("Edit failed")); });
        const plugin = loadSource("src/equicordplugins/messageBurst/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: { timePeriod: 3 } }) },
            "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
            "@webpack/common": {
                ChannelStore: { getChannel: () => ({ isGroupDM: () => false }) },
                MessageStore: { getMessages: () => ({ last: () => ({ id: "previous", author: { id: "self" }, content: "First", timestamp: new Date() }) }) },
                UserStore: { getCurrentUser: () => ({ id: "self" }) },
                MessageActions: { editMessage: () => edit }
            }
        }, { document: { querySelector: () => null } }).default;
        const outgoing = { content: "Second" };
        const pending = plugin.onBeforeMessageSend("channel", outgoing);
        assert.equal(outgoing.content, "Second");
        finish();
        if (success) await pending;
        else await assert.rejects(pending, /Edit failed/);
        assert.equal(outgoing.content, success ? "" : "Second");
    }
});

test("LimitlessScreenshare preserves source resolution when changing frame rate", () => {
    let resolution: number | undefined = 0;
    const plugin = loadSource("src/equicordplugins/limitlessScreenshare/index.tsx", {
        "@utils/constants": { EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": {
            MediaEngineStore: { getState: () => ({ goLiveSource: { quality: { resolution, frameRate: 30 } } }) },
            Menu: { MenuRadioItem: "radio" }
        },
        "./CustomRange": { CustomRange: (props: object) => ({ props }) },
        "./settings": { MIN_FPS: 1, MIN_RESOLUTION: 3, settings: { store: { maxFPS: 120, maxResolution: 1080, roundResolution: false, resolutions: [], fpss: [{ label: "60fps", value: 60 }] } } }
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } }).default;
    const updates: number[] = [];
    const controls = plugin.SettingsRange((_enabled: boolean, value: number) => updates.push(value), [true, "fixture"], false);
    controls[0].props.onChange(60);
    controls[1].props.action();
    assert.deepEqual(updates, [0, 0]);
    resolution = undefined;
    controls[0].props.onChange(60);
    assert.equal(updates[2], 720);
});

test("InvisibleChat displays decrypted URLs without requesting a preview", async () => {
    let updated = false;
    const module = loadSource("src/equicordplugins/invisibleChat.desktop/index.tsx", {
        "@api/ChatButtons": {}, "@api/Settings": { definePluginSettings: () => ({}) },
        "@api/MessageUpdater": { updateMessage: () => { updated = true; } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} }, "@utils/dependencies": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} },
        "@webpack/common": {}, "./components/DecryptionModal": {}, "./components/EncryptionModal": {}
    });
    const message = { channel_id: "channel", id: "message", embeds: [] as { rawDescription: string; }[] };
    const plaintext = "Private link: https://example.test/private-token";
    await module.buildEmbed(message, plaintext);
    assert.equal(updated, true);
    assert.equal(message.embeds.length, 1);
    assert.equal(message.embeds[0].rawDescription, plaintext);
});

test("InstantScreenshare never substitutes a different media source", async () => {
    const selected = { id: "window:selected", name: "Selected window" };
    let sources = [{ id: "screen:other", name: "Other screen" }, selected];
    let failures = 0;
    const module = loadSource("src/equicordplugins/instantScreenshare/utils.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { streamMedia: selected.id, includeVideoDevices: false } }) },
        "@components/Heading": {}, "@components/margins": {}, "@components/Paragraph": {},
        "@utils/constants": {}, "@utils/Logger": { Logger: class {} },
        "@utils/types": { OptionType: {} },
        "@webpack": { findByCodeLazy: () => async () => sources, findByPropsLazy: () => ({}) },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({}) }, showToast: () => { failures++; }, Toasts: { Type: {} } }
    });
    assert.equal(await module.getCurrentMedia(), selected);
    sources = [sources[0]];
    assert.equal(await module.getCurrentMedia(), null);
    assert.equal(module.settings.store.streamMedia, selected.id);
    sources = [];
    assert.equal(await module.getCurrentMedia(), null);
    assert.equal(failures, 2);
});

test("HideServers shutdown only persists pending edits", async () => {
    let finishLoad: (value: string[]) => void = () => {};
    const writes: string[][] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const { HiddenServersStore: store } = loadSource("src/equicordplugins/hideServers/HiddenServersStore.ts", {
        "@api/DataStore": {
            get: () => new Promise<string[]>(resolve => { finishLoad = resolve; }),
            set: (_key: string, value: string[]) => { writes.push(Array.from(value)); }
        },
        "@webpack": { proxyLazyWebpack: (factory: () => object) => factory(), findStoreLazy: () => ({}) },
        "@webpack/common": { Flux: { Store: class { emitChange() {} } }, FluxDispatcher: {}, GuildStore: {} }
    }, {
        setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id: number) => timers.delete(id)
    });
    const loading = store.load();
    store.unload();
    finishLoad(["saved"]);
    await loading;
    assert.deepEqual(writes, []);
    assert.equal(store.hiddenGuilds.size, 0);
    store.addHiddenGuild("edited");
    store.unload();
    assert.deepEqual(writes, [["edited"]]);
    assert.equal(timers.size, 0);
    store.unload();
    assert.equal(writes.length, 1);
});

test("GitHub profile tab renders loading and failure messages", () => {
    for (const [loading, error, expected] of [[true, null, "Loading repositories..."], [false, "Request failed", "Request failed"]] as const) {
        let index = 0;
        const values = [[], loading, error, null];
        const tab = loadComponent("src/equicordplugins/githubRepos/components/ProfileTabComponent.tsx", {
            useState: () => [values[index++], () => {}], useEffect: () => {}
        }, {
            "@equicordplugins/githubRepos/githubApi": {},
            "..": { cl: (name: string) => name, settings: { store: {} } }, "./RepoCard": {}
        });
        const result = tab.ProfileTabComponent({ id: "fixture" });
        assert.ok(JSON.stringify(result).includes(expected));
    }
});

test("GIF collection extensions handle URL schemes, case and malformed input", () => {
    const extension = loadSource("src/equicordplugins/gifCollections/utils/getUrlExtension.ts", {
        "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } }
    });
    for (const url of ["https://example.test/file.MP4?x=1", "http://example.test/file.mp4", "//example.test/file.mp4"]) {
        assert.equal(extension.getUrlExtension(url), "mp4");
    }
    for (const url of ["not a URL", "https://example.test/path", "https://example.test/folder.mp4/file"]) {
        assert.equal(extension.getUrlExtension(url), undefined);
    }
    const format = loadSource("src/equicordplugins/gifCollections/utils/getFormat.ts", {
        "../types": { Format: { IMAGE: 1, VIDEO: 2 } }, "./getUrlExtension": extension
    });
    assert.equal(format.getFormat("https://media.tenor.com/file.GIF"), 1);
    assert.equal(format.getFormat("https://media.tenor.com/file.MP4"), 2);
    const audio = loadSource("src/equicordplugins/gifCollections/utils/isAudio.ts", { "./getUrlExtension": extension });
    assert.equal(audio.isAudio("http://example.test/file.MP3"), true);
});

test("Friendship ranks cover milestone days without gaps or duplicate badges", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    let days = 0;
    let friend = true;
    const ranks = loadSource("src/equicordplugins/friendshipRanks/index.tsx", {
        "@api/Badges": { BadgePosition: {} }, "@components/ErrorBoundary": {}, "@components/Flex": {},
        "@components/Paragraph": {}, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { RelationshipStore: { isFriend: () => friend, getSince: () => new Date(now - days * 86400000).toISOString() } }
    }, { Date: class extends Date { constructor(value: string | number = now) { super(value); } } });
    const badges: { description: string; shouldShow(info: { userId: string; }): boolean; }[] = ranks.default.userProfileBadges;
    const shown = () => badges.filter(badge => badge.shouldShow({ userId: "fixture" })).map(badge => badge.description);
    for (const [age, title] of [[0, "Sprout"], [29, "Sprout"], [30, "Blooming"], [90, "Burning"], [182, "Burning"], [183, "Fighter"], [365, "Star"], [730, "Royal"], [1826, "Royal"], [1827, "Besties"]] as const) {
        days = age;
        assert.equal(JSON.stringify(shown()), JSON.stringify([title]));
    }
    friend = false;
    assert.equal(shown().length, 0);
});

test("Friend codes clear only after successful revocation", async () => {
    for (const success of [false, true]) {
        let finish: () => void = () => {};
        const request = new Promise<void>((resolve, reject) => { finish = () => success ? resolve() : reject(new Error("Failed")); });
        let cleared = false;
        let failed = false;
        let hook = 0;
        const panel = loadComponent("src/equicordplugins/friendCodes/FriendCodesPanel.tsx", {
            useState: () => hook++ === 0 ? [[{ code: "fixture" }], () => { cleared = true; }] : [false, () => {}],
            useEffect: () => {}, Button: { Colors: {}, Looks: {} },
            showToast: () => { failed = true; }, Toasts: { Type: {} }
        }, {
            "@components/Flex": { Flex: "flex" }, "@components/Heading": { Heading: "heading" },
            "@utils/clipboard": {}, "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({ revokeFriendInvites: () => request }) }
        });
        const tree = panel.default();
        const button = tree.props.children[0].props.children[1].props.children[1].props.children[1];
        const pending = button.props.onClick();
        assert.equal(cleared, false);
        finish();
        await pending;
        assert.equal(cleared, success);
        assert.equal(failed, !success);
    }
});

test("FontLoader uses the escaped selected family for body and code fonts", async () => {
    const store = { selectedFont: 'Font";{}', applyOnCodeBlocks: true };
    const elements: { textContent: string; remove(): void; }[] = [];
    const plugin = loadSource("src/equicordplugins/fontLoader/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), migratePluginSetting: () => {} },
        "@components/Card": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@shared/debounce": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/margins": {}, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}
    }, {
        CSS: { escape: (value: string) => { assert.equal(value, store.selectedFont); return "escaped-family"; } },
        document: { createElement: () => ({ textContent: "", remove() {} }), head: { appendChild: (element: typeof elements[number]) => elements.push(element) } }
    });
    await plugin.default.start();
    const css = elements[0].textContent;
    assert.equal((css.match(/escaped-family/g) || []).length, 4);
    assert.ok(css.includes("--font-code: escaped-family, monospace"));
    assert.equal(css.includes(store.selectedFont), false);
    store.applyOnCodeBlocks = false;
    await plugin.default.start();
    assert.equal(elements[0].textContent.includes("--font-code"), false);
});

test("Filename plugins preserve names and apply extension fixes without anonymizing", () => {
    const definitions = { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} };
    const fixer = loadSource("src/equicordplugins/fixFileExtensions/index.tsx", {
        "@api/PluginManager": {}, "@plugins/anonymiseFileNames": { tarExtMatcher: /\.tar\.\w+$/ },
        "@utils/constants": { Devs: {} }, "@utils/types": definitions
    });
    const store = { anonymiseByDefault: false, spoilerMessages: false, method: 1, consistent: "image" };
    const enabled = { enabled: true };
    const anonymizer = loadSource("src/plugins/anonymiseFileNames/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "@api/Settings": { definePluginSettings: () => ({ store }), Settings: { plugins: { FixFileExtensions: enabled } } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@equicordplugins/fixFileExtensions": fixer, "@utils/constants": { Devs: {} },
        "@utils/types": definitions, "@webpack": { findByCodeLazy: () => null }, "@webpack/common": {}
    });
    for (const [filename, expected] of [["README", "README"], ["archive.tar.gz", "archive.tar.gz"], ["photo.jpe", "photo.jpg"]]) {
        const direct = { filename };
        fixer.default.fixExt(direct);
        assert.equal(direct.filename, expected);
        const combined = { filename };
        anonymizer.default.anonymise(combined);
        assert.equal(combined.filename, expected);
    }
    enabled.enabled = false;
    store.spoilerMessages = true;
    const original = { filename: "photo.jpe" };
    anonymizer.default.anonymise(original);
    assert.equal(original.filename, "SPOILER_photo.jpe");
    enabled.enabled = true;
    store.anonymiseByDefault = true;
    const anonymous = { filename: "photo.jpe" };
    anonymizer.default.anonymise(anonymous);
    assert.equal(anonymous.filename, "SPOILER_image.jpg");
});

test("File upload destination selection respects disabled fallbacks and host order", () => {
    const types = loadSource("src/equicordplugins/fileUpload/types.ts", {});
    const store = { disableFallbacks: true, fallbackOrder: "" };
    const upload = loadSource("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": {}, "@equicordplugins/fileUpload/settings": { settings: { store } },
        "@equicordplugins/fileUpload/types": types, "@utils/clipboard": {}, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/web": {}, "@webpack/common": {},
        "./apngToGif": {}, "./getMediaUrl": {}, "./s3": {}, "./sharex": {}
    }, { IS_DISCORD_DESKTOP: false }, "({ buildUploadOrder })");
    assert.throws(() => upload.buildUploadOrder("catbox", "file.exe"), /Choose another service/);
    assert.throws(() => upload.buildUploadOrder("0x0", "file.png"), /Choose another service/);
    assert.equal(JSON.stringify(upload.buildUploadOrder("catbox", "file.png")), '["catbox"]');
    store.disableFallbacks = false;
    const order: string[] = upload.buildUploadOrder("catbox", "file.exe");
    assert.equal(order[0], "zipline");
    assert.equal(order.includes("catbox"), false);
    assert.equal(order.includes("0x0"), false);
    const supported: string[] = upload.buildUploadOrder("catbox", "file.png");
    assert.equal(supported[0], "catbox");
    assert.equal(supported.filter(service => service === "catbox").length, 1);
});

test("File uploads report failure, busy state and success", async () => {
    const upload = loadSource("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": {}, "@equicordplugins/fileUpload/settings": {},
        "@equicordplugins/fileUpload/types": { ServiceType: {}, serviceLabels: {} }, "@utils/clipboard": {}, "@utils/discord": {},
        "@utils/Logger": { Logger: class { error() {} } }, "@utils/web": {},
        "@webpack/common": { showToast: () => {}, Toasts: { Type: {} } },
        "./apngToGif": {}, "./getMediaUrl": {}, "./s3": {}, "./sharex": {}
    }, { IS_DISCORD_DESKTOP: false, setTimeout: () => 0 }, `
        isConfigured = () => true;
        isFileTypeAllowed = () => true;
        uploadPreparedBlob = async () => { throw new Error("Failed"); };
        ({ uploadProvidedFiles, succeed() { uploadPreparedBlob = async () => "url"; }, busy() { isUploading = true; },
            cancelLate() {
                cancelRequested = false;
                buildUploadOrder = () => ["fixture"];
                uploadToService = async () => { cancelRequested = true; return "url"; };
                return uploadWithFallbacks({ size: 1 }, "fixture.txt", "fixture");
            }
        });
    `);
    const files = [{ name: "fixture.txt" }];
    assert.equal(await upload.uploadProvidedFiles(files), false);
    assert.equal(await upload.uploadProvidedFiles([]), false);
    upload.succeed();
    assert.equal(await upload.uploadProvidedFiles(files), true);
    upload.busy();
    assert.equal(await upload.uploadProvidedFiles(files), false);
    await assert.rejects(upload.cancelLate(), /Upload cancelled by user/);
});

test("Draft attachments remain until their upload succeeds", async () => {
    let succeeded = false;
    let removed = 0;
    const draft = loadSource("src/equicordplugins/fileUpload/index.tsx", {
        "@api/ContextMenu": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findByPropsLazy: () => ({}) }, "@webpack/common": {},
        "./settings": { settings: {} }, "./types": {}, "./utils/getMediaUrl": {},
        "./utils/upload": { isConfigured: () => true, isFileTypeAllowed: () => true,
            uploadProvidedFiles: async () => succeeded, logger: { warn: () => {} } }
    }, {}, "({ handleUploadFileFromDraft })");
    const upload = { item: { file: {} }, removeFromMsgDraft: () => removed++ };
    await draft.handleUploadFileFromDraft(upload);
    assert.equal(removed, 0);
    succeeded = true;
    await draft.handleUploadFileFromDraft(upload);
    assert.equal(removed, 1);
});

test("ShareX response substitutions preserve literal dollar sequences", () => {
    const sharex = loadSource("src/equicordplugins/fileUpload/utils/sharex.ts", {});
    const response = "https://example.test/$&/$$/$`/$'";
    assert.equal(sharex.resolveShareXTemplate("$response$", response, null), response);
    assert.equal(sharex.resolveShareXTemplate("{response}", response, null), response);
});

test("Element highlighter escapes inspected text in its tooltip", () => {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    const highlighter = loadSource("src/equicordplugins/elementHighlighter.dev/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { showId: true, showClasses: true, showFont: true } }) },
        "@components/Button": {}, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/discord": {}, "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => null }, "@webpack/common": { lodash: { escape } }
    }, { HTMLElement: class {} }, "({ buildTooltipContent })");
    const payload = '<img src=x onerror="alert(1)">';
    const html = highlighter.buildTooltipContent({ tagName: "DIV", id: payload, className: payload, getAttribute: () => null },
        { color: "rgb(1, 2, 3)", fontFamily: payload, fontSize: "12px" }, { width: 20, height: 10 });
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes(escape(payload)));
    assert.ok(html.includes("20x10"));
});

test("Toolbox reflects plugin toggles without changing its search", () => {
    let enabled = true;
    let hook = 0;
    const memo: unknown[] = [];
    const menu = loadComponent("src/equicordplugins/equicordToolbox/menu.tsx", {
        Menu: {}, useState: () => ["", () => {}],
        useMemo: (factory: () => unknown) => { const index = hook++; return memo[index] ??= factory(); }
    }, {
        "@api/Notifications/notificationLog": {},
        "@api/PluginManager": { isPluginEnabled: () => enabled, isSettingHidden: () => false, isSettingDisabled: () => false,
            plugins: { Fixture: { name: "Fixture", settings: { def: { option: { type: 1 } } } } } },
        "@api/Settings": { useSettings: () => ({ plugins: { Fixture: { option: true } } }) },
        "@components/settings": {}, "@utils/react": {},
        "@utils/text": { wordsFromCamel: (value: string) => value, wordsToTitle: (value: string) => value },
        "@utils/types": { OptionType: { BOOLEAN: 1 } }, ".": {}
    });
    assert.ok(JSON.stringify(menu.buildPluginMenuEntries()).includes("Fixture-menu"));
    enabled = false;
    hook = 0;
    assert.equal(JSON.stringify(menu.buildPluginMenuEntries()).includes("Fixture-menu"), false);
});

test("Cancelling a dependency restart leaves the requested plugin disabled", async () => {
    const settings = { enabled: false };
    let confirm = false;
    let reloads = 0;
    const helper = loadSource("src/equicordplugins/equicordHelper/utils.tsx", {
        "@api/Notices": {},
        "@api/PluginManager": {
            plugins: { Fixture: { name: "Fixture" } },
            startDependenciesRecursive: () => ({ restartNeeded: true, failures: [] })
        },
        "@api/Settings": { Settings: { plugins: { Fixture: settings } } },
        "@webpack/common": { Alerts: { show: (options: { onCancel(): void; onConfirm(): void; }) => confirm ? options.onConfirm() : options.onCancel() } }
    }, { React: { createElement: () => null }, location: { reload: () => reloads++ } });
    assert.equal(await helper.toggleEnabled("Fixture"), false);
    assert.equal(settings.enabled, false);
    assert.equal(reloads, 0);
    confirm = true;
    assert.equal(await helper.toggleEnabled("Fixture"), true);
    assert.equal(settings.enabled, true);
    assert.equal(reloads, 1);
});

test("Desktop CSP preserves explicit hosts without allowing every origin", () => {
    const csp = loadSource("src/main/csp/index.ts", {
        "@main/settings": { NativeSettings: { store: { customCspRules: { "example.test": ["connect-src"] } } } },
        "electron": {}
    }, {}, "({ patchCsp })");
    const headers = { "content-security-policy": ["default-src 'self'; connect-src 'self'"] };
    csp.patchCsp(headers);
    const policy = headers["content-security-policy"][0];
    assert.equal(policy.split(/\s+/).includes("*"), false);
    assert.ok(policy.includes("api.github.com"));
    assert.ok(policy.includes("example.test"));
});

test("Dragify validates JSON fields before resolving a drop", () => {
    const drag = loadSource("src/equicordplugins/dragify/utils.ts", {});
    const stores = { ChannelStore: { getChannel: () => null }, GuildStore: { getGuild: () => null }, UserStore: { getUser: () => null } };
    const id = "123456789012345678";
    for (const payload of [{ kind: "user", id: 123 }, { kind: "user", id: "bad> @everyone" }, { kind: 42, id }, { type: {}, id }, { kind: "channel", id, guildId: [] }]) {
        assert.equal(drag.parseDragifyPayload(JSON.stringify(payload)), null);
        assert.equal(drag.parseFromStrings([JSON.stringify(payload)], stores), null);
    }
    assert.equal(drag.parseDragifyPayload(JSON.stringify({ kind: "user", id })).id, id);
    assert.equal(drag.parseFromStrings([JSON.stringify({ type: "channel", channelId: id, guildId: "@me" })], stores).guildId, "@me");
});

test("Dragify derives active drag state from the current entity", () => {
    const drag = loadSource("src/equicordplugins/dragify/dragState.ts", {}, { clearInterval, clearTimeout });
    for (const kind of ["user", "guild", "channel"]) {
        drag.beginDrag({ kind, id: "fixture" });
        assert.equal(drag.hasActiveDrag(), true);
        assert.equal(drag.isUserDragActive(), kind === "user");
        assert.equal(drag.isGuildDragActive(), kind === "guild");
        drag.clearDragState();
        assert.equal(drag.hasActiveDrag(), false);
        assert.equal(drag.isUserDragActive(), false);
        assert.equal(drag.isGuildDragActive(), false);
    }
});

test("Discord MCP handles response failures and cancels pending startup", async () => {
    const errors: string[] = [];
    let first = true;
    let stop = () => {};
    let polls = 0;
    let initialized = () => {};
    const initialization = new Promise<void>(resolve => { initialized = resolve; });
    const Native = {
        initializeBridge: () => initialization,
        async takeRequests() {
            polls++;
            if (first) { first = false; return [{ id: "fixture", tool: "unknown" }]; }
            stop(); return [];
        },
        async writeResponse() { throw new Error("Disk write failed"); }
    };
    const loaded = loadSource("src/equicordplugins/discordMcp.desktop/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/settings/tabs/plugins/components/Common": {},
        "@plugins/voiceMessages/waveform": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(message: string) { errors.push(message); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, defineDefault: (value: unknown) => value, OptionType: {} },
        "@vencord/discord-types/enums": {}, "@webpack/common": {},
        "../voiceMessageTranscriber.desktop/utils": {}, "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
    }, { VencordNative: { pluginHelpers: { DiscordMCP: Native } } }, "({ ...exports, bridgeLoop })");
    stop = loaded.default.stop;
    await loaded.bridgeLoop(0);
    await setImmediate();
    assert.deepEqual(errors, ["Bridge response failed"]);
    const previousPolls = polls;
    const starting = loaded.default.start();
    loaded.default.stop();
    initialized();
    await starting;
    await setImmediate();
    assert.equal(polls, previousPolls);
});

test("Discord MCP attachment downloads reject redirects and untrusted origins", async () => {
    let redirect = false;
    let oversized = false;
    let cancelled = false;
    let requests = 0;
    let deadline = 0;
    const fetchAttachmentData = loadSource("src/equicordplugins/discordMcp.desktop/native.ts", {
        "@main/utils/constants": { DATA_DIR: "/fixture" },
        crypto: {}, fs: {}, "fs/promises": {}, os: {}, path,
        "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
    }, {
        __dirname: "/fixture", Buffer, URL,
        AbortSignal: { timeout: (ms: number) => { deadline = ms; return new AbortController().signal; } },
        fetch: async (_url: URL, options?: RequestInit) => {
            requests++;
            if (redirect && options?.redirect === "error") throw new TypeError("Redirect blocked");
            if (oversized) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
                headers: { "content-length": String(26 * 1024 * 1024) }
            });
            return new Response("attachment", { headers: { "content-type": "image/png" } });
        }
    }, "fetchAttachmentData");
    for (const url of ["https://untrusted.invalid/attachments/a", "http://cdn.discordapp.com/attachments/a", "https://cdn.discordapp.com:8443/attachments/a", "https://cdn.discordapp.com/other/a"]) {
        await assert.rejects(fetchAttachmentData(url), /untrusted/);
    }
    assert.equal(requests, 0);
    const url = "https://cdn.discordapp.com/attachments/a";
    assert.equal((await fetchAttachmentData(url)).data.toString(), "attachment");
    assert.equal(deadline, 120_000);
    redirect = true;
    await assert.rejects(fetchAttachmentData(url), /Redirect blocked/);
    redirect = false;
    oversized = true;
    await assert.rejects(fetchAttachmentData(url), /25 MB/);
    assert.equal(cancelled, true);
});

test("cursor sprites release listeners, frames and body styles on cleanup", () => {
    for (const name of ["oneko", "fathorse"]) {
        const listeners = new Set<unknown>();
        const frames = new Map<number, (time: number) => void>();
        const nodes = new Set<object>();
        let frameId = 0;
        const events = {
            addEventListener: (_name: string, listener: unknown) => listeners.add(listener),
            removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener)
        };
        const body = {
            style: { transform: "scale(1)", willChange: "opacity" },
            appendChild(node: { parentElement: object | null; isConnected: boolean }) {
                node.parentElement = body; node.isConnected = true; nodes.add(node);
            }
        };
        const requestAnimationFrame = (callback: (time: number) => void) => { frames.set(++frameId, callback); return frameId; };
        const cancelAnimationFrame = (id: number) => frames.delete(id);
        const { default: start } = loadSource(`src/equicordplugins/cursorBuddy/${name}.js`, {}, {
            document: {
                ...events, body,
                createElement: () => ({
                    style: {}, parentElement: null, isConnected: false,
                    remove() { this.parentElement = null; this.isConnected = false; nodes.delete(this); }
                })
            },
            window: { ...events, requestAnimationFrame, cancelAnimationFrame, innerWidth: 1000, innerHeight: 800 },
            requestAnimationFrame, cancelAnimationFrame, Image: class {}
        });
        for (let i = 0; i < 3; i++) {
            const cleanup = start({ shake: true, image: "fixture" });
            assert.equal(nodes.size, 1);
            assert.equal(listeners.size, 1);
            assert.equal(frames.size, 1);
            for (const [id, callback] of [...frames]) { frames.delete(id); callback(100); }
            cleanup();
            assert.equal(nodes.size, 0);
            assert.equal(listeners.size, 0);
            assert.equal(frames.size, 0);
            assert.deepEqual(body.style, { transform: "scale(1)", willChange: "opacity" });
        }
    }
});

test("favorite emote drags preserve favorites when an endpoint disappears", () => {
    let update: (state: { emojis: string[] }) => unknown = () => assert.fail("No update scheduled");
    const { default: plugin } = loadSource("src/equicordplugins/dragFavoriteEmotes/index.tsx", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@webpack": { findByPropsLazy: () => ({}), findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            useDrop: (factory: () => object) => factory(),
            UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: {
                updateAsync: (_key: string, callback: typeof update) => { update = callback; }
            } }
        }
    });
    const drop = plugin.drop({ emoji: { id: "target" }, category: "FAVORITES" });
    drop.drop({ id: "source" });
    for (const emojis of [["target", "other"], ["source", "other"], ["other"]]) {
        const before = [...emojis];
        assert.equal(update({ emojis }), false);
        assert.deepEqual(emojis, before);
    }
    const forward = { emojis: ["source", "other", "target"] };
    update(forward);
    assert.deepEqual(forward.emojis, ["other", "source", "target"]);
    const backward = { emojis: ["target", "other", "source"] };
    update(backward);
    assert.deepEqual(backward.emojis, ["source", "target", "other"]);
});

test("custom user colors preserve black when reopening the picker", () => {
    let initialColor: unknown;
    const colors: Record<string, string> = { user: "000000" };
    const { SetColorModal } = loadComponent("src/equicordplugins/customUserColors/SetColorModal.tsx", {
        useState: (value: unknown) => { initialColor = value; return [value, (next: unknown) => { initialColor = next; }]; }
    }, {
        "@api/DataStore": {}, "@components/Heading": {},
        "@utils/margins": { Margins: {} }, "./index": { colors }
    });
    const tree = SetColorModal({ id: "user", modalProps: {} });
    assert.equal(initialColor, 0);
    tree.props.children[0].props.children[0].props.children[1].props.onChange(null);
    assert.equal(initialColor, 372735);
    SetColorModal({ id: "missing", modalProps: {} });
    assert.equal(initialColor, 372735);
});

test("sound imports validate all overrides before replacing settings", () => {
    const soundTypes = [{ id: "message1", name: "Message" }, { id: "mute", name: "Mute" }];
    const makeEmptyOverride = () => ({ enabled: false, selectedSound: "default", volume: 100, useFile: false });
    const store: Record<string, string> = { message1: "original message", mute: "original mute" };
    const { importOverrides } = loadSource("src/equicordplugins/customSounds/index.tsx", {
        "@api/DataStore": {},
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/Button": {}, "@components/Heading": {},
        "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, StartAt: {} },
        "@webpack/common": {}, "./audioStore": {}, "./SoundOverrideComponent": {},
        "./types": { soundTypes, makeEmptyOverride, seasonalSounds: {} }
    }, {}, "({ importOverrides })");
    const original = { ...store };
    for (const text of ["{", "null", "{}", '{"overrides":[null]}', ...[
        { id: "unknown" }, { id: "__proto__" }, { id: "mute", volume: -1 },
        { id: "mute", volume: 101 }, { id: "mute", enabled: "yes" },
        { id: "mute", selectedSound: "constructor" }, { id: "mute", selectedFileId: {} }
    ].map(invalid => JSON.stringify({ overrides: [{ id: "message1", enabled: true }, invalid] }))]) {
        assert.throws(() => importOverrides(text));
        assert.deepEqual(store, original);
    }
    importOverrides(JSON.stringify({ overrides: [{ id: "message1", enabled: true, volume: 0 }] }));
    assert.deepEqual(JSON.parse(store.message1), { enabled: true, selectedSound: "default", volume: 0, useFile: false });
    assert.deepEqual(JSON.parse(store.mute), makeEmptyOverride());
    importOverrides('{"overrides":[]}');
    assert.deepEqual(JSON.parse(store.message1), makeEmptyOverride());
});

test("folder icon editing preserves saved size and resetting an unused folder is safe", () => {
    const settings: { store: { folderIcons?: Record<string, { url: string; size: number; }> } } = {
        store: { folderIcons: { folder: { url: "https://fixture.invalid/icon.png", size: 175 } } }
    };
    let saved: unknown;
    let closes = 0;
    const { ImageModal } = loadComponent("src/equicordplugins/customFolderIcons/components.tsx", {
        useState: (initial: unknown) => [initial, () => {}],
        Button: "button", Slider: "slider", closeModal: () => closes++
    }, {
        "./settings": { settings },
        "./util": { setFolderData: (_props: object, data: unknown) => { saved = data; } }
    });
    const props = { folderId: "folder", folderColor: 0 };
    const tree = ImageModal(props);
    const buttons = tree.props.children.filter((node: { type?: string }) => node?.type === "button");
    buttons[0].props.onClick();
    assert.equal((saved as { size: number }).size, 175);
    settings.store.folderIcons = undefined;
    const empty = ImageModal(props);
    empty.props.children.filter((node: { type?: string }) => node?.type === "button")[1].props.onClick();
    assert.equal(closes, 2);
});

test("content warnings are blurred before the first hover", () => {
    const TriggerContainer = loadSource("src/equicordplugins/contentWarning/index.tsx", {
        "@api/index": {},
        "@api/Settings": { definePluginSettings: () => ({ store: { onClick: false } }) },
        "@components/Flex": {}, "@components/Heading": {}, "@components/Icons": {},
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/react": {}, "@utils/text": { escapeRegExp: RegExp.escape },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { useState: () => [false, () => {}] }
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } }, "TriggerContainer");
    const element = TriggerContainer({ child: "flagged content" });
    assert.equal(element.props.className, "vc-content-warning-container");
    const target = { className: element.props.className };
    element.props.onMouseEnter({ currentTarget: target });
    assert.equal(target.className, "vc-content-warning-enter");
    element.props.onMouseLeave({ currentTarget: target });
    assert.equal(target.className, "vc-content-warning-leave");
});

test("command palette forms prevent duplicate submissions before rendering", async () => {
    const { FormPage } = loadComponent("src/equicordplugins/commandPalette/ui/pages/FormPage.tsx", {
        useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
        useRef: (current: unknown) => ({ current }),
        useEffect() {},
        useLayoutEffect: (effect: () => void) => effect(),
        useMemo: (factory: () => unknown) => factory()
    }, { "../markdownPaste": {}, "../MessageMarkdownPreview": {}, "../PaletteIcon": {} });
    let submissions = 0;
    let finish = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const formRef = { current: { submit() {} } };
    FormPage({
        spec: { fields: [], submit: () => { submissions++; return pending; } },
        ctx: {}, formRef
    });
    formRef.current.submit();
    formRef.current.submit();
    assert.equal(submissions, 1);
    finish();
    await pending;
    await setImmediate();
    formRef.current.submit();
    assert.equal(submissions, 2);
});

test("command palette leaves composition keys to the input method", () => {
    const keyboard = loadSource("src/equicordplugins/commandPalette/ui/keyboard.ts", {
        "@utils/constants": { IS_MAC: false }
    }, {}, "({ ...exports, handleKeyDown, handleKeyUp })");
    let actions = 0;
    keyboard.setPaletteKeyHandler(() => { actions++; return true; });
    const event = {
        key: "Enter", isComposing: true,
        preventDefault: () => assert.fail("Composition was prevented"),
        stopImmediatePropagation: () => assert.fail("Composition was intercepted")
    };
    keyboard.handleKeyDown(event);
    keyboard.handleKeyUp(event);
    assert.equal(keyboard.comboFromEvent(event), null);
    assert.equal(actions, 0);
    keyboard.handleKeyDown({ ...event, isComposing: false, preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(actions, 1);
    const shouldSubmit = loadSource("src/equicordplugins/commandPalette/ui/pages/FormPage.tsx", {
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": {},
        "../markdownPaste": {},
        "../MessageMarkdownPreview": {},
        "../PaletteIcon": {}
    }, {}, "shouldSubmitOnEnter");
    assert.equal(shouldSubmit({ key: "Enter", nativeEvent: { isComposing: true } }), false);
    assert.equal(shouldSubmit({ key: "Enter", nativeEvent: { isComposing: false } }), true);
});

test("moving a bookmark into a later folder preserves the bookmark", () => {
    const bookmark = { channelId: "channel", guildId: "guild", name: "Bookmark" };
    const folder = { name: "Folder", bookmarks: [] as typeof bookmark[] };
    const bookmarks: (typeof bookmark | typeof folder)[] = [bookmark, folder];
    let drop: (item: object, monitor: object) => void = () => assert.fail("Folder drop handler was not registered");
    const React = { createElement() {} };
    const Bookmark = loadSource("src/equicordplugins/channelTabs/components/BookmarkContainer.tsx", {
        "@components/BaseText": {},
        "@equicordplugins/channelTabs/util": { isBookmarkFolder: (value: object) => "bookmarks" in value, settings: { store: {}, use: () => ({}) } },
        "@equicordplugins/channelTabs/util/icons": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
        "@utils/misc": { classes: () => "" }, "@webpack": { findComponentByCodeLazy: () => null },
        "./ChannelTab": {}, "./ContextMenus": {},
        "@webpack/common": {
            React, useRef: () => ({ current: null }), useState: (value: unknown) => [value, () => {}], useEffect() {},
            useDrag: () => [{}, (ref: unknown) => ref],
            useDrop: (create: () => { drop?: typeof drop; }) => { const spec = create(); if (spec.drop) drop = spec.drop; return [{}, (ref: unknown) => ref]; }
        }
    }, { React }, "Bookmark");
    Bookmark({ bookmarks, index: 1, methods: {
        deleteBookmark: (index: number) => bookmarks.splice(index, 1),
        addBookmark(value: typeof bookmark, index: number) {
            const target = bookmarks[index];
            assert.ok(target && "bookmarks" in target);
            target.bookmarks.push(value);
        }
    } });
    drop({ bookmark, index: 0, isFromFolder: false }, { getItemType: () => "vc_Bookmark" });
    assert.deepEqual(bookmarks, [folder]);
    assert.deepEqual(folder.bookmarks, [bookmark]);
});

test("channel tab limits preserve foreground and background opening behavior", () => {
    const navigations: string[] = [];
    const tabs = loadSource("src/equicordplugins/channelTabs/util/tabs.tsx", {
        "@api/index": {}, "@api/PluginManager": {},
        "@utils/css": { classNameFactory: () => () => "" },
        "./constants": { logger: { warn() {}, error() {} }, settings: { store: { maxOpenTabs: 1 } } },
        "@webpack/common": {
            NavigationRouter: { transitionToGuild: (_guildId: string, channelId: string) => navigations.push(channelId) },
            SelectedChannelStore: { getChannelId: () => "initial" }, SelectedGuildStore: { getGuildId: () => "guild" }
        }
    }, { setTimeout: () => 0, clearTimeout() {} });
    tabs.setUpdaterFunction(() => {});
    tabs.createTab({ guildId: "guild", channelId: "initial" }, false);
    tabs.setOpenTab(tabs.openedTabs[0].id);
    tabs.createTab({ guildId: "guild", channelId: "foreground" }, true);
    assert.deepEqual(navigations, ["foreground"]);
    tabs.createTab({ guildId: "guild", channelId: "background" }, false);
    assert.deepEqual(navigations, ["foreground"]);
    assert.equal(tabs.openedTabs.length, 1);
    assert.equal(tabs.openedTabs[0].channelId, "background");
});

test("channel tab animation selection can clear all and replace multiple choices", () => {
    let onChange: (values: (string | { value: string; })[]) => void = () => assert.fail("Selector was not rendered");
    const previousSettings = { animationQuestsActive: true, animationHover: true };
    let saves = 0;
    const { AnimationSettings, settings } = loadSource("src/equicordplugins/channelTabs/util/constants.tsx", {
        "@api/Settings": { PlainSettings: { plugins: { ChannelTabs: previousSettings } }, SettingsStore: { markAsChanged: () => saves++ }, definePluginSettings: (definitions: Record<string, { default?: unknown; }>) => ({ store: Object.fromEntries(Object.entries(definitions).map(([key, option]) => [key, option.default])) }) },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@equicordplugins/channelTabs/components/ChannelTabsContainer": {},
        "@equicordplugins/channelTabs/components/KeybindSettings": {},
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { makeRange: () => [], OptionType: {} },
        "@webpack/common": { SearchableSelect: "select", useState: (initial: unknown) => [initial, () => {}] }
    }, { React: { createElement(type: string, props: { onChange: typeof onChange; }) { if (type === "select") onChange = props.onChange; } } }, "({ AnimationSettings, settings: exports.settings })");
    assert.equal("animationQuestsActive" in previousSettings, false);
    assert.equal(previousSettings.animationHover, true);
    assert.equal(saves, 1);
    AnimationSettings();
    onChange([]);
    const enabled = () => Object.keys(settings.store).filter(key => key.startsWith("animation") && settings.store[key] === true).sort();
    assert.deepEqual(enabled(), []);
    onChange(["hover", { value: "selection" }]);
    assert.deepEqual(enabled(), ["animationHover", "animationSelection"]);
});

test("status bypass checks the message channel without creating DMs", async () => {
    const notifications: object[] = [];
    const errors: unknown[] = [];
    let createdDms = 0;
    let mentioned = false;
    const store = { guilds: "", channels: "", users: "123456789012345678", statusToUse: "dnd", allowOutsideOfDms: false, respectSilentPings: true, notificationSound: false };
    const { default: plugin } = loadSource("src/equicordplugins/bypassStatus/index.tsx", {
        "@api/AudioPlayer": {},
        "@api/index": { Notifications: { showNotification: (notification: object) => { notifications.push(notification); } } },
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { Devs: {} }, "@utils/discord": { getCurrentChannel: () => null },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            ChannelActionCreators: { getOrEnsurePrivateChannel: async () => { createdDms++; return "dm"; } },
            ChannelStore: { getChannel: (id: string) => ({ name: id, isDM: () => id === "dm" }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: () => undefined },
            PresenceStore: { getStatus: () => "dnd" }, MessageStore: { getMessage: () => ({ mentioned }) },
            WindowStore: { isFocused: () => false }
        }
    });
    plugin.start();
    const dispatch = (channelId: string, flags = 0) => plugin.flux.MESSAGE_CREATE({
        channelId, guildId: channelId === "dm" ? undefined : "guild",
        message: { id: "message", channel_id: channelId, content: "hello", flags, author: { id: store.users, username: "author" } }
    });
    await dispatch("guild-channel");
    assert.equal(notifications.length, 0);
    await dispatch("dm");
    assert.equal(notifications.length, 1);
    store.allowOutsideOfDms = true;
    mentioned = true;
    await dispatch("guild-channel");
    assert.equal(notifications.length, 2);
    await dispatch("dm", 1 << 12);
    assert.equal(notifications.length, 2);
    assert.equal(createdDms, 0);
    assert.deepEqual(errors, []);
});

test("audio downloads finishing after unmount do not allocate object URLs", async () => {
    const effects: (() => () => void)[] = [];
    const canvas = { getContext: () => null };
    let firstRef = true;
    const React = {
        createElement() {},
        useRef(value: unknown) {
            const current = firstRef ? canvas : value;
            firstRef = false;
            return { current };
        },
        useEffect(effect: () => () => void) { effects.push(effect); }
    };
    let finishDownload: (response: Response) => void = () => assert.fail("Download did not start");
    let allocated = 0;
    const Visualizer = loadSource("src/equicordplugins/betterAudioPlayer/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React }
    }, {
        URL: class extends URL { static createObjectURL() { allocated++; return "blob:fixture"; } },
        fetch: () => new Promise<Response>(resolve => { finishDownload = resolve; }),
        cancelAnimationFrame() {}
    }, "Visualizer");
    Visualizer({ playerRef: { current: { addEventListener() {}, removeEventListener() {} } }, src: "https://fixture.invalid/audio" });
    const cleanup = effects[0]();
    cleanup();
    finishDownload(new Response("audio"));
    await setImmediate();
    assert.equal(allocated, 0);
});

test("Base64 decoding returns Unicode text and skips invalid encodings", () => {
    const decode = loadSource("src/equicordplugins/baseDecoder/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/CodeBlock": {}, "@components/ErrorBoundary": {}, "@components/Heading": {},
        "@utils/constants": { EquicordDevs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}
    }, { atob, TextDecoder, console: { error() {} } }, "decodeBase64Strings");
    const text = "Hello, café 😀";
    assert.deepEqual(Array.from(decode([Buffer.from(text).toString("base64"), "/w==", "%%%"])), [text]);
});

function decorFixture() {
    const scheduled = new Map<() => Promise<void>, number>();
    const requests: { ids: string[]; signal?: AbortSignal; resolve: (result: Record<string, string | null>) => void; reject: (error: Error) => void; }[] = [];
    const errors: unknown[] = [];
    const clock = { now: 1_000 };
    const module = loadComponent("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal?: AbortSignal) => new Promise<Record<string, string | null>>((resolve, reject) => requests.push({ ids, signal, resolve, reject })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 10_000, SKU_ID: "decor" },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }, {
        AbortController, Date: class extends Date { static now() { return clock.now; } },
        setTimeout(callback: () => Promise<void>, delay: number) {
            scheduled.set(callback, clock.now + delay);
            return callback;
        },
        clearTimeout(callback: () => Promise<void>) { scheduled.delete(callback); }
    });
    const store = module.useUsersDecorationsStore;
    function flush() {
        const callback = scheduled.keys().next().value;
        assert.ok(callback);
        scheduled.delete(callback);
        return callback();
    }
    function advance(milliseconds: number) {
        clock.now += milliseconds;
        const work: Promise<void>[] = [];
        for (const [callback, due] of scheduled) {
            if (due <= clock.now) {
                scheduled.delete(callback);
                work.push(callback());
            }
        }
        return work;
    }
    return { store, requests, scheduled, flush, advance, errors, clock };
}

test("folder zipping drains directory batches and rejects read and size failures", { timeout: 1000 }, async () => {
    const readDirectory = loadSource("src/equicordplugins/autoZipper/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { extensions: "" } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}, fflate: {}
    }, {}, "readDirectoryEntry");
    const directory = (name: string, batches: object[][]) => ({
        name, isDirectory: true,
        createReader: () => ({ readEntries: (resolve: (entries: object[]) => void) => resolve(batches.shift() ?? []) })
    });
    const file = (name: string, size = 1, fail = false) => ({
        name, isFile: true,
        file: (resolve: (value: object) => void, reject: (error: Error) => void) => fail
            ? reject(new Error("Read failed"))
            : resolve({ size, arrayBuffer: async () => new Uint8Array([7]).buffer })
    });
    const files = await readDirectory(directory("root", [[file("a")], [directory("nested", [[file("b")]])]]));
    assert.deepEqual(Object.keys(files), ["a", "nested/b"]);
    assert.deepEqual(Array.from(files["nested/b"]), [7]);
    await assert.rejects(readDirectory(directory("root", [[file("bad", 1, true)]])), /Read failed/);
    await assert.rejects(readDirectory(directory("root", [[file("large", 100 * 1024 * 1024 + 1)]])), /too large/);
    await assert.rejects(readDirectory(directory("root", [Array.from({ length: 501 }, (_, i) => file(String(i)))])), /more than 500/);
});

test("random mentions use the destination channel and preserve text when no members are loaded", () => {
    const plugin = loadComponent("src/equicordplugins/atSomeone/index.ts", {
        ChannelStore: { getChannel: (id: string) => ({
            guild: { guild_id: "destination" }, dm: { recipients: ["recipient"] }, empty: { guild_id: "empty" }
        })[id] },
        GuildMemberStore: { getMembers: (id: string) => id === "destination" ? [{ userId: "member" }] : [] }
    }, {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    assert.equal(plugin.start, undefined);
    for (const [channel, expected] of [["guild", "<@member> <@member>"], ["dm", "<@recipient> <@recipient>"], ["empty", "@someone @someone"], ["missing", "@someone @someone"]]) {
        const message = { content: "@someone @someone" };
        plugin.onBeforeMessageSend(channel, message);
        assert.equal(message.content, expected);
    }
});

test("clip file reads share the size cap and selected files reuse the byte writer", async () => {
    const footer = Buffer.from([0x75, 0x75, 0x69, 0x64, 0xA1, 0xC8, 0x52, 0x99, 0x33, 0x46, 0x4D, 0xB8, 0x88, 0xF0, 0x83, 0xF5, 0x7A, 0x75, 0xA5, 0xEF]);
    const payload = Buffer.concat([Buffer.from([1, 2, 3]), footer, Buffer.from('{"applicationName":"Fixture"}')]);
    let oversized = false;
    let id = 0;
    let reads = 0;
    const writes: Buffer[] = [];
    const native = loadComponent("src/equicordplugins/clipUpload.desktop/native.ts", {}, {
        "@main/ipcMain": { ensureSafePath: () => true },
        "@main/utils/constants": { DATA_DIR: "fixture" },
        crypto: { randomUUID: () => String(++id) },
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["clip.mp4"], canceled: false }) } },
        fs: { createReadStream: (_path: string, options: { end: number; }) => {
            assert.equal(options.end, 500 * 1024 * 1024);
            reads++;
            return Readable.from([payload]);
        } },
        "fs/promises": { mkdir: async () => {}, writeFile: async (_path: string, data: Buffer) => { writes.push(data); } },
        path,
        "stream/consumers": { buffer: async (stream: Readable) => oversized ? { length: 500 * 1024 * 1024 + 1 } : buffer(stream) }
    }, { Buffer, Uint8Array });
    const picked = await native.chooseVideoFile({});
    const metadata = await native.parseClipFileMetadata({}, picked.token);
    assert.equal(metadata[0].applicationName, "Fixture");
    const temp = await native.createTempVideoFile({}, picked.token);
    assert.equal(typeof temp, "string");
    assert.deepEqual(Array.from(writes[0]), [1, 2, 3]);
    assert.deepEqual(Array.from(await native.readVideoFile({}, temp)), Array.from(payload));
    oversized = true;
    const large = await native.chooseVideoFile({});
    assert.equal(await native.parseClipFileMetadata({}, large.token), null);
    assert.equal(await native.createTempVideoFile({}, large.token), null);
    assert.equal(await native.readVideoFile({}, temp), null);
    assert.equal(writes.length, 1);
    assert.equal(reads, 6);
});

test("favourite attachment downloads validate IPC input and bound network responses", async () => {
    let requests = 0;
    let cancelled = 0;
    let mode = "success";
    const { fetchAttachment } = loadComponent("src/equicordplugins/favouriteAnything/native.ts", {}, {}, {
        URL, Buffer, AbortSignal,
        fetch: async (_url: URL, options: RequestInit) => {
            requests++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            if (mode === "network") throw new Error("Private path or network details");
            let read = false;
            return {
                ok: true,
                headers: { get: (name: string) => name === "content-length" ? (mode === "header" ? "524288001" : null) : "text/plain" },
                body: {
                    cancel: async () => { cancelled++; },
                    getReader: () => ({
                        read: async () => {
                            if (read) return { done: true };
                            read = true;
                            return { done: false, value: mode === "stream" ? { byteLength: 524288001 } : new Uint8Array([1, 2, 3]) };
                        },
                        cancel: async () => { cancelled++; },
                        releaseLock() {}
                    })
                }
            };
        }
    });
    const attachment = { filename: "file.txt", url: "https://cdn.discordapp.com/attachments/file.txt" };
    for (const invalid of [null, {}, { ...attachment, filename: 1 }, ...["http://cdn.discordapp.com/file", "https://cdn.discordapp.com:444/file", "https://user@cdn.discordapp.com/file", "https://example.com/file"].map(url => ({ ...attachment, url }))]) {
        const result = await fetchAttachment({}, invalid);
        assert.equal(result.success, false);
    }
    assert.equal(requests, 0);
    const success = await fetchAttachment({}, attachment);
    assert.equal(success.success, true);
    assert.deepEqual(Array.from(success.data), [1, 2, 3]);
    assert.equal(success.filename, "file.txt");
    assert.equal(success.type, "text/plain");
    for (mode of ["header", "stream", "network"]) {
        const result = await fetchAttachment({}, attachment);
        assert.equal(result.success, false);
        assert.equal(result.error.includes("Private"), false);
    }
    assert.equal(cancelled, 2);
});

test("favourite attachment base64url encoding preserves bytes and rejects malformed input", () => {
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/polyfills.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { encode, decode } = runInNewContext(`Uint8Array.fromBase64 = undefined; Uint8Array.prototype.toBase64 = undefined;\n${outputText}\n({ encode: bytes => uint8ArrayToBase64(new Uint8Array(bytes)), decode: base64ToUint8Array });`, {
        exports: {}, atob, btoa
    });
    for (let length = 0; length < 260; length++) {
        const bytes = Array.from({ length }, (_, index) => (index * 37 + length) % 256);
        const expected = Buffer.from(bytes).toString("base64url");
        assert.equal(encode(bytes), expected);
        assert.deepEqual(Array.from(decode(expected)), bytes);
    }
    assert.deepEqual(Array.from(decode(" A Q I =\r\n")), [1, 2]);
    assert.deepEqual(Array.from(decode("AQ==")), [1]);
    for (const invalid of ["A", "A=", "AQ=", "AQ===", "AQ=A", "AAAA=", "+w", "/w", "AA!", "AA\u00a0"])
        assert.throws(() => decode(invalid), invalid);
});

test("linked message previews reject neighboring messages returned by an around lookup", async () => {
    const source = readFileSync("src/plugins/messageLinkEmbeds/index.tsx", "utf8");
    const code = transpileModule(source.slice(source.indexOf("async function fetchMessage("), source.indexOf("function getImages(")), {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText;
    for (const id of ["neighbor", "requested"]) {
        const message = { id, channel_id: "channel" };
        let stored = 0;
        const cache = new Map();
        const fetchMessage = runInNewContext(`${code}\nfetchMessage;`, {
            messageCache: cache,
            setMessageCache: (key: string, value: unknown) => cache.set(key, value),
            RestAPI: { get: async () => ({ body: [message] }) },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } },
            MessageStore: { getMessages: () => ({ receiveMessage: () => { stored++; return { get: () => message }; } }) }
        });
        assert.equal(await fetchMessage("channel", "requested"), id === "requested" ? message : undefined);
        assert.equal(stored, id === "requested" ? 1 : 0);
    }
});

test("queued task failures are reported without interrupting ordered work", async () => {
    const errors: unknown[][] = [];
    const { Queue } = loadComponent("src/utils/Queue.ts", {}, {
        "./Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    });
    const queue = new Queue(2);
    const calls: string[] = [];
    queue.push(() => { calls.push("first"); throw new Error("Synchronous failure"); });
    queue.push(() => calls.push("discarded"));
    queue.unshift(async () => { calls.push("urgent"); throw new Error("Asynchronous failure"); });
    queue.unshift(() => calls.push("newest"));
    await setImmediate();
    assert.deepEqual(calls, ["first", "newest", "urgent"]);
    assert.equal(errors.length, 2);
    assert.equal(queue.size, 0);
    queue.push(() => calls.push("resumed"));
    await setImmediate();
    assert.equal(calls.at(-1), "resumed");
});

test("audio player preserves zero volume and clamps explicit values", () => {
    const plugin = loadComponent("src/equicordplugins/_api/audioPlayer.ts", {}, {
        "@api/AudioPlayer": { audioProcessorFunctions: {}, AudioType: {}, identifyAudioType: () => "url" },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }, { structuredClone }).default;
    for (const [volume, internalVolume, expected] of [
        [0, null, 0], [undefined, 0, 0], [undefined, undefined, 1],
        [50, null, 0.5], [100, 0.25, 0.25], [-10, null, 0], [200, null, 1]
    ] as const) {
        const player = { _volume: -1, destroyAudio() {} };
        plugin.buildPlayer(player, { volume }, "https://example.com/sound.mp3", null, internalVolume, "default");
        assert.equal(player._volume, expected);
    }
});

test("Decor continuous arrivals cannot postpone the first batch and stopped timers cannot fetch", async () => {
    const f = decorFixture();
    f.store.getState().start();
    f.store.getState().fetch("a");
    f.advance(100); f.store.getState().fetch("b");
    f.advance(100); f.store.getState().fetch("c");
    assert.equal(f.requests.length, 0);
    const first = f.advance(100);
    assert.equal(f.requests.length, 1);
    assert.deepEqual([...f.requests[0].ids], ["a", "b", "c"]);
    f.store.getState().fetch("d");
    f.advance(299);
    assert.equal(f.requests.length, 1);
    const second = f.advance(1);
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ d: "new" }); await Promise.all(second);
    f.requests[0].resolve({ a: null, b: "b", c: null }); await Promise.all(first);
    assert.equal(f.store.getState().usersDecorations.get("d").asset, "new");
    f.store.getState().fetch("cancelled");
    f.store.getState().stop();
    await Promise.all(f.advance(300));
    assert.equal(f.requests.length, 2);
    f.store.getState().start(); f.store.getState().fetch("restarted");
    const restarted = f.advance(300);
    assert.equal(f.requests.length, 3);
    f.requests[2].resolve({ restarted: null }); await Promise.all(restarted);
});

test("Decor lookups preserve newer local and unrelated decoration updates", async () => {
    const { store, requests, flush } = decorFixture();
    store.getState().start?.();
    store.getState().fetch("a");
    const first = flush();
    store.getState().set("a", "local");
    store.getState().fetch("b");
    const second = flush();
    requests[1].resolve({ b: "remote-b" }); await second;
    requests[0].resolve({ a: "old-a" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "local");
    assert.equal(store.getState().usersDecorations.get("b").asset, "remote-b");
});

test("Decor lookups deduplicate pending IDs and prefer the latest forced request", async () => {
    const { store, requests, scheduled, flush } = decorFixture();
    store.getState().start();
    store.getState().fetch("a"); store.getState().fetch("a");
    const first = flush();
    assert.deepEqual([...requests[0].ids], ["a"]);
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0);
    store.getState().fetch("a", true);
    const second = flush();
    requests[1].resolve({ a: "new" }); await second;
    requests[0].resolve({ a: "old" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "new");
});

test("Decor stop cancels queued requests and old failures cannot erase restarted work", async () => {
    const { store, requests, scheduled, flush, errors } = decorFixture();
    store.getState().fetch("inactive");
    assert.equal(scheduled.size, 0);
    store.getState().start(); store.getState().fetch("a");
    const old = flush();
    store.getState().fetch("queued"); store.getState().stop();
    assert.equal(scheduled.size, 0);
    assert.equal(requests[0].signal?.aborted, true);
    store.getState().start(); store.getState().fetch("a");
    const current = flush();
    requests[0].reject(new Error("Old failure")); await old;
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0, "the old cleanup must preserve the new in-flight marker");
    requests[1].resolve({ a: "current" }); await current;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    store.getState().fetch("a", true); const failed = flush();
    requests[2].reject(new Error("Retryable failure")); await failed;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    assert.equal(errors.length, 1);
    store.getState().fetch("a", true); const retry = flush();
    store.getState().stop(); requests[3].resolve({ a: "late" }); await retry;
    assert.equal(store.getState().usersDecorations.size, 0);
});

test("Decor cached absence expires and expired entries are released", async () => {
    const { store, requests, scheduled, flush, clock } = decorFixture();
    store.getState().start(); store.getState().fetch("a");
    const first = flush(); requests[0].resolve({ a: null }); await first;
    store.getState().fetch("a"); assert.equal(scheduled.size, 0);
    clock.now += 10_000;
    store.getState().fetch("b"); const second = flush(); requests[1].resolve({ b: "b" }); await second;
    assert.equal(store.getState().usersDecorations.has("a"), false);
    store.getState().fetch("a"); assert.equal(scheduled.size, 1);
    store.getState().stop();
});

test("Decor public lookups check HTTP and response shapes and never request the entire user list", async () => {
    const requests: { url: string; signal?: AbortSignal; }[] = [];
    const response: { ok: boolean; body: unknown; } = { ok: true, body: { a: "asset", b: null, unrelated: "ignored" } };
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": { API_URL: "https://decor.invalid/api" },
        "./stores/AuthorizationStore": {},
        "./utils/decoration": {},
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    }, { URL, fetch: async (url: URL, options: { signal?: AbortSignal; }) => {
        requests.push({ url: String(url), signal: options.signal });
        return { ok: response.ok, json: async () => response.body };
    } });
    assert.deepEqual(structuredClone(await api.getUsersDecorations([])), {});
    assert.equal(requests.length, 0);
    const controller = new AbortController();
    assert.deepEqual(structuredClone(await api.getUsersDecorations(["a", "b", "missing"], controller.signal)), { a: "asset", b: null, missing: null });
    assert.equal(requests[0].signal, controller.signal);
    assert.deepEqual(JSON.parse(new URL(requests[0].url).searchParams.get("ids") ?? "null"), ["a", "b", "missing"]);
    response.ok = false; await assert.rejects(api.getUsersDecorations(["a"]), /Could not load/);
    response.ok = true;
    for (const body of [null, [], { a: 123 }, { a: {} }]) {
        response.body = body; await assert.rejects(api.getUsersDecorations(["a"]), /Invalid decoration response/);
    }
});

test("Decor lifecycle keeps initialization and connection work obsolete after logout or stop", async () => {
    const { store, scheduled } = decorFixture();
    const pending: ((configured: boolean) => void)[] = [];
    const account = { id: "first", clears: 0, authInits: 0 };
    const authorizationListeners = new Set<(state: object, previous: object) => void>();
    const plugin = loadComponent("src/plugins/decor/index.tsx", { UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined } }, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { setBaseUrl: () => new Promise<boolean>(resolve => pending.push(resolve)), cancelConfiguration: () => undefined },
        "./lib/stores/AuthorizationStore": { useAuthorizationStore: {
            getState: () => ({ init: () => account.authInits++, clear: () => undefined }),
            subscribe(listener: (state: object, previous: object) => void) {
                authorizationListeners.add(listener);
                return () => authorizationListeners.delete(listener);
            }
        } },
        "./lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: { getState: () => ({ clear: () => account.clears++ }) } },
        "./lib/stores/UsersDecorationsStore": { useUsersDecorationsStore: store },
        "./settings": { settings: { store: { baseUrl: "https://decor.invalid" } } },
        "./ui/components": {}, "./ui/components/DecorSection": {}
    }).default;
    const first = plugin.start();
    plugin.stop(); pending.shift()?.(true); await first;
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    const second = plugin.start();
    const connection = plugin.flux.CONNECTION_OPEN();
    account.id = ""; plugin.flux.LOGOUT(); pending.shift()?.(true); await Promise.all([second, connection]);
    assert.equal(store.getState().session, null);
    account.id = "second"; await plugin.flux.CONNECTION_OPEN();
    assert.equal(typeof store.getState().session, "symbol");
    assert.equal(scheduled.size, 1);
    plugin.stop(); await plugin.flux.CONNECTION_OPEN();
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    assert.ok(account.clears >= 4);
    assert.equal(account.authInits, 2);
    plugin.stop();
});

function loadShortcuts() {
    const state = { resolutions: 0, opens: 0, roots: 0, unmounts: 0, renders: [] as unknown[], blocked: false, failRoot: false };
    const module = Object.freeze({ value: "lazy module", nested: Object.freeze({ value: 1 }) });
    const lazy = proxyLazy(() => { state.resolutions++; return module; });
    const modules: Record<string, unknown>[] = [];
    const fluxStores = new Map<string, object>();
    const popups: ReturnType<typeof makePopup>[] = [];
    function makePopup() {
        let pagehide: (() => void) | undefined;
        return {
            closed: false, closes: 0, focus() {},
            document: {
                head: { append() {} },
                body: { style: {}, appendChild: (element: object) => element },
                createElement: () => ({})
            },
            addEventListener(event: string, callback: () => void) { assert.equal(event, "pagehide"); pagehide = callback; },
            close() { this.closes++; this.closed = true; pagehide?.(); },
            leave() { this.closed = true; pagehide?.(); }
        };
    }
    const window = {
        open() {
            state.opens++;
            if (state.blocked) return null;
            const popup = makePopup();
            popups.push(popup);
            return popup;
        }
    };
    const byProps = (...keys: string[]) => (value: Record<string, unknown>) => keys.every(key => Object.hasOwn(value, key));
    const webpack = {
        fluxStores,
        filters: { byProps, byCode: byProps, componentByCode: byProps, byClassNames: byProps },
        findAll: (filter: (value: object) => boolean) => modules.filter(filter),
        findStore: (name: string) => { const store = fluxStores.get(name); if (!store) throw new Error("Missing store"); return store; },
        findModuleId: (code: string) => code === "present" ? 0 : null,
        extract: (id: number) => { assert.equal(id, 0); return "source"; },
        search() {}
    };
    const plugin = loadComponent("src/plugins/consoleShortcuts/index.ts", {
        LazyModule: lazy,
        createRoot: () => {
            if (state.failRoot) throw new Error("Root unavailable");
            state.roots++;
            return { render: (element: unknown) => state.renders.push(element), unmount: () => state.unmounts++ };
        }
    }, {
        "@debug/loadLazyChunks": { loadLazyChunks() { assert.fail("Automatic chunk loading"); } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentChannel: () => null, getCurrentGuild: () => null },
        "@utils/intlHash": { runtimeHashMessageKey() {} },
        "@utils/lazy": { SYM_LAZY_GET },
        "@utils/native": { relaunch() { assert.fail("Unexpected relaunch"); } },
        "@utils/patches": { canonicalizeMatch() {}, canonicalizeReplace() {}, canonicalizeReplacement() {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, StartAt: {} },
        "@webpack": webpack
    }, {
        window, document: { querySelectorAll: () => [] },
        IS_WEB: false, IS_VESKTOP: false, IS_EQUIBOP: false
    }).default;
    return { plugin, window, state, module, modules, fluxStores, popups };
}

test("console aliases resolve lazies only on access without mutating module exports", async () => {
    const { plugin, window, state, module } = loadShortcuts();
    plugin.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.resolutions, 0);
    const shortcuts = Reflect.get(window, "shortcutList");
    assert.equal(Reflect.get(window, "LazyModule"), module);
    assert.equal(shortcuts.LazyModule, module);
    assert.equal(state.resolutions, 1);
    assert.deepEqual(module.nested, { value: 1 });
    plugin.stop();
    assert.equal(Object.hasOwn(window, "LazyModule"), false);
});

test("console aliases restore owned descriptors and preserve collisions and external replacements", () => {
    const { plugin, window } = loadShortcuts();
    const previous = { value: "previous", writable: false, configurable: true, enumerable: false };
    Object.defineProperty(window, "wp", previous);
    Object.defineProperty(window, "find", { value: "reserved", configurable: false });
    const previousList = { value: "previous list", writable: true, configurable: true, enumerable: false };
    Object.defineProperty(window, "shortcutList", previousList);
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    plugin.start();
    assert.equal(Reflect.get(window, "shortcutList"), shortcuts);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(shortcuts.find(() => true), null);
    Object.defineProperty(window, "reload", { value: "external", configurable: true });
    plugin.stop();
    plugin.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "wp"), previous);
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "shortcutList"), previousList);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(Reflect.get(window, "reload"), "external");
    plugin.start();
    plugin.stop();
    assert.equal(Reflect.get(window, "reload"), "external");
});

test("console searches distinguish identical-looking closures and reflect replaced modules and stores", () => {
    const { plugin, window, modules, fluxStores } = loadShortcuts();
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    const first = { id: 1 }, second = { id: 2 };
    modules.push(first, second);
    const byId = (id: number) => (module: { id: number }) => module.id === id;
    assert.equal(String(byId(1)), String(byId(2)));
    assert.equal(shortcuts.find(byId(1)), first);
    assert.equal(shortcuts.find(byId(2)), second);
    const replacement = { id: 1 };
    modules.splice(0, 1, replacement);
    assert.equal(shortcuts.find(byId(1)), replacement);
    assert.equal(shortcuts.findExportedComponent("absent"), undefined);
    assert.equal(shortcuts.wpexs("absent"), null);
    assert.equal(shortcuts.wpexs("present"), "source");
    assert.equal(shortcuts.findStore("Sample"), null);
    assert.equal(shortcuts.Stores.Sample, undefined);
    fluxStores.set("Sample", first);
    assert.equal(shortcuts.Stores.Sample, first);
    assert.equal(shortcuts.findStore("Sample"), first);
    fluxStores.set("Sample", second);
    assert.equal(shortcuts.findStore("Sample"), second);
    assert.equal(shortcuts.Stores.Sample, second);
    plugin.stop();
});

test("console previews report blocked popups and reuse one root until close or stop", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    const component = () => null;
    state.blocked = true;
    assert.throws(() => fakeRender(component), /Could not open/);
    assert.equal(state.roots, 0);
    state.blocked = false;
    fakeRender(component, { value: 1 });
    fakeRender(component, { value: 2 });
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 2);
    popups[0].leave();
    assert.equal(state.unmounts, 1);
    fakeRender(component);
    assert.equal(state.roots, 2);
    plugin.stop();
    plugin.stop();
    assert.equal(state.unmounts, 2);
    assert.equal(popups[1].closed, true);
    assert.equal(popups[1].closes, 1);
});

test("console previews can retry after root creation fails", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    state.failRoot = true;
    assert.throws(() => fakeRender(() => null), /Root unavailable/);
    assert.equal(popups[0].closed, true);
    state.failRoot = false;
    fakeRender(() => null);
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 1);
    plugin.stop();
    assert.equal(state.unmounts, 1);
});

test("member counts subscribe to scalar values and tooltip renders skip channel work", () => {
    const selectors: { select: () => unknown; value: unknown; stores: unknown[]; deps: unknown[]; }[] = [];
    let channelReads = 0;
    let groups = [{ id: "online", count: 3 }, { id: "offline", count: 20 }];
    const module = loadComponent("src/plugins/memberCount/MemberCount.tsx", {
        ChannelStore: { getChannel: () => ({}) },
        GuildMemberCountStore: { getMemberCount: () => 23 },
        PermissionStore: { can: () => true }, PermissionsBits: { VIEW_CHANNEL: 1 },
        VoiceStateStore: { getVoiceStates: () => ({}) }, SelectedChannelStore: {},
        useEffect() {},
        useStateFromStores(stores: unknown[], select: () => unknown, deps: unknown[] = []) {
            const value = select(); selectors.push({ stores, select, value, deps }); return value;
        }
    }, {
        "@utils/discord": { getCurrentChannel: () => { channelReads++; return { id: "channel", guild_id: "guild" }; } },
        "@utils/misc": { isObjectEmpty: (value: object) => Object.keys(value).length === 0 },
        ".": { ChannelMemberStore: { getProps: () => ({ groups }) }, ThreadMemberListStore: { getMemberListSections: () => ({}) }, cl: () => "", numberFormat: String, settings: { use: () => ({ voiceActivity: true }) } },
        "./OnlineMemberCountStore": { OnlineMemberCountStore: { getCount: () => 5 } },
        "./CircleIcon": {}, "./VoiceIcon": {}
    });
    module.MemberCount({});
    assert.equal(selectors[4].value, 3);
    groups = [{ id: "online", count: 3 }, { id: "offline", count: 99 }];
    assert.equal(selectors[4].select(), selectors[4].value);
    assert.deepEqual([...selectors[4].deps], [undefined, "guild", "channel"]);
    selectors.length = 0;
    module.MemberCount({ isTooltip: true, tooltipGuildId: "guild" });
    assert.equal(channelReads, 1);
    assert.equal(selectors[4].value, null);
    assert.equal(selectors[5].value, null);
});

test("APNG failed worker loads terminate and concurrent conversions share the retry", async () => {
    const workers: { loaded: boolean; terminated: boolean; }[] = [];
    let loads = 0;
    const module = loadComponent("src/equicordplugins/fileUpload/utils/apngToGif.ts", {}, {
        "@ffmpeg/ffmpeg": { FFmpeg: class {
            loaded = false;
            terminated = false;
            constructor() { workers.push(this); }
            terminate() { this.terminated = true; }
            async writeFile() {}
            async exec() {}
            async readFile() { return new Uint8Array([1]); }
            async deleteFile() {}
        } },
        "@utils/ffmpeg": { loadFFmpeg: async (worker: { loaded: boolean; }) => { if (++loads === 1) throw new Error("Load failed"); worker.loaded = true; } }
    }, { Blob, console: { error() {} } });
    assert.equal(await module.convertApngToGif(new Blob()), null);
    assert.equal(workers[0].terminated, true);
    const results = await Promise.all([module.convertApngToGif(new Blob()), module.convertApngToGif(new Blob())]);
    assert.equal(loads, 2);
    assert.equal(results.every(result => result instanceof Blob), true);
});

test("DevCompanion replacement closes the old socket and ignores its late events", () => {
    class Socket {
        static OPEN = 1;
        readyState = 1;
        closed = false;
        sent: string[] = [];
        listeners = new Map<string, (event: object) => void>();
        constructor() { sockets.push(this); }
        close() { this.closed = true; this.readyState = 3; }
        send(message: string) { this.sent.push(message); }
        addEventListener(type: string, listener: (event: object) => void) { this.listeners.set(type, listener); }
    }
    const sockets: Socket[] = [];
    const module = loadComponent("src/plugins/devCompanion.dev/initWs.tsx", {
        Toasts: { show() {}, genId: () => "toast", Type: { SUCCESS: 1, FAILURE: 2 }, Position: { TOP: 1 } }
    }, {
        "@api/Settings": {}, "@debug/loadLazyChunks": {}, "@debug/reporterData": {},
        "@utils/discord": {}, "@utils/patches": {}, "@webpack": { wreq: { m: {} } },
        ".": { CLIENT_VERSION: [0, 1, 2], PORT: 8485, settings: { store: {} }, logger: { info() {}, error() {}, debug() {} } },
        "./types": {}, "./types/send": {}, "./util": {}
    }, { WebSocket: Socket, IS_COMPANION_TEST: false });
    module.initWs();
    module.initWs();
    assert.equal(sockets[0].closed, true);
    sockets[0].listeners.get("open")?.({});
    assert.equal(sockets[0].sent.length, 0);
    sockets[1].listeners.get("open")?.({});
    assert.equal(sockets[1].sent.length, 1);
    module.stopWs();
    assert.equal(sockets[1].closed, true);
    sockets[1].listeners.get("message")?.({ data: "invalid" });
    assert.equal(sockets[1].sent.length, 1);
});

function loadSource(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}, result = "exports") {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

function response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
}

function loadGlobalBadges() {
    const store: Record<string, string | boolean> = { apiUrl: "https://fixture.invalid", showModStyle: "none", showAero: true };
    const requests: { url: string; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const errors: unknown[][] = [];
    const intervals = new Map<number, () => Promise<void>>();
    const toasts: { type: string; }[] = [];
    const mocks = {
        "./settings": { settings: { store } },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    };
    const utils = loadSource("src/equicordplugins/globalBadges/utils.ts", mocks, {
        fetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }))
    });
    const { default: plugin } = loadSource("src/equicordplugins/globalBadges/index.tsx", {
        ...mocks,
        "./utils": utils,
        "@api/Badges": { BadgePosition: { START: 0 } },
        "@components/Button": {},
        "@plugins/_api/badges": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { Toasts: { genId: () => "toast", show: (toast: { type: string; }) => toasts.push(toast), Type: { SUCCESS: "success", FAILURE: "failure" } } }
    }, {
        setInterval: (callback: () => Promise<void>) => { intervals.set(1, callback); return 1; },
        clearInterval: (id: number) => intervals.delete(id)
    });
    return { utils, plugin, store, requests, errors, intervals, toasts };
}

test("global badge display settings use existing data and unknown service names remain readable", async () => {
    const { utils, plugin, requests, store } = loadGlobalBadges();
    const pending = utils.loadBadges();
    requests[0].resolve(response({ users: { fixture: [
        { mod: "aero", badge: "aero.png", tooltip: "Contributor" },
        { mod: "newmod", badge: "new.png", tooltip: "Developer" },
        { mod: "vencord", badge: "vencord.png", tooltip: "Donor" },
        { mod: "", badge: "empty.png", tooltip: "Empty" }
    ] } }));
    await pending;
    assert.equal(plugin.getGlobalBadges("fixture").length, 2);
    store.showAero = false;
    store.showModStyle = "prefix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "newmod - Developer");
    assert.equal(plugin.getGlobalBadges("fixture").length, 1);
    store.showAero = true;
    store.showModStyle = "suffix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "Contributor - Aero");
    assert.equal(requests.length, 1);
});

test("global badge loads discard stale responses and stop invalidates pending data", async () => {
    const { utils, plugin, requests, store, intervals } = loadGlobalBadges();
    const first = utils.loadBadges();
    store.apiUrl = "https://new-fixture.invalid/";
    const second = utils.loadBadges();
    assert.equal(requests[1].url, "https://new-fixture.invalid/users");
    requests[1].resolve(response({ users: { current: [] } }));
    await second;
    requests[0].resolve(response({ users: { stale: [] } }));
    await first;
    assert.equal(plugin.getGlobalBadges("current")?.length, 0);
    assert.equal(plugin.getGlobalBadges("stale"), undefined);
    plugin.start();
    assert.equal(intervals.size, 1);
    plugin.stop();
    requests[2].resolve(response({ users: { stopped: [] } }));
    await setImmediate();
    assert.equal(intervals.size, 0);
    assert.equal(plugin.getGlobalBadges("stopped"), undefined);
});

test("global badge refresh retries failures, rejects malformed data and reports manual errors", async () => {
    const { utils, plugin, requests, intervals, errors, toasts } = loadGlobalBadges();
    plugin.start();
    assert.equal(intervals.size, 1);
    requests[0].reject(new Error("offline"));
    await setImmediate();
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0]();
    requests[1].resolve(response({ users: { good: [] } }));
    await retry;
    for (const invalid of [null, {}, { users: [] }, { users: { broken: {} } }, { users: { broken: [null] } }, { users: { broken: [{ mod: "aero", badge: "a.png" }] } }]) {
        const offset = requests.length;
        const pending = utils.refreshBadges();
        requests[offset].resolve(response(invalid));
        await pending;
        assert.equal(plugin.getGlobalBadges("good")?.length, 0);
    }
    const offset = requests.length;
    const manual = plugin.toolboxActions["Refetch Global Badges"]();
    requests[offset].resolve(response({}, 503));
    await manual;
    assert.equal(toasts.at(-1)?.type, "failure");
    plugin.stop();
});

test("chat badge classes stay lazy until rendering and sibling badge keys are unique", () => {
    let ready = false;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { CheckBadge } = loadSource("src/equicordplugins/showBadgesInChat/index.tsx", {
        "@plugins/_api/badges": { __esModule: true, default: {
            getDonorBadges: () => [{ id: "one" }, { id: "two" }], getEquicordDonorBadges: () => [{ id: "one" }, { id: "two" }]
        } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": {
            findComponentByCodeLazy: () => "role-icon",
            findCssClassesLazy: () => new Proxy({}, { get() { assert.equal(ready, true, "Discord classes are unavailable during module initialization"); return "role-icon"; } })
        },
        "./settings": { __esModule: true, default: { store: {} } }
    }, { React }, "({ CheckBadge })");
    ready = true;
    for (const badge of ["EquicordDonor", "VencordDonor", "DiscordProfile"]) {
        const rendered = CheckBadge({ badge, author: { id: "fixture", flags: 3 } });
        const keys = rendered.props.children[0].map((child: { props: { key: string; }; }) => child.props.key);
        assert.equal(keys.length, 2);
        assert.equal(new Set(keys).size, 2);
    }
});

test("animation preferences gate every patch and expose their restart requirement", () => {
    const store: Record<string, boolean> = {};
    const { default: plugin } = loadSource("src/plugins/alwaysAnimate/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } }
    });
    for (const [key, option] of Object.entries(plugin.settings.def) as [string, { restartNeeded?: boolean; }][]) {
        store[key] = false;
        assert.equal(option.restartNeeded, true, key);
    }
    const active = () => plugin.patches.filter((patch: { predicate?(): boolean; }) => !patch.predicate || patch.predicate());
    assert.equal(active().length, 0);
    store.roleGradients = true;
    assert.equal(active().length, 3);
});

test("emoji copy menus keep the real webpack proxy lazy until the Unicode action is used", () => {
    let lookups = 0;
    const copied: string[] = [];
    const plugin = loadComponent("src/plugins/copyEmojiMarkdown/index.tsx", {
        Menu: { MenuGroup: "group", MenuItem: "item" }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: { copyUnicode: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: (text: string) => copied.push(text) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => proxyLazy(() => { lookups++; return { convertNameToSurrogate: () => "🛒" }; }) }
    }).default;
    assert.equal(lookups, 0);
    const children: { props: { children: { props: { action: () => void; }; }[]; }; }[] = [];
    plugin.contextMenus["expression-picker"](children, { target: { dataset: { type: "emoji", name: "cart" } } });
    assert.equal(lookups, 0);
    children[0].props.children[0].props.action();
    assert.equal(lookups, 1);
    assert.deepEqual(copied, ["🛒"]);
});

test("sticker pack metadata updates preserve concurrent packs without holding a storage mutex", async () => {
    const entries = new Map<string, unknown>();
    let updates = 0;
    const module = loadComponent("src/equicordplugins/moreStickers/stickers.ts", {}, {
        "@api/DataStore": {
            async set(key: string, value: unknown) { entries.set(key, value); },
            async get(key: string) { return entries.get(key); },
            async del(key: string) { entries.delete(key); },
            async update(key: string, change: (value: unknown) => unknown) { updates++; entries.set(key, change(entries.get(key))); }
        },
        "./components": { async removeRecentStickerByPackId() {} }, "./utils": {}
    });
    await Promise.all([module.saveStickerPack({ id: "a", title: "A" }), module.saveStickerPack({ id: "b", title: "B" })]);
    assert.equal(updates, 2);
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["a", "b"]);
    await module.deleteStickerPack("a");
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["b"]);
});

test("theme watcher detects empty-folder changes and notifies once", async () => {
    let files: { fileName: string; }[] = [];
    const notices: string[] = [];
    const store = { includeLocal: true, includeOnline: false, autoRefresh: true, showNotifications: true, sortOrder: "recent" };
    const watcher = loadSource("src/equicordplugins/quickThemeSwitcher.discordDesktop/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), Settings: { enabledThemes: [], enabledThemeLinks: [], themeNames: {} }, SettingsStore: {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@shared/debounce": { debounce: (callback: () => void) => callback },
        "@utils/constants": { Devs: {}, IS_MAC: false },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, StartAt: {} },
        "@webpack/common": { showToast: (message: string) => notices.push(message), Toasts: { Type: { SUCCESS: 1 } } }
    }, { window: { VencordNative: { themes: { getThemesList: async () => files } } } },
    "(pluginStarted = true, { watch: watchForLocalThemeChanges, themes: () => themeList })");
    await watcher.watch();
    assert.equal(notices.length, 0);
    files = [{ fileName: "first.css" }];
    await watcher.watch();
    assert.equal(watcher.themes().length, 1);
    assert.deepEqual(notices, ["Added 1 local theme"]);
    files = [];
    await watcher.watch();
    assert.equal(watcher.themes().length, 0);
    assert.deepEqual(notices, ["Added 1 local theme", "Removed 1 local theme"]);
    store.showNotifications = false;
    files = [{ fileName: "second.css" }];
    await watcher.watch();
    assert.equal(watcher.themes().length, 1);
    assert.equal(notices.length, 2);
});

test("quote preview ignores superseded and unmounted image work", async () => {
    const effects: (() => (() => void) | void)[] = [];
    const states: unknown[] = [];
    let stateIndex = 0;
    const pending: ((image: Blob) => void)[] = [];
    const created: Blob[] = [];
    const revoked: string[] = [];
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const modal = loadSource("src/equicordplugins/quoter/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { grayscale: false, showWatermark: false, saveAsGif: false, watermark: "", quoteFont: "font" } }) },
        "@components/FormSwitch": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React, IconUtils: { getUserAvatarURL: () => "avatar" },
            useState: (initial: unknown) => { const index = stateIndex++; states[index] = initial; return [initial, (value: unknown) => { states[index] = value; }]; },
            useEffect: (effect: () => (() => void) | void) => effects.push(effect) },
        "./components/QuoteIcon": {}, "./types": { QuoteFont: {} },
        "./utils": { createQuoteImage: () => new Promise<Blob>(resolve => pending.push(resolve)) }
    }, { React, URL: { createObjectURL: (image: Blob) => { created.push(image); return "blob:preview"; }, revokeObjectURL: (url: string) => revoked.push(url) } }, "QuoteModal");
    modal({ message: { author: {}, content: "Quote" } });
    const firstCleanup = effects[1]();
    firstCleanup?.();
    const secondCleanup = effects[1]();
    const latest = new Blob(["latest"]);
    pending[1](latest);
    await Promise.resolve();
    pending[0](new Blob(["stale"]));
    await Promise.resolve();
    assert.equal(states[4], latest);
    assert.equal(created.length, 1);
    secondCleanup?.();
    assert.deepEqual(revoked, ["blob:preview"]);
    const closedCleanup = effects[1]();
    closedCleanup?.();
    pending[2](new Blob(["closed"]));
    await Promise.resolve();
    assert.equal(created.length, 1);
    assert.equal(states[4], null);
});

test("encrypted embeds discard decrypted content after invalidation or account change", async () => {
    let userId = "first";
    let extracted = 0;
    const pending: ((value: object) => void)[] = [];
    const cache = loadSource("src/equicordplugins/secureMessaging.desktop/embedCache.ts", {
        "@webpack": { findByCodeLazy: () => () => null },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./embedUrls": { extractSecureEmbedUrls: () => { extracted++; return []; } },
        "./messageMetadata": { discordEditedTimestamp: () => null },
        "./protocol": { isEncryptedMessage: () => true }
    }, { VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncoming: () => new Promise(resolve => pending.push(resolve)) } } } });
    const message = { channel_id: "channel", id: "message", author: { id: "sender" }, content: "ciphertext" };
    cache.patchEncryptedMessageEmbeds(message, () => {});
    cache.clearEncryptedEmbedCache();
    pending[0]({ status: "decrypted", plaintext: "private URL" });
    await setImmediate();
    assert.equal(extracted, 0);
    cache.patchEncryptedMessageEmbeds(message, () => {});
    userId = "second";
    cache.patchEncryptedMessageEmbeds(message, () => {});
    assert.equal(pending.length, 3);
    pending[1]({ status: "decrypted", plaintext: "old account" });
    await setImmediate();
    assert.equal(extracted, 0);
    pending[2]({ status: "decrypted", plaintext: "current account" });
    await setImmediate();
    assert.equal(extracted, 1);
});

test("encrypted attachment cache separates authenticated message contexts", async () => {
    let userId = "local-a";
    let decryptions = 0;
    const cache = loadSource("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./messageMetadata": loadSource("src/equicordplugins/secureMessaging.desktop/messageMetadata.ts", {}),
        "./protocol": { isEncryptedMessage: () => true }
    }, { VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncomingAttachments: async () => { decryptions++; return { status: "invalid_message" }; } } } } });
    const message = { channel_id: "channel", id: "message", author: { id: "sender" }, content: "ciphertext", attachments: [{ id: "attachment", size: 1, url: "url", proxy_url: "proxy" }], edited_timestamp: null as string | null };
    cache.encryptedAttachmentStatus(message);
    await Promise.resolve();
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 1);
    message.author.id = "other-sender";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 2);
    message.edited_timestamp = "2026-01-01T00:00:00.000Z";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 3);
    userId = "local-b";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 4);
});

test("screen recorder releases capture and discards work after disable", async () => {
    let resolvePicker: (stream: object) => void = () => {};
    let trackStops = 0;
    let uploads = 0;
    const track = { onended: null, stop: () => trackStops++ };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    class Recorder {
        state = "inactive";
        mimeType = "video/webm";
        ondataavailable?: (event: { data: Blob; }) => void;
        onstop?: () => void;
        start() { this.state = "recording"; }
        stop() {
            this.state = "inactive";
            queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["video"]) }); this.onstop?.(); });
        }
    }
    const module = loadSource("src/equicordplugins/screenRecorder.equibop/index.tsx", {
        "@components/Icons": {}, "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { DraftType: { ChannelMessage: 0 }, UploadHandler: { promptToUpload: () => uploads++ } }
    }, { navigator: { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { resolvePicker = resolve; }) } }, MediaRecorder: Recorder, File },
    "({ start: startRecording, finish: stopRecording, disable: exports.default.stop })");
    const pending = module.start({});
    module.disable();
    resolvePicker(stream);
    await pending;
    assert.equal(trackStops, 1);
    assert.equal(uploads, 0);
    const active = module.start({});
    resolvePicker(stream);
    await active;
    module.disable();
    await Promise.resolve();
    assert.ok(trackStops >= 2);
    assert.equal(uploads, 0);
    const normal = module.start({});
    resolvePicker(stream);
    await normal;
    module.finish();
    await Promise.resolve();
    assert.equal(uploads, 1);
});

test("scheduled reactions target the message returned by the send request", async () => {
    const reactions: string[] = [];
    const send = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
        "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
        "@vencord/discord-types/enums": {},
        "@webpack/common": { ChannelStore: { getChannel: () => ({}) }, FluxDispatcher: { dispatch() {} },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
            MessageStore: { getMessages: () => assert.fail("Must not guess from message history") },
            RestAPI: { post: async () => ({ body: { id: "sent-id" } }), put: async ({ url }: { url: string; }) => reactions.push(url) } },
        ".": { settings: { store: { showNotifications: false } } }
    }, { setTimeout: (callback: () => void) => callback() }, "sendScheduledMessage");
    assert.equal(await send({ id: "scheduled", channelId: "channel", content: "Repeated text", reactions: [{ emoji: { name: "hello", id: "emoji" }, count: 1 }] }), true);
    assert.deepEqual(reactions, ["/channels/channel/messages/sent-id/reactions/hello:emoji/@me"]);
});

test("GIF export reports the save result once", async () => {
    const notices: { body: string; }[] = [];
    let fail = true;
    const save = loadSource("src/equicordplugins/saveFavoriteGIFs/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {} },
        "@api/Notifications": { showNotification: (notice: { body: string; }) => notices.push(notice) },
        "@api/PluginManager": {}, "@api/Settings": { definePluginSettings: () => ({}) },
        "@equicordplugins/equicordToolbox": { __esModule: true, default: {} },
        "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} }, "@utils/web": {},
        "@webpack/common": { UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { getCurrentValue: () => ({ favoriteGifs: { gifs: { "https://example.com/gif": {} } } }) } } }
    }, { IS_DISCORD_DESKTOP: true, TextEncoder, fetch: async () => ({ ok: true }),
        DiscordNative: { fileManager: { saveWithDialog: async () => { if (fail) throw new Error("Save failed"); } } }
    }, "saveWorkingGifs");
    await save();
    assert.equal(notices.length, 2);
    assert.equal(notices[1].body, "Failed to save GIFs");
    notices.length = 0;
    fail = false;
    await save();
    assert.equal(notices.length, 2);
    assert.match(notices[1].body, /^Saved GIFs successfully/);
});

test("RPC editor asset placeholders read the original values", async () => {
    const { default: plugin } = loadSource("src/equicordplugins/rpcEditor/index.tsx", {
        "@api/index": { DataStore: { get: async () => [{ appId: "app", enabled: true, newActivityType: 0, newLargeImageText: "Changed", newSmallImageText: ":large_text:" }] } },
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/constants": { Devs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, STREAMING: 1 } },
        "@webpack/common": {}, "./ReplaceSettings": {}
    });
    await plugin.start();
    const activity = { application_id: "app", assets: { large_text: "Original", small_text: "Small" } };
    plugin.patchActivity(activity);
    assert.equal(activity.assets.large_text, "Changed");
    assert.equal(activity.assets.small_text, "Original");
});

test("Jellyfin privacy mode omits all identifying media fields", async () => {
    const store = { jf_serverUrl: "https://media.example", jf_apiKey: "key", jf_userId: "user", jf_privacyMode: true, jf_showPausedState: true, jf_overrideType: "off", jf_nameDisplay: "default", jf_customName: "{name} {name} {series} {album}" };
    let mediaType = "Episode";
    let paused = false;
    const getActivity = loadSource("src/equicordplugins/richPresence/services/jellyfin.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/text": {}, "@webpack/common": {}, "../settings": { settings: { store } },
        "./assetCache": { getCachedApplicationAsset: () => assert.fail("Private presence requested artwork") }
    }, { fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [
        { UserId: "user", NowPlayingItem: { Name: "Private title", SeriesName: "Private series", Album: "Private album", Artists: ["Private artist"], Type: mediaType, ImageTags: { Primary: "image" }, RunTimeTicks: 900000000, IndexNumber: 3, ParentIndexNumber: 2 }, PlayState: { PositionTicks: 50000000, IsPaused: paused } }
    ] }) }, "getActivity");
    for (const mode of ["default", "full", "custom"]) {
        store.jf_nameDisplay = mode;
        for (const type of ["Episode", "Audio", "Movie"]) {
            mediaType = type;
            for (const isPaused of [false, true]) {
                paused = isPaused;
                const activity = await getActivity();
                assert.deepEqual(JSON.parse(JSON.stringify(activity)), {
                    application_id: "1381368130164625469", name: "Jellyfin",
                    details: type === "Audio" ? "Listening to music" : "Watching media",
                    ...(paused ? { state: "Paused" } : {}), type: type === "Audio" ? 2 : 3, flags: 1
                });
            }
        }
    }
});

test("Jellyfin preserves zero playback position and omits missing position", async () => {
    let position: number | undefined = 0;
    const fetchMediaData = loadSource("src/equicordplugins/richPresence/services/jellyfin.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/text": {}, "@webpack/common": {},
        "../settings": { settings: { store: { jf_serverUrl: "https://media.example", jf_apiKey: "key", jf_userId: "user" } } },
        "./assetCache": {}
    }, { fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [
        { UserId: "user", NowPlayingItem: { Name: "Track", Type: "Audio" }, PlayState: { PositionTicks: position } }
    ] }) }, "fetchMediaData");
    assert.equal((await fetchMediaData()).position, 0);
    position = undefined;
    assert.equal((await fetchMediaData()).position, undefined);
    position = 25_000_000;
    assert.equal((await fetchMediaData()).position, 2);
});

test("audiobook authorization failures end the current update", async () => {
    const requests: string[] = [];
    const fetchMediaData = loadSource("src/equicordplugins/richPresence/services/audiobookshelf.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@webpack/common": {},
        "../settings": { settings: { store: { abs_serverUrl: "https://books.example", abs_username: "reader", abs_password: "password" } } },
        "./assetCache": {}
    }, { fetch: async (url: string) => {
        requests.push(url);
        assert.ok(requests.length <= 4, "Unexpected recursive retry");
        return url.endsWith("/login")
            ? { ok: true, json: async () => ({ user: { token: "token" } }) }
            : { ok: false, status: 401, statusText: "Unauthorized" };
    } }, "fetchMediaData");
    assert.equal(await fetchMediaData(), null);
    assert.equal(requests.length, 2);
    assert.equal(await fetchMediaData(), null);
    assert.equal(requests.length, 4);
});

test("an evicted asset rejection preserves its replacement request", async () => {
    let rejectOld: (reason: Error) => void = () => {};
    let requests = 0;
    const { getCachedApplicationAsset } = loadSource("src/equicordplugins/richPresence/services/assetCache.ts", {
        "@webpack/common": { ApplicationAssetUtils: { fetchAssetIds: () => {
            requests++;
            if (requests === 1) return new Promise<string[]>((_resolve, reject) => { rejectOld = reject; });
            return Promise.resolve(["asset"]);
        } } }
    });
    const old = getCachedApplicationAsset("app", "first");
    const rejection = assert.rejects(old, /failed/);
    for (let i = 0; i < 150; i++) await getCachedApplicationAsset("app", String(i));
    const replacement = getCachedApplicationAsset("app", "first");
    rejectOld(new Error("failed"));
    await rejection;
    assert.equal(getCachedApplicationAsset("app", "first"), replacement);
    assert.equal(requests, 152);
});

test("magnet filenames decode once and preserve literal punctuation", () => {
    const { default: plugin } = loadSource("src/equicordplugins/richMagnetLinks/index.tsx", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }, { URLSearchParams });
    const rule = plugin.magnetLink(1);
    for (const filename of ["a+b", "literal%20name", "100% complete", "what?now", "Café album"]) {
        const link = `magnet:?xt=urn:btih:abc&dn=${encodeURIComponent(filename)}`;
        assert.equal(rule.parse(rule.match(link), null, { messageId: "message" }).filename, filename);
    }
    assert.equal(rule.parse(rule.match("magnet:?xt=abc"), null, { messageId: "message" }).filename, "unknown filename");
});

test("remix releases its canvas after React detaches the ref", () => {
    const effects: (() => (() => void) | undefined)[] = [];
    const context = { drawImage() {} };
    const firstCanvas = { width: 0, height: 0, getContext: () => context };
    const secondCanvas = { ...firstCanvas };
    const ref: { current: typeof firstCanvas | null; } = { current: firstCanvas };
    const images: { onload: (() => void) | null; }[] = [];
    const revoked: string[] = [];
    let cleanups = 0;
    const module = loadSource("src/equicordplugins/remix/editor/components/Canvas.tsx", {
        "@equicordplugins/remix/editor/input": { initInput: () => () => cleanups++ },
        "@equicordplugins/remix/editor/tools/crop": {},
        "@equicordplugins/remix/editor/utils/canvas": {},
        "@webpack/common": { useRef: () => ref, useEffect: (effect: () => (() => void) | undefined) => effects.push(effect) }
    }, {
        React: { createElement: () => null },
        document: { createElement: () => ({ getContext: () => ({ canvas: {} }) }) },
        Image: class {
            width = 100;
            height = 100;
            onload: (() => void) | null = null;
            constructor() { images.push(this); }
        },
        URL: { createObjectURL: () => "blob:remix", revokeObjectURL: (url: string) => revoked.push(url) }
    });
    module.Canvas({ file: {} });
    const cleanup = effects[0]();
    images[0].onload?.();
    assert.equal(module.canvas, firstCanvas);
    ref.current = null;
    cleanup?.();
    assert.equal(module.canvas, null);
    assert.equal(module.ctx, null);
    assert.equal(cleanups, 1);
    assert.deepEqual(revoked, ["blob:remix"]);

    ref.current = firstCanvas;
    const oldCleanup = effects[0]();
    images[1].onload?.();
    ref.current = secondCanvas;
    const newCleanup = effects[0]();
    images[2].onload?.();
    oldCleanup?.();
    assert.equal(module.canvas, secondCanvas);
    ref.current = null;
    newCleanup?.();
    assert.equal(module.canvas, null);
});

test("recent DM cleanup closes an overlay after its setting changes", () => {
    const closed: string[] = [];
    const plugin = loadSource("src/equicordplugins/recentDMSwitcher/index.tsx", {
        "@api/DataStore": {}, "@api/Settings": { definePluginSettings: () => ({ store: { visualStyle: "off" } }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, makeRange: () => [] },
        "@webpack/common": { closeModal: (key: string) => closed.push(key) }
    }, { document: { removeEventListener() {} } },
    '({ finish: endCycleSession, stop: exports.default.stop, open: () => { overlayModalKey = "overlay"; isCyclingSessionActive = true; } })');
    plugin.open();
    plugin.finish();
    assert.deepEqual(closed, ["overlay"]);
    plugin.open();
    plugin.stop();
    plugin.stop();
    assert.deepEqual(closed, ["overlay", "overlay"]);
});


test("secure key reviews from a stopped session cannot change the new session gate", async () => {
    const pending: Array<(result: { status: string; }) => void> = [];
    const mocks: Record<string, object> = {};
    for (const name of ["@api/ChatButtons", "@api/MessageEvents", "@components/BaseText", "@components/Button", "@components/Heading", "@components/Span", "@utils/clipboard", "@utils/discord", "./attachments", "./attachmentUploads", "./conversationSelection", "./wireAuthorizations"])
        mocks[name] = {};
    mocks["@utils/constants"] = { EquicordDevs: { creations: {} } };
    mocks["@utils/types"] = { __esModule: true, default: (plugin: object) => plugin };
    mocks["@webpack/common"] = {
        UserStore: { getCurrentUser: () => ({ id: "local" }) },
        ChannelStore: { getChannel: () => undefined },
        CloudUploader: { prototype: {} }, RestAPI: {},
    };
    mocks["./attachmentCache"] = { clearEncryptedAttachmentCache() {} };
    mocks["./embedCache"] = { clearEncryptedEmbedCache() {} };
    mocks["./wireAuthorizations"] = { clearWirePayloadAuthorizations() {} };
    mocks["./keyReviewGate"] = loadSource("src/equicordplugins/secureMessaging.desktop/keyReviewGate.ts", {});
    mocks["./messageMetadata"] = { discordEditedTimestamp: () => null };
    mocks["./protocol"] = { isKeyAnnouncement: () => true };
    const source = loadSource("src/equicordplugins/secureMessaging.desktop/index.tsx", mocks, {
        VencordNative: { pluginHelpers: { SecureMessaging: {
            reviewAnnouncement: () => new Promise(resolve => pending.push(resolve)),
            setScreenCaptureProtection: async () => ({ status: "applied" }),
        } } },
    }, "({ plugin: exports.default, blocked: () => keyReviewGate.isBlocked('local', 'peer') })");
    const dispatch = () => source.plugin.flux.MESSAGE_CREATE({ message: { author: { id: "peer" }, channel_id: "channel", id: "message", content: "announcement" } });
    dispatch();
    source.plugin.stop();
    dispatch();
    pending[0]({ status: "trusted" });
    await setImmediate();
    assert.equal(source.blocked(), true, "old completion must not finish the new pending review");
    pending[1]({ status: "trusted" });
    await setImmediate();
    assert.equal(source.blocked(), false);
    dispatch();
    source.plugin.stop();
    dispatch();
    pending[3]({ status: "trusted" });
    await setImmediate();
    pending[2]({ status: "failed" });
    await setImmediate();
    assert.equal(source.blocked(), false, "old failure must not poison the new gate");
});


test("Sekai sticker images survive rerenders and exports keep their original channel", () => {
    const states: unknown[] = [];
    let stateIndex = 0;
    const effects: Array<() => () => void> = [];
    const ref = { current: null as unknown };
    const images: Array<{ onload: (() => void) | null; width: number; height: number; }> = [];
    class TestImage {
        onload: (() => void) | null = null;
        width = 296;
        height = 256;
        constructor() { images.push(this); }
    }
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        useState: (initial: unknown) => {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: unknown) => { states[index] = value; }];
        },
        useRef: () => ref,
        useEffect: (effect: () => () => void) => effects.push(effect),
    };
    let selectedChannel = "original";
    let uploadedChannel: unknown;
    let closed = 0;
    const { default: Editor } = loadSource("src/equicordplugins/sekaiStickers/Components/SekaiStickersModal.tsx", {
        "@components/Flex": { Flex: "flex" }, "@components/FormSwitch": {}, "@components/Heading": {},
        "@equicordplugins/sekaiStickers/characters.json": { characters: Array.from({ length: 51 }, () => ({ character: "fixture", img: "fixture.png", defaultText: { x: 1, y: 1, r: 0, s: 20 } })) },
        "@webpack/common": { React, Modal: "modal", SelectedChannelStore: { getChannelId: () => selectedChannel }, ChannelStore: { getChannel: (id: string) => id }, UploadHandler: { promptToUpload: (_files: unknown, channel: unknown) => { uploadedChannel = channel; } } },
        "./Canvas": { __esModule: true, default: "canvas" }, "./Picker": {},
    }, { React, Image: TestImage, File, document: { fonts: { check: () => true } } });
    const render = () => {
        stateIndex = 0;
        return Editor({ modalProps: { onClose: () => closed++ }, settings: { store: { AutoCloseModal: true } } });
    };
    let tree = render();
    const cleanup = effects[0]();
    assert.equal(tree.props.actions[1].disabled, true);
    images[0].onload?.();
    tree = render();
    assert.equal(images.length, 1, "a render reuses the loaded image");
    const callbacks: Array<(blob: Blob | null) => void> = [];
    const canvas = { toBlob: (callback: (blob: Blob | null) => void) => callbacks.push(callback) };
    let drawnImage: unknown;
    const context = { canvas, clearRect() {}, drawImage: (image: unknown) => { drawnImage = image; }, save() {}, restore() {}, translate() {}, rotate() {}, strokeText() {}, fillText() {} };
    tree.props.children[0].props.children[0].props.children[0].props.draw(context);
    assert.equal(drawnImage, images[0]);
    tree.props.actions[1].onClick();
    callbacks[0](null);
    assert.equal(closed, 0, "failed encoding preserves the editor");
    tree.props.actions[1].onClick();
    selectedChannel = "different";
    callbacks[1](new Blob(["png"]));
    assert.equal(uploadedChannel, "original");
    assert.equal(closed, 1);
    cleanup();
    assert.equal(images[0].onload, null, "cleanup detaches the obsolete load handler");
    states[1] = 50;
    tree = render();
    assert.equal(tree.props.actions[1].disabled, true, "a new character cannot export the previous image");
});


test("chat badge layout ignores foreign drops and preserves previous state", () => {
    let state: Array<{ key: string; position: number; shown: boolean; }> = [];
    let updates = 0;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { BadgeSettings } = loadSource("src/equicordplugins/showBadgesInChat/settings.tsx", {
        "@api/Settings": { definePluginSettings: (def: Record<string, { default?: unknown; }>) => ({ store: Object.fromEntries(Object.entries(def).map(([key, value]) => [key, value.default])) }) },
        "@components/BaseText": {}, "@utils/types": { OptionType: {} },
        "@webpack/common": {
            useEffect() {}, UserStore: { getCurrentUser: () => null },
            useState: (initial: typeof state) => { state = initial; return [state, (next: typeof state) => { state = next; updates++; }]; },
        },
    }, { React }, "({ BadgeSettings })");
    const tree = BadgeSettings();
    const items = tree.props.children[1].props.children[1];
    const previous = state;
    previous.forEach(Object.freeze);
    Object.freeze(previous);
    for (const value of ["", "other", "-1", "1.5", "6", "999999999999999999999999"])
        items[0].props.onDrop({ dataTransfer: { getData: () => value } });
    assert.equal(updates, 0);
    items[0].props.onDrop({ dataTransfer: { getData: () => "2" } });
    assert.equal(state[0].key, previous[2].key);
    assert.equal(state[0].position, 0);
    assert.equal(previous[2].position, 4);
    items[0].props.onClick();
    assert.equal(state[0].shown, false);
    assert.equal(previous[0].shown, true);
});


test("failed embed requests report once without updating the message", async () => {
    const toasts: string[] = [];
    const { unfurlEmbed } = loadSource("src/equicordplugins/showMessageEmbeds/index.tsx", {
        "@api/ContextMenu": {}, "@api/MessageUpdater": { updateMessage: () => assert.fail("failed requests cannot update embeds") },
        "@components/Icons": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": { parseUrl: () => ({}) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findByCodeLazy: () => () => assert.fail("failed requests cannot convert embeds") },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "channel" }) },
            Constants: { Endpoints: { UNFURL_EMBED_URLS: "/unfurl" } },
            RestAPI: { post: async () => { throw new Error("offline"); } },
            showToast: (message: string) => toasts.push(message), Toasts: { Type: {}, Position: {} },
        },
    }, {}, "({ unfurlEmbed })");
    await unfurlEmbed("https://example.com", { channel_id: "channel", id: "message" });
    assert.deepEqual(toasts, ["Failed to get embed"]);
});


test("sidebar DM lookups cannot override newer navigation or a closed sidebar", async () => {
    const pending: Array<(id: string) => void> = [];
    let handlers: Record<string, (payload?: object) => Promise<void> | void> = {};
    const { SidebarStore } = loadSource("src/equicordplugins/sidebarChat/store.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/lazy": { proxyLazy: (factory: () => object) => factory() },
        "@utils/types": { OptionType: {} },
        "@webpack/common": {
            Flux: { PersistedStore: class {
                constructor(_dispatcher: unknown, events: typeof handlers) { handlers = events; }
                emitChange() {}
            } },
            ChannelActionCreators: { getOrEnsurePrivateChannel: () => new Promise(resolve => pending.push(resolve)) },
        },
    });
    const first = handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "first-user" });
    handlers.VC_SIDEBAR_CHAT_CLOSE();
    pending[0]("first-dm");
    await first;
    assert.equal(SidebarStore.getState().channelId, "", "close invalidates pending DM navigation");
    const second = handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "second-user" });
    await handlers.VC_SIDEBAR_CHAT_NEW({ guildId: "guild", id: "newer-channel" });
    pending[1]("second-dm");
    await second;
    assert.equal(SidebarStore.getState().guildId, "guild");
    assert.equal(SidebarStore.getState().channelId, "newer-channel");
});


test("SongLink waits for command delivery and reports rejected sends", async () => {
    const replies: string[] = [];
    const delivery = Promise.withResolvers<void>();
    const { default: plugin } = loadSource("src/equicordplugins/songLink.desktop/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, findOption: () => "https://example.com/song", sendBotMessage: (_id: string, message: { content: string; }) => replies.push(message.content) },
        "@api/Settings": { definePluginSettings: () => ({ store: { servicesSettings: { spotify: { enabled: true } } } }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": { sendMessage: () => delivery.promise },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": {}, "./Providers": { Providers: { spotify: { name: "Spotify" } } }, "./Settings": {}, "./SongLinker": {},
    }, { VencordNative: { pluginHelpers: { SongLink: { getTrackData: async () => ({ links: { spotify: { url: "https://example.com/song" } } }) } } } });
    let finished = false;
    const command = plugin.commands[0].execute([], { channel: { id: "channel" } }).then(() => { finished = true; });
    await setImmediate();
    const returnedBeforeDelivery = finished;
    delivery.reject(new Error("delivery failed"));
    await command;
    assert.equal(returnedBeforeDelivery, false, "command stays pending until delivery settles");
    assert.equal(replies.at(-1), "Failed to resolve or send the music link.");
});
