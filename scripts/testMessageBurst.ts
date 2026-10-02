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
    const pending = Promise.withResolvers<void>();
    const edits: { channelId: string; messageId: string; content: string; }[] = [];
    const latest = { id: "previous", author: { id: "self" }, content: "First", timestamp: new Date(), attachments: [] };
    const store = { timePeriod: 3, shouldMergeWithAttachment: false, useSpace: false };
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ isGroupDM: () => false }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            MessageStore: { getLastMessage: () => latest, getMessages: () => ({ last: () => latest }) },
            MessageActions: { editMessage: (channelId: string, messageId: string, { content }: { content: string; }) => {
                edits.push({ channelId, messageId, content });
                return pending.promise;
            } }
        }
    };
    const code = transpileModule(readFileSync("src/equicordplugins/messageBurst/index.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const plugin = runInNewContext(`${code}\nexports.default;`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        document: { querySelector: () => null }
    });
    return { plugin, pending, edits, latest, store };
}

test("message bursts preserve the reply reference captured by the send", async () => {
    const { plugin, edits } = fixture();
    const outgoing = { content: "Reply" };
    const result = plugin.onBeforeMessageSend("channel", outgoing, { messageReference: { message_id: "reply-target" } });
    assert.equal(edits.length, 0);
    await result;
    assert.equal(outgoing.content, "Reply");
});

test("message bursts never overwrite another pending merge in the same channel", async () => {
    const { plugin, pending, edits } = fixture();
    const first = { content: "Second" };
    const second = { content: "Third" };
    const merging = plugin.onBeforeMessageSend("channel", first, {});
    const next = plugin.onBeforeMessageSend("channel", second, {});
    assert.equal(edits.length, 1);
    pending.resolve();
    await Promise.all([merging, next]);
    assert.equal(first.content, "");
    assert.equal(second.content, "Third");
    assert.deepEqual(edits, [{ channelId: "channel", messageId: "previous", content: "First\nSecond" }]);
});

test("message bursts retain text on failed edits and release the pending channel", async () => {
    const { plugin, pending, edits, store } = fixture();
    const outgoing = { content: "Second" };
    const merging = plugin.onBeforeMessageSend("channel", outgoing, {});
    pending.reject(new Error("Edit failed"));
    await assert.rejects(merging, /Edit failed/);
    assert.equal(outgoing.content, "Second");
    store.useSpace = true;
    await assert.rejects(plugin.onBeforeMessageSend("channel", outgoing, {}), /Edit failed/);
    assert.equal(edits.length, 2);
    assert.equal(edits[1].content, "First Second");
});

test("message bursts keep channels independent while edits are pending", async () => {
    const { plugin, pending, edits } = fixture();
    const first = plugin.onBeforeMessageSend("first", { content: "Second" }, {});
    const second = plugin.onBeforeMessageSend("second", { content: "Third" }, {});
    assert.equal(edits.length, 2);
    pending.resolve();
    await Promise.all([first, second]);
});
