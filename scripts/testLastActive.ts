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

function fixture(guildId: string | null = null) {
    let accountId = "self", selected = "channel";
    const requests: { url: string; query?: object; resolve(value: object): void; reject(error: Error): void; }[] = [];
    const navigation: string[] = [];
    const notices: string[] = [];
    const modules: Record<string, unknown> = {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: accountId }) },
            SelectedChannelStore: { getChannelId: () => selected },
            Constants: { Endpoints: { SEARCH_CHANNEL: (id: string) => `/channels/${id}/messages/search`, SEARCH_GUILD: (id: string) => `/guilds/${id}/messages/search` } },
            RestAPI: { get: ({ url, query }: { url: string; query?: object; }) => new Promise((resolve, reject) => requests.push({ url, query, resolve, reject })) },
            NavigationRouter: { transitionTo: (url: string) => navigation.push(url) },
            Toasts: { Type: { FAILURE: "failure" }, genId: () => "toast", show: ({ message }: { message: string; }) => notices.push(message) }
        }
    };
    const code = transpileModule(readFileSync("src/equicordplugins/lastActive/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(`${code}\n({plugin: exports.default, jumpToLastActive});`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, console: { error() {} }
    });
    api.plugin.start?.();
    const reply = (id = "correct") => ({ body: { messages: [[
        { id: "context", hit: false, channel_id: "channel", author: { id: "other" } },
        { id, hit: true, channel_id: "channel", author: { id: "self" } }
    ]] } });
    return { requests, navigation, notices, reply, plugin: api.plugin,
        jump: () => api.jumpToLastActive({ id: "channel", guild_id: guildId }),
        switchAccount: () => { accountId = "other"; }, navigate: () => { selected = "elsewhere"; api.plugin.flux?.CHANNEL_SELECT?.(); }, returnToChannel: () => { selected = "channel"; api.plugin.flux?.CHANNEL_SELECT?.(); }
    };
}

test("last active searches the correct DM or guild endpoint and selects the actual hit", async () => {
    for (const guildId of [null, "guild"]) {
        const f = fixture(guildId);
        const pending = f.jump();
        const request = f.requests[0];
        assert.equal(request.url, guildId ? "/guilds/guild/messages/search" : "/channels/channel/messages/search");
        request.resolve(f.reply()); await pending;
        assert.deepEqual(f.navigation, [`/channels/${guildId ?? "@me"}/channel/correct`]);
    }
});

test("last active cannot navigate or show stale errors after stop, account change or navigation", async () => {
    for (const boundary of ["stop", "account", "navigation"]) for (const fail of [false, true]) {
        const f = fixture(); const pending = f.jump();
        if (boundary === "stop") f.plugin.stop?.();
        if (boundary === "account") f.switchAccount();
        if (boundary === "navigation") f.navigate();
        if (fail) f.requests[0].reject(new Error("Offline")); else f.requests[0].resolve(f.reply());
        await pending;
        assert.deepEqual(f.navigation, []); assert.deepEqual(f.notices, []);
    }
});

test("last active keeps the latest navigation request", async () => {
    const f = fixture(); const old = f.jump(), current = f.jump();
    f.requests[1].resolve(f.reply("new")); await current;
    f.requests[0].resolve(f.reply("old")); await old;
    assert.deepEqual(f.navigation, ["/channels/@me/channel/new"]);
});

test("last active rejects retained actions after stop and navigation away and back", async () => {
    const stopped = fixture();
    stopped.plugin.stop();
    const action = stopped.jump();
    assert.equal(stopped.requests.length, 0);
    await action;
    const moved = fixture();
    const pending = moved.jump();
    moved.navigate(); moved.returnToChannel();
    moved.requests[0].resolve(moved.reply()); await pending;
    assert.deepEqual(moved.navigation, []);
});
