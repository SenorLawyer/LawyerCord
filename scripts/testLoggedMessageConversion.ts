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
    let user = { id: "author", username: "original", globalName: "Original" };
    let serializations = 0;
    class Message {
        constructor(data: object) { Object.assign(this, data); }
    }
    const modules: Record<string, unknown> = {
        "@webpack": { findLazy: () => Message,
            findByCodeLazy: () => (_channel: string, _id: string, embed: object) => embed },
        "@webpack/common": { UserStore: { getUser: () => user }, moment: (value: unknown) => value },
        "../db": { DBMessageStatus: {} }, "./constants": {}, "./index": { DISCORD_EPOCH: 1420070400000 }
    };
    function load(path: string): Record<string, unknown> {
        const { outputText } = transpileModule(readFileSync(path, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        });
        const exports = {};
        runInNewContext(outputText, { exports, IS_WEB: true, JSON: { stringify: (value: unknown) => { serializations++; return JSON.stringify(value); } },
            require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
        return exports;
    }
    const legacy = process.env.AUDIT_LOGGED_MEMO_SOURCE;
    if (legacy) modules["./memoize"] = load(legacy);
    else {
        try { modules["./memoize"] = load("src/equicordplugins/messageLoggerEnhanced/utils/memoize.ts"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const exports = load(process.env.AUDIT_LOGGED_CONVERSION_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/utils/misc.ts");
    const convert = exports.messageJsonToMessageClass as (log: { message: object; }) => { author: typeof user; };
    return { convert, get serializations() { return serializations; }, replaceUser() { user = { id: "author", username: "updated", globalName: "Updated" }; } };
}

test("Logged message conversion reads the current author after UserStore replaces a cached user", () => {
    const f = fixture();
    const log = { message: { id: "message", author: { id: "author" }, timestamp: "2026-10-01T00:00:00.000Z", embeds: [] } };
    assert.equal(f.convert(log).author.username, "original");
    f.replaceUser();
    assert.equal(f.convert(log).author.username, "updated");
});

test("Logged message reads do not serialize the entire payload into a permanent conversion cache", () => {
    const f = fixture();
    const log = { message: { id: "message", author: { id: "author" }, timestamp: "2026-10-01T00:00:00.000Z", embeds: [], content: "large history".repeat(1000) } };
    for (let i = 0; i < 100; i++) f.convert(log);
    assert.equal(f.serializations, 0);
});

test("Logged message conversion preserves stored history and snapshot timestamps across repeated reads", () => {
    const f = fixture();
    const timestamp = "2026-10-01T00:00:00.000Z";
    const log = { message: { id: "message", author: { id: "author" }, timestamp, embeds: [],
        editHistory: [{ timestamp, content: "old" }], messageSnapshots: [{ message: { timestamp, embeds: [] } }] } };
    for (let i = 0; i < 2; i++) {
        const converted = f.convert(log) as { author: object; editHistory: { timestamp: Date; }[]; messageSnapshots: { message: { timestamp: Date; }; }[]; };
        assert.equal(converted.editHistory[0].timestamp.toISOString(), timestamp);
        assert.equal(converted.messageSnapshots[0].message.timestamp.toISOString(), timestamp);
        assert.equal(log.message.editHistory[0].timestamp, timestamp);
        assert.equal(log.message.messageSnapshots[0].message.timestamp, timestamp);
    }
});

function cleanupFixture() {
    const modules: Record<string, unknown> = {
        "@webpack/common": { MessageStore: { getMessage: () => undefined }, lodash: { cloneDeep: structuredClone } },
        "./index": { getGuildIdByChannel: () => "guild", isGhostPinged: () => false }
    };
    const source = readFileSync(process.env.AUDIT_LOGGED_CLEANUP_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/utils/cleanUp.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const api = runInNewContext(outputText + "\nexports;", { exports: {},
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    return api.cleanupMessage as (message: object, removeDetails?: boolean) => Record<string, unknown>;
}

class DiscordMessageRecord {
    webhookId: string | undefined;
    editedTimestamp: Date | null = null;
    mentionEveryone = false;
    toJS() { return { ...this, webkhook_id: this.webhookId, edited_timestamp: this.editedTimestamp, mention_everyone: this.mentionEveryone }; }
}

test("Logged message cleanup skips transient render trees before copying a Discord record", () => {
    const cleanup = cleanupFixture();
    const timestamp = new Date("2026-10-03T00:00:00.000Z");
    const tree: { owner?: object; toJSON(): never; } = { toJSON() { assert.fail("Render state must not be serialized"); } };
    tree.owner = tree;
    const message = Object.assign(new DiscordMessageRecord(), {
        id: "message", channel_id: "channel", author: { id: "author" }, timestamp, type: 0,
        customRenderedContent: { content: tree }, __messageloggerAggregated: { originalNodes: tree },
        __messageloggerLastAppliedKey: "diff", __messageloggerDiff: tree, __messageloggerDiffKey: "diff"
    });
    const result = cleanup(message);
    assert.equal(result.timestamp, timestamp.toISOString());
    for (const key of ["customRenderedContent", "__messageloggerAggregated", "__messageloggerLastAppliedKey", "__messageloggerDiff", "__messageloggerDiffKey"])
        assert.equal(key in result, false);
    assert.equal(message.customRenderedContent.content, tree);
    assert.equal(message.__messageloggerAggregated.originalNodes, tree);
});

test("Logged message cleanup detaches plain payloads without changing Discord authors or history", () => {
    const cleanup = cleanupFixture();
    const message = {
        id: "message", channel_id: "channel", type: 0, timestamp: "2026-10-03T00:00:00.000Z",
        author: { id: "author", phone: "private phone", email: "private email" },
        editHistory: [{ content: "old", timestamp: "2026-10-02T00:00:00.000Z" }],
        attachments: [{ id: "attachment", url: "https://example.com/attachment" }]
    };
    const result = cleanup(message);
    const author = result.author as typeof message.author;
    assert.equal(author.phone, undefined);
    assert.equal(author.email, undefined);
    assert.equal(message.author.phone, "private phone");
    assert.equal(message.author.email, "private email");
    (result.editHistory as typeof message.editHistory)[0].content = "changed";
    (result.attachments as typeof message.attachments)[0].url = "changed";
    assert.equal(message.editHistory[0].content, "old");
    assert.equal(message.attachments[0].url, "https://example.com/attachment");
    const cached = cleanup(message, false).author as typeof message.author;
    assert.equal(cached.phone, "private phone");
    assert.notEqual(cached, message.author);
});

test("Logged reply cleanup strips referenced render state before copying the parent", () => {
    const cleanup = cleanupFixture();
    const renderState: { owner?: object; } = {};
    renderState.owner = renderState;
    const referenced = Object.assign(new DiscordMessageRecord(), {
        id: "referenced", channel_id: "channel", type: 0, author: { id: "author" },
        timestamp: new Date("2026-10-02T00:00:00.000Z"), customRenderedContent: renderState
    });
    const message = Object.assign(new DiscordMessageRecord(), {
        id: "reply", channel_id: "channel", type: 19, author: { id: "author" },
        timestamp: new Date("2026-10-03T00:00:00.000Z"),
        message_reference: { channel_id: "channel", message_id: "referenced" }, referenced_message: referenced
    });
    const result = cleanup(message);
    const saved = result.referenced_message as Record<string, unknown>;
    assert.equal(saved.timestamp, referenced.timestamp.toISOString());
    assert.equal("customRenderedContent" in saved, false);
    assert.equal(referenced.customRenderedContent, renderState);
});

test("Logged message cleanup preserves JSON timestamp formats throughout saved records", () => {
    const cleanup = cleanupFixture();
    const timestamp = new Date("2026-10-03T00:00:00.000Z");
    const message = Object.assign(new DiscordMessageRecord(), {
        id: "message", channel_id: "channel", type: 0, author: { id: "author" }, timestamp,
        editedTimestamp: timestamp, firstEditTimestamp: timestamp,
        editHistory: [{ timestamp, content: "old" }],
        call: { endedTimestamp: timestamp }, poll: { expiry: { toJSON: () => timestamp.toISOString() } },
        messageSnapshots: [{ message: { timestamp } }]
    });
    const result = cleanup(message);
    const expected = JSON.parse(JSON.stringify(message.toJS()));
    Object.assign(expected, { ghostPinged: false, guildId: "guild", embeds: [], deleted: false });
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
    assert.doesNotThrow(() => structuredClone(result));
});

test("Logged record cleanup preserves JSON conversions without retaining toJSON aliases", () => {
    const cleanup = cleanupFixture();
    const author = { id: "author", phone: "private phone", email: "private email" };
    const keys: string[] = [];
    const message = Object.assign(new DiscordMessageRecord(), {
        id: "message", channel_id: "channel", type: 0, timestamp: new Date("2026-10-03T00:00:00.000Z"),
        author: { toJSON(key: string) { keys.push(key); return author; } },
        callback: () => undefined, symbol: Symbol("transient"), invalidNumber: Infinity,
        values: [undefined, () => undefined, Symbol("transient"), NaN]
    });
    const result = cleanup(message);
    assert.deepEqual(keys, ["author"]);
    assert.equal(author.phone, "private phone");
    assert.equal(author.email, "private email");
    assert.equal("callback" in result, false);
    assert.equal("symbol" in result, false);
    assert.equal(result.invalidNumber, null);
    assert.equal(JSON.stringify(result.values), "[null,null,null,null]");
    assert.doesNotThrow(() => structuredClone(result));
});
