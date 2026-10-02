/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

function moyai() {
    const delays: Array<() => void> = [];
    const sounds: Array<{ src: string; paused: boolean; onended: (() => void) | null; onerror: (() => void) | null }> = [];
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({ store: { volume: 0.5, quality: "Normal", triggerWhenUnfocused: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, makeRange: () => [], OptionType: {} },
        "@utils/misc": { sleep: () => new Promise<void>(resolve => delays.push(resolve)) },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "channel" }, RelationshipStore: {}, UserStore: {} }
    };
    const code = transformSync(readFileSync("src/equicordplugins/moyai/index.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
    const plugin = runInNewContext(`${code};module.exports.default`, { module: { exports: {} }, require: (name: string) => modules[name], document: { createElement: () => {
        const audio = { src: "", volume: 0, paused: false, onended: null, onerror: null,
            play: () => Promise.resolve(), pause() { this.paused = true; }, removeAttribute() { this.src = ""; }, load() {} };
        sounds.push(audio);
        return audio;
    } } });
    plugin.start?.();
    const message = { optimistic: false, type: "MESSAGE_CREATE", channelId: "channel", message: { content: "\u{1f5ff}\u{1f5ff}", author: { id: "friend" } } };
    return { plugin, sounds, delays, message };
}

test("Moyai stop releases active audio and prevents delayed sounds after restart", async () => {
    const f = moyai();
    const pending = f.plugin.flux.MESSAGE_CREATE(f.message);
    assert.equal(f.sounds.length, 1);
    f.plugin.stop?.();
    assert.equal(f.sounds[0].paused, true);
    assert.equal(f.sounds[0].src, "");
    f.plugin.start?.();
    f.delays.shift()?.();
    await pending;
    assert.equal(f.sounds.length, 1);
});

test("Moyai burst admission and simultaneous audio remain bounded", async () => {
    const f = moyai();
    const pending = Array.from({ length: 100 }, () => f.plugin.flux.MESSAGE_CREATE(f.message));
    assert.ok(f.delays.length <= 4);
    assert.ok(f.sounds.length <= 4);
    f.plugin.stop?.();
    for (const resolve of f.delays.splice(0)) resolve();
    await Promise.all(pending);
});


test("VoiceJoinMessages does not inject a delayed message after stop or account change", async () => {
    for (const action of ["stop", "account"]) {
        let userId = "accountA";
        const pending = Promise.withResolvers<void>();
        const dispatched: unknown[] = [];
        const modules: Record<string, unknown> = {
            "@api/Settings": { definePluginSettings: () => ({ store: { allowedFriends: "", ignoredFriends: "" } }) },
            "@utils/constants": { Devs: {} }, "@utils/text": {},
            "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
            "@utils/Logger": { Logger: class { warn() {} } },
            "@webpack": { findByCodeLazy: () => (props: object) => ({ ...props }) },
            "@webpack/common": { MessageStore: { hasPresent: () => false }, MessageActions: { fetchMessages: () => pending.promise },
                UserStore: { getUser: () => ({}), getCurrentUser: () => ({ id: userId }) }, FluxDispatcher: { dispatch: (event: unknown) => dispatched.push(event) } }
        };
        const source = readFileSync("src/equicordplugins/voiceJoinMessages/index.ts", "utf8") + "\nexport { sendVoiceStatusMessage };";
        const code = transformSync(source, { loader: "ts", format: "cjs" }).code;
        const api = runInNewContext(`${code};module.exports`, { module: { exports: {} }, require: (name: string) => modules[name] });
        api.default.start();
        api.sendVoiceStatusMessage("dm", "Local fixture", "friend");
        if (action === "stop") { api.default.stop(); api.default.start(); }
        else userId = "accountB";
        pending.resolve();
        await pending.promise;
        await Promise.resolve();
        assert.equal(dispatched.length, 0, action);
    }
});
