/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { Queue } from "../src/utils/Queue";

function fixture() {
    let handlers: Record<string, (event?: unknown) => void> = {};
    const preloads: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const modules = { Queue, proxyLazy: (factory: () => unknown) => factory(), sleep: async () => {},
        GuildChannelStore: { getDefaultChannel: () => ({ id: "channel" }) },
        ChannelActionCreators: { async preload(id: string) { preloads.push(id); if (preloads.length === 1) await gate; } },
        Flux: { Store: class { constructor(_dispatcher: unknown, events: typeof handlers) { handlers = events; } } }
    };
    const source = readFileSync(process.env.AUDIT_MEMBER_COUNT_SOURCE ?? "src/plugins/memberCount/OnlineMemberCountStore.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(`${code}\nexports.OnlineMemberCountStore;`, { exports: {}, require: () => modules }) as { getCount(id: string): number | undefined; ensureCount(id: string): void; };
    return { api, preloads, release: () => release?.(), emit(name: string, event?: unknown) { handlers[name]?.(event); } };
}

test("Online counts release departed guilds and previous accounts through repeated sessions", () => {
    const f = fixture();
    for (let cycle = 0; cycle < 100; cycle++) {
        const guildId = String(cycle);
        f.emit("ONLINE_GUILD_MEMBER_COUNT_UPDATE", { guildId, count: 42 });
        assert.equal(f.api.getCount(guildId), 42);
        f.emit("GUILD_DELETE", { guild: { id: guildId } });
        assert.equal(f.api.getCount(guildId), undefined);
        f.emit("ONLINE_GUILD_MEMBER_COUNT_UPDATE", { guildId, count: 17 });
        f.emit(cycle % 2 ? "LOGOUT" : "CONNECTION_OPEN");
        assert.equal(f.api.getCount(guildId), undefined);
    }
});

test("Changing accounts skips queued online-count preloads from the old session", async () => {
    const f = fixture();
    f.api.ensureCount("first");
    await setImmediate();
    for (let i = 0; i < 100; i++) f.api.ensureCount(String(i));
    f.emit("LOGOUT");
    f.release();
    await setImmediate();
    assert.deepEqual(f.preloads, ["first"]);
    f.api.ensureCount("fresh");
    await setImmediate();
    assert.deepEqual(f.preloads, ["first", "fresh"]);
});
