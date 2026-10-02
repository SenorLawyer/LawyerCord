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

test("Pending screenshare source lookup cannot start after stop, account or channel change", async () => {
    for (const change of ["stop", "account", "channel", "account-return", "channel-return", "none"]) {
        let userId = "a";
        let channelId = "one";
        let starts = 0;
        let release: (value: unknown) => void = () => {};
        const source = new Promise(resolve => { release = resolve; });
        const code = transpileModule(readFileSync("src/equicordplugins/instantScreenshare/index.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
        const plugin = runInNewContext(code + "\nexports.default;", {
            exports: {}, require(name: string) {
                if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value };
                if (name === "@api/UserSettings") return { getUserSettingLazy: () => ({ getSetting: () => false }) };
                if (name === "@webpack") return { findByCodeLazy: (code: string) => code.includes("STREAM_START") ? () => { starts++; } : () => {}, findStoreLazy: () => ({ getState: () => ({}) }) };
                if (name === "./utils") return { getCurrentMedia: () => source, settings: { store: {} } };
                if (name === "@webpack/common") return {
                    UserStore: { getCurrentUser: () => ({ id: userId }) }, SelectedChannelStore: { getVoiceChannelId: () => channelId },
                    ChannelStore: { getChannel: () => ({ isDM: () => true, isGroupDM: () => false }) }
                };
                return { Devs: {}, EquicordDevs: {} };
            }
        });
        plugin.start?.();
        const pending = plugin.autoStartStream();
        if (change === "stop") plugin.stop();
        if (change.startsWith("account")) { userId = "b"; plugin.flux.CONNECTION_OPEN?.(); }
        if (change === "account-return") { userId = "a"; plugin.flux.CONNECTION_OPEN?.(); }
        if (change.startsWith("channel")) { channelId = "two"; await plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId, channelId }] }); }
        if (change === "channel-return") { channelId = "one"; await plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId, channelId }] }); }
        release({ id: "screen:1", name: "Screen" });
        await pending;
        assert.equal(starts, change === "none" ? 1 : 0, change);
    }
});
