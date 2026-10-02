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

interface TagSettings { showInChat: boolean; showInNotChat: boolean; text: string; }
interface TagPlugin {
    start(): void;
    getTag(props: object): number | null;
    localTags: Record<string | number, string | number>;
}

function fixture() {
    let permissionComputations = 0;
    let tableEnumerations = 0;
    let permissions = 0n;
    let guild: { ownerId: string; } | undefined = { ownerId: "owner" };
    const bits = new Proxy({
        ADMINISTRATOR: 1n, MANAGE_GUILD: 2n, MANAGE_CHANNELS: 4n, MANAGE_ROLES: 8n,
        MANAGE_MESSAGES: 16n, KICK_MEMBERS: 32n, BAN_MEMBERS: 64n, MOVE_MEMBERS: 128n,
        MUTE_MEMBERS: 256n, DEAFEN_MEMBERS: 512n, MODERATE_MEMBERS: 1024n, UNRELATED: 2048n
    }, { ownKeys(target) { tableEnumerations++; return Reflect.ownKeys(target); } });
    const settings = { store: { tagSettings: {} as Record<string, TagSettings>, dontShowForBots: false, showWebhookTagFully: false } };
    const channel = { guild_id: "guild", permissionOverwrites: {} };
    const devs = new Proxy({}, { get: () => ({ id: 1n }) });
    const mocks: Record<string, unknown> = {
        "./styles.css": {}, "@api/Settings": { migratePluginToSettings() {} }, "@utils/constants": { Devs: devs, EquicordDevs: devs },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {}, "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findLazy: () => () => null, findByCodeLazy: () => () => { permissionComputations++; return permissions; } },
        "@webpack/common": { ChannelStore: { getChannel: () => channel }, GuildStore: { getGuild: () => guild }, PermissionsBits: bits },
        "./settings": settings
    };
    function load(file: string) {
        const { outputText } = transpileModule(readFileSync(file, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
        });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } });
    }
    mocks["./settings"] = { settings };
    mocks["./consts"] = load("src/equicordplugins/moreUserTags/consts.ts");
    const plugin = load(process.env.AUDIT_TAG_SOURCE ?? "src/equicordplugins/moreUserTags/index.tsx").default as TagPlugin;
    plugin.start();
    const render = (id = "user", extra = {}) => {
        const tagId = plugin.getTag({ user: { id, bot: false, isNonUserBot: () => true }, channel, isChat: true, ...extra });
        return tagId === null ? null : plugin.localTags[tagId];
    };
    return { bits, render, settings, tableEnumerations: () => tableEnumerations,
        computations: () => permissionComputations, grant: (value: bigint) => { permissions = value; }, dm: () => { guild = undefined; } };
}

test("user tags skip permission computation for webhook, owner and disabled permission tags", () => {
    const f = fixture();
    assert.equal(f.render("user", { message: { webhookId: "webhook", type: 0 } }), "WEBHOOK");
    assert.equal(f.render("owner"), "OWNER");
    for (const [name, setting] of Object.entries(f.settings.store.tagSettings)) {
        if (name !== "WEBHOOK" && name !== "OWNER") setting.showInChat = false;
    }
    assert.equal(f.render(), null);
    assert.equal(f.computations(), 0);
    assert.equal(f.tableEnumerations(), 0);
});

test("user tags test only configured permission bits and preserve tag precedence", () => {
    const f = fixture();
    const cases = [[f.bits.UNRELATED, null], [f.bits.MODERATE_MEMBERS, "CHAT_MODERATOR"], [f.bits.MUTE_MEMBERS, "VOICE_MODERATOR"],
        [f.bits.BAN_MEMBERS, "MODERATOR"], [f.bits.MANAGE_ROLES | f.bits.BAN_MEMBERS, "MODERATOR_STAFF"],
        [f.bits.ADMINISTRATOR | f.bits.MANAGE_GUILD, "ADMINISTRATOR"]] as const;
    for (const [bits, expected] of cases) {
        const before = f.computations();
        f.grant(bits);
        assert.equal(f.render(), expected);
        assert.equal(f.computations() - before, 1);
    }
    assert.equal(f.tableEnumerations(), 0);
    f.settings.store.tagSettings.ADMINISTRATOR.showInChat = false;
    assert.equal(f.render(), "MODERATOR_STAFF");
});

test("user tag owner exclusions, followed webhooks, bot filters and DMs retain their behavior", () => {
    const f = fixture();
    f.grant(f.bits.ADMINISTRATOR);
    f.settings.store.tagSettings.OWNER.showInChat = false;
    assert.equal(f.render("owner"), null);
    assert.equal(f.render("owner", { isChat: false }), "OWNER");
    f.settings.store.tagSettings.OWNER.showInNotChat = false;
    assert.equal(f.render("owner", { isChat: false }), null);
    assert.equal(f.render("user", { message: { webhookId: "webhook", type: 0, messageReference: {} } }), "ADMINISTRATOR");
    f.settings.store.showWebhookTagFully = true;
    assert.equal(f.render("user", { message: { webhookId: "webhook", type: 0, messageReference: {} } }), "WEBHOOK");
    f.settings.store.dontShowForBots = true;
    assert.equal(f.render("user", { user: { id: "user", bot: true } }), null);
    assert.equal(f.render("1"), null);
    f.dm();
    const before = f.computations();
    assert.equal(f.render(), null);
    assert.equal(f.computations(), before);
});
