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

function fixture() {
    let account = "a";
    let finishRead: (value: unknown) => void = () => {};
    let sends = 0;
    const responses: { ok: boolean; }[] = [];
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (c: unknown) => c } },
        "@components/settings/tabs/plugins/components/Common": {},
        "@plugins/voiceMessages/waveform": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (p: unknown) => p, defineDefault: (v: unknown) => v, OptionType: {} },
        "@vencord/discord-types/enums": { MessageFlags: { IS_VOICE_MESSAGE: 8192 } },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "1" }) },
            UserStore: { getCurrentUser: () => ({ id: account }) },
            Constants: { Endpoints: { MESSAGES: () => "messages" } },
            SnowflakeUtils: { fromTimestamp: () => "nonce" },
            RestAPI: {
                get: () => new Promise(resolve => { finishRead = resolve; }),
                post: async () => { sends++; return { body: { id: "3", channel_id: "1" } }; }
            }
        },
        "../voiceMessageTranscriber.desktop/utils": {},
        "./policy": { DISCORD_MCP_TOOL_NAMES: ["send_message"], requireSnowflake: (v: string) => v, normalizeMessageContent: (v: string) => v }
    };
    const source = transpileModule(readFileSync("src/equicordplugins/discordMcp.desktop/index.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const loaded = runInNewContext(`${source}\n({ plugin: exports.default, handleBridgeRequest });`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        VencordNative: { pluginHelpers: { DiscordMCP: {
            writeResponse: async (response: { ok: boolean; }) => { responses.push(response); },
            recordSentMessage: async () => {}
        } } }, clearTimeout
    });
    return {
        plugin: loaded.plugin,
        run: () => loaded.handleBridgeRequest({ id: "request", tool: "send_message", arguments: { channel_id: "1", content: "hello", reply_to_message_id: "2" } }),
        finish: () => finishRead({ body: [{ id: "2", channel_id: "1" }] }),
        account: (id: string) => { account = id; },
        sends: () => sends, responses
    };
}

for (const action of ["stop", "account", "roundtrip"] as const) {
    test(`Discord MCP cancels deferred sends after ${action}`, async () => {
        const f = fixture();
        const pending = f.run();
        if (action === "stop") f.plugin.stop();
        else {
            f.account("b");
            f.plugin.flux.CONNECTION_OPEN?.();
            if (action === "roundtrip") { f.account("a"); f.plugin.flux.CONNECTION_OPEN?.(); }
        }
        f.finish();
        await pending;
        assert.equal(f.sends(), 0);
        assert.equal(f.responses[0].ok, false);
    });
}

test("Discord MCP still sends within its original session", async () => {
    const f = fixture();
    const pending = f.run();
    f.finish();
    await pending;
    assert.equal(f.sends(), 1);
    assert.equal(f.responses[0].ok, true);
});
