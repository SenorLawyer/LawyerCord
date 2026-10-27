/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPluginModule } from "./testDiscordMcpHarness";

const tick = () => new Promise(resolve => setImmediate(resolve));

interface Response { id: string; ok: boolean; error?: string; result?: unknown; }

const settingsStore = {
    allowRelationshipActions: false, allowMembershipActions: false, allowAccountActions: false,
    allowModerationActions: false, allowRoleActions: false, allowChannelManagement: false,
    channelBurstLimit: 5, channelHourlyLimit: 60, globalBurstLimit: 10, globalHourlyLimit: 120, uploadDirectories: "",
};

function fixture(overrides: Record<string, Record<string, unknown>> = {}) {
    let account = "a";
    let finishRead: (value: unknown) => void = () => { };
    let sends = 0;
    const responses: Response[] = [];
    const errors: string[] = [];
    const takes: Array<(requests: unknown[]) => void> = [];
    const externals = {
        "@api/Settings": { definePluginSettings: () => ({ store: settingsStore }) },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/settings/tabs/plugins/components/Common": {},
        "@plugins/voiceMessages/waveform": {},
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(message: string) { errors.push(message); } } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, defineDefault: (value: unknown) => value, OptionType: {} },
        "@utils/misc": { sleep: async () => { } },
        "@utils/discord": {},
        "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: 1 } },
        "../voiceMessageTranscriber.desktop/utils": {},
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "1", type: 0, guild_id: undefined }) },
            UserStore: { getCurrentUser: () => ({ id: account }), getUser: () => undefined },
            Constants: { Endpoints: { MESSAGES: () => "messages", MESSAGE: () => "message" } },
            SnowflakeUtils: { fromTimestamp: () => "nonce" },
            RestAPI: {
                get: () => new Promise(resolve => { finishRead = resolve; }),
                post: async () => { sends++; return { status: 200, body: { id: "3", channel_id: "111111111111111111" } }; },
            },
        },
    };
    const native = {
        writeResponse: async (response: Response) => { responses.push(response); },
        recordSentMessage: async () => { },
        takeRequests: () => new Promise<unknown[]>(resolve => { takes.push(resolve); }),
    };
    const loaded = loadPluginModule("index", externals, { VencordNative: { pluginHelpers: { DiscordMCP: native } } }, overrides, ["handleBridgeRequest", "bridgeLoop"]) as {
        default: { stop(): void; flux: Record<string, (() => void) | undefined>; };
        __expose: { handleBridgeRequest(request: unknown): Promise<void>; bridgeLoop(generation: number): Promise<void>; };
    };
    const exposed = loaded.__expose;
    return {
        plugin: loaded.default,
        exposed,
        run: () => exposed.handleBridgeRequest({ id: "request", tool: "send_message", arguments: { channel_id: "111111111111111111", content: "hello", reply_to_message_id: "222222222222222222" } }),
        finish: () => finishRead({ status: 200, body: [{ id: "222222222222222222", channel_id: "111111111111111111" }] }),
        account: (id: string) => { account = id; },
        sends: () => sends,
        responses,
        errors,
        takes,
    };
}

for (const action of ["stop", "account", "roundtrip"] as const) {
    test(`Discord MCP cancels deferred sends after ${action}`, async () => {
        const f = fixture();
        const pending = f.run();
        await tick();
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
        await tick();
    f.finish();
    await pending;
    assert.equal(f.sends(), 1);
    assert.equal(f.responses[0].ok, true);
});

test("Discord MCP answers requests claimed just before stop instead of dropping them", async () => {
    const f = fixture();
    const loop = f.exposed.bridgeLoop(0);
    assert.equal(f.takes.length, 1);
    f.plugin.stop();
    f.takes[0]([{ id: "claimed-1", tool: "whoami" }, { id: "claimed-2", tool: "list_servers" }]);
    await loop;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.responses.map(response => response.id), ["claimed-1", "claimed-2"]);
    for (const response of f.responses) {
        assert.equal(response.ok, false);
        assert.match(response.error ?? "", /stopped or restarted/);
    }
    assert.equal(f.takes.length, 1, "the loop does not poll again after stopping");
    assert.deepEqual(f.errors, []);
});

test("Discord MCP keeps polling and handles claimed requests while running", async () => {
    const f = fixture({ handlers: { executeTool: async () => ({ ok: true }), resetBridgeState() { } } });
    const loop = f.exposed.bridgeLoop(0);
    f.takes[0]([{ id: "live-1", tool: "whoami" }]);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.responses.map(response => [response.id, response.ok]), [["live-1", true]]);
    assert.equal(f.takes.length, 2);
    f.plugin.stop();
    f.takes[1]([]);
    await loop;
});

test("Discord MCP refuses results that are too large to return", async () => {
    const f = fixture({ handlers: { executeTool: async () => ({ blob: "x".repeat(2_100_000) }), resetBridgeState() { } } });
    await f.exposed.handleBridgeRequest({ id: "big", tool: "whoami", arguments: {} });
    assert.equal(f.responses[0].ok, false);
    assert.match(f.responses[0].error ?? "", /too large/);
});

test("Discord MCP rejects tool names it does not know", async () => {
    const f = fixture({ handlers: { executeTool: async () => ({}), resetBridgeState() { } } });
    await f.exposed.handleBridgeRequest({ id: "unknown", tool: "arbitrary_request", arguments: {} });
    assert.equal(f.responses[0].ok, false);
    assert.match(f.responses[0].error ?? "", /Unsupported/);
});
