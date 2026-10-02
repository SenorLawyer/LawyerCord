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

function load(file: string, modules: Record<string, unknown>, inspect = "") {
    const source = transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    return runInNewContext(`${source}; ({...exports, ${inspect}})`, { exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
}

test("Voice logs retain bounded recent events and channel history through an aging session", () => {
    const api = load("src/equicordplugins/voiceChannelLog/logs.ts", {
        "./settings": { __esModule: true, default: { store: { maxEntries: 1000 } } }
    }, "vcLogs");
    for (let i = 0; i < 20_000; i++) api.addLogEntry({ channelId: "busy", userId: String(i), timestamp: new Date(), type: "join" });
    assert.equal(api.getVcLogs("busy").length, 1000);
    assert.equal(api.getVcLogs("busy")[0].userId, "19000");
    for (let i = 0; i < 500; i++) api.addLogEntry({ channelId: String(i), userId: "user", timestamp: new Date(), type: "join" });
    assert.ok(api.vcLogs.size <= 50);
    for (let channel = 0; channel < 30; channel++) for (let event = 0; event < 1000; event++)
        api.addLogEntry({ channelId: String(channel), userId: "user", timestamp: new Date(), type: "join" });
    assert.ok(Array.from(api.vcLogs.values()).reduce((sum: number, entries: unknown) => sum + (Array.isArray(entries) ? entries.length : 0), 0) <= 10_000);
    api.clearLogs("499");
    assert.equal(api.vcLogs.has("499"), false);
});

test("Voice log snapshots only track participants in the selected voice channel", () => {
    const settings = { store: { ignoreBlockedUsers: false, logJoinLeave: true } };
    const api = load("src/equicordplugins/voiceChannelLog/index.tsx", {
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@vencord/discord-types/enums": { ChannelType: {} }, "@webpack": { findByPropsLazy: () => ({}) },
        "@webpack/common": { SelectedChannelStore: { getVoiceChannelId: () => "selected" }, UserStore: { getCurrentUser: () => ({ id: "self" }) } },
        "./components/LogsButton": {}, "./components/VoiceChannelLogModal": {},
        "./logs": { addLogEntry() {}, setCallStartTime() {}, clearLogs() {} }, "./settings": { __esModule: true, default: settings }
    }, "previousStates");
    const update = api.default.flux.VOICE_STATE_UPDATES;
    for (let i = 0; i < 20_000; i++) update({ voiceStates: [{ userId: String(i), channelId: "elsewhere", oldChannelId: "elsewhere" }] });
    assert.equal(api.previousStates.size, 0);
    update({ voiceStates: [{ userId: "peer", channelId: "selected", oldChannelId: "selected" }] });
    assert.equal(api.previousStates.size, 1);
    update({ voiceStates: [{ userId: "peer", channelId: "elsewhere", oldChannelId: "selected" }] });
    assert.equal(api.previousStates.size, 0);
    update({ voiceStates: [{ userId: "peer", channelId: "selected", oldChannelId: "selected" }] });
    api.default.flux.VOICE_CHANNEL_SELECT({ channelId: "next", currentVoiceChannelId: "selected" });
    assert.equal(api.previousStates.size, 0);
    update({ voiceStates: [{ userId: "peer", channelId: "selected", oldChannelId: "selected" }] });
    api.default.flux.LOGOUT();
    assert.equal(api.previousStates.size, 0);
});
