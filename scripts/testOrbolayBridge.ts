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

function fixture(port = 6888) {
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_ORBOLAY_SOURCE ?? "src/equicordplugins/orbolayBridge/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    let userId: string | undefined = "first";
    let voice: { userId: string; channelId: string; guildId: string; } | undefined;
    let nextId = 0;
    const callbacks = new Set<() => void>();
    const timers = new Map<number, () => void>();
    const toasts: { type: number; }[] = [];
    const dispatched: Record<string, unknown>[] = [];
    const sockets: Socket[] = [];
    class Socket {
        static OPEN = 1;
        readyState = 0;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: { data: unknown; }) => void) | null = null;
        sent: Record<string, unknown>[] = [];
        constructor(readonly url: string) { sockets.push(this); }
        send(data: string) { assert.equal(this.readyState, Socket.OPEN); this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; this.onclose?.(); }
        open() { this.readyState = Socket.OPEN; return this.onopen?.(); }
    }
    const exports: { default?: {
        start(): void; stop(): void;
        flux: Record<string, (event: object) => void | Promise<void>>;
    }; } = {};
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({ store: { port } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { warn() {} } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": {
            UserStore: {
                getCurrentUser: () => userId ? { id: userId } : undefined,
                getUser: (id: string) => ({ globalName: id, avatar: "avatar" }),
                addChangeListener: (callback: () => void) => callbacks.add(callback),
                removeChangeListener: (callback: () => void) => callbacks.delete(callback)
            },
            ChannelStore: { getChannel: (id: string) => ({ id, guild_id: "guild" }) },
            GuildMemberStore: { getNick: () => "nickname" },
            StreamerModeStore: { enabled: true },
            VoiceStateStore: {
                getVoiceStateForUser: () => voice,
                getVoiceStatesForChannel: () => voice ? { [voice.userId]: voice } : {}
            },
            FluxDispatcher: { dispatch: (event: Record<string, unknown>) => dispatched.push(event) },
            Toasts: { show: (value: { type: number; }) => toasts.push(value), Type: { FAILURE: 0, SUCCESS: 1 }, genId: () => "toast" }
        }
    };
    runInNewContext(outputText, {
        exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, WebSocket: Socket,
        setTimeout: (callback: () => void) => { timers.set(++nextId, callback); return nextId; },
        clearTimeout: (id: number) => timers.delete(id), console: { log() {} }
    });
    const plugin = exports.default; assert.ok(plugin);
    return { plugin, sockets, timers, toasts, callbacks, dispatched,
        account(value?: string) { userId = value; for (const cb of callbacks) cb(); },
        voice(channelId: string) { voice = { userId: userId ?? "", channelId, guildId: "guild" }; return voice; },
        timeout() { const work = [...timers.values()]; timers.clear(); work.forEach(cb => cb()); }
    };
}

test("Orbolay stop removes socket callbacks and connection deadlines", async () => {
    const f = fixture(); f.plugin.start();
    const socket = f.sockets[0]; const opened = socket.onopen;
    f.plugin.stop();
    assert.equal(f.timers.size, 0);
    assert.equal(f.callbacks.size, 0);
    assert.equal(socket.readyState, 3);
    assert.equal(socket.onmessage, null);
    await opened?.();
    assert.equal(f.toasts.length, 0); assert.equal(socket.sent.length, 0);
});

test("Orbolay stale socket events cannot clear or send through a replacement connection", async () => {
    const f = fixture(); f.plugin.start();
    const old = f.sockets[0]; const close = old.onclose; const error = old.onerror; const open = old.onopen;
    f.plugin.stop(); f.plugin.start(); const socket = f.sockets[1];
    close?.(); assert.doesNotThrow(() => error?.()); await open?.();
    await socket.open();
    assert.equal(socket.sent[0].cmd, "REGISTER_CONFIG");
    f.plugin.flux.SPEAKING({ userId: "speaker", speakingFlags: 1 });
    assert.equal(socket.sent.at(-1)?.cmd, "VOICE_STATE_UPDATE");
    assert.equal(old.sent.length, 0); f.plugin.stop();
});

test("Orbolay closes failed sockets and skips sends before opening", async () => {
    const f = fixture(); f.plugin.start();
    assert.doesNotThrow(() => f.plugin.flux.SPEAKING({ userId: "speaker", speakingFlags: 1 }));
    f.timeout(); assert.equal(f.sockets[0].readyState, 3);
    assert.equal(f.toasts.filter(t => t.type === 0).length, 1);
    f.plugin.stop(); f.plugin.start(); await f.sockets[1].open();
    assert.equal(f.timers.size, 0);
    f.timeout(); assert.equal(f.toasts.filter(t => t.type === 0).length, 1);
    f.plugin.stop();
});

test("Orbolay rejects malformed commands and retains valid navigation and voice notifications", async () => {
    const f = fixture(); f.voice("channel"); f.plugin.start(); const socket = f.sockets[0]; await socket.open();
    assert.deepEqual(socket.sent.map(p => p.cmd), ["REGISTER_CONFIG", "STREAMER_MODE", "CHANNEL_JOINED"]);
    for (const data of ["{", "null", "[]", "x".repeat(4097), 7, JSON.stringify({ cmd: "NAVIGATE", guild_id: {}, channel_id: "bad", message_id: true })])
        assert.doesNotThrow(() => socket.onmessage?.({ data }));
    assert.equal(f.dispatched.length, 0);
    const id = "123456789012345678";
    socket.onmessage?.({ data: JSON.stringify({ cmd: "NAVIGATE", guild_id: id, channel_id: id, message_id: id }) });
    socket.onmessage?.({ data: JSON.stringify({ cmd: "TOGGLE_MUTE" }) });
    assert.equal(f.dispatched[0].type, "CHANNEL_SELECT"); assert.equal(f.dispatched[1].type, "AUDIO_TOGGLE_SELF_MUTE");
    await f.plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [f.voice("newChannel")] });
    assert.equal(socket.sent.at(-1)?.cmd, "CHANNEL_JOINED");
    assert.equal(f.timers.size, 0); f.plugin.stop();
});

test("Orbolay account changes close the old connection and cannot accept its commands", async () => {
    const f = fixture(); f.plugin.start(); const old = f.sockets[0]; await old.open(); const message = old.onmessage;
    f.account("second"); assert.equal(old.readyState, 3); assert.equal(f.sockets.length, 2);
    message?.({ data: JSON.stringify({ cmd: "TOGGLE_DEAF" }) }); assert.equal(f.dispatched.length, 0);
    await f.sockets[1].open(); assert.equal(f.sockets[1].sent[0].userId, "second");
    f.account(); assert.equal(f.sockets[1].readyState, 3); assert.equal(f.timers.size, 0);
    f.account("third"); assert.equal(f.sockets.length, 3);
    f.plugin.stop(); f.account("fourth"); assert.equal(f.sockets.length, 3);
});

test("Orbolay does not construct sockets for invalid saved ports", () => {
    for (const port of [0, -1, 65536, NaN, 3.5]) {
        const f = fixture(port); f.plugin.start(); assert.equal(f.sockets.length, 0); f.plugin.stop();
    }
});
