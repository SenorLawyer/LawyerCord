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
