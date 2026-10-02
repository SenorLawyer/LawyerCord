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
    const path = process.env.AUDIT_QUEST_STATE_SOURCE ?? "src/equicordplugins/questify/utils/questState.ts";
    const source = readFileSync(path, "utf8") + "\nexport { getLatestProgressTask, getMostRecentlyCompletedUnclaimedQuest };";
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    let ignoredReads = 0;
    let dateParses = 0;
    const ignored: string[] = [];
    const quests = new Map<string, object>();
    const modules: Record<string, unknown> = {
        "@vencord/discord-types/enums": { QuestTaskType: {} }, "@webpack/common": { QuestStore: { quests } },
        "../settings/access": { getQuestifySettings: () => ({ get ignoredQuestIDs() { ignoredReads++; return { user: ignored }; } }) },
        "../settings/def": { ignoredQuestIDsKey: "user" }, "./filtering": {}
    };
    const exports: {
        getLatestProgressTask?: (quest: object) => object | null;
        getMostRecentlyCompletedUnclaimedQuest?: () => object | null;
        getQuestStatus?: (quest: object, ignored: string[], checkIgnored?: boolean) => string;
    } = {};
    class CountingDate extends Date {
        constructor(value?: string | number) { super(value ?? Date.now()); if (typeof value === "string") dateParses++; }
    }
    runInNewContext(outputText, { exports, Date: CountingDate, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    assert.ok(exports.getLatestProgressTask && exports.getMostRecentlyCompletedUnclaimedQuest && exports.getQuestStatus);
    return { quests, ignored, latestTask: exports.getLatestProgressTask, latestQuest: exports.getMostRecentlyCompletedUnclaimedQuest, status: exports.getQuestStatus,
        get ignoredReads() { return ignoredReads; }, get dateParses() { return dateParses; } };
}

test("Questify selects the latest valid progress task in one pass and preserves stable ties", () => {
    const f = fixture();
    const tasks: Record<string, { type: string; }> = {};
    const progress: Record<string, object> = {};
    let timestampReads = 0;
    for (let i = 0; i < 100; i++) {
        const key = `task${i}`; tasks[key] = { type: key };
        progress[key] = { get updatedAt() { timestampReads++; return new Date(1000 * i).toISOString(); } };
    }
    assert.equal(f.latestTask({ config: { taskConfigV2: { tasks } }, userStatus: { progress } }), tasks.task99);
    assert.equal(timestampReads, 100); assert.equal(f.dateParses, 100);
    const first = { type: "first" }; const second = { type: "second" };
    const quest = { config: { taskConfigV2: { tasks: { first, second } } }, userStatus: { progress: {
        missing: { updatedAt: "2100-01-01" }, first: { updatedAt: "2026-01-01" }, second: { updatedAt: "2026-01-01" }
    } } };
    assert.equal(f.latestTask(quest), first);
    quest.userStatus.progress.first.updatedAt = "invalid"; assert.equal(f.latestTask(quest), second);
    assert.equal(f.latestTask({ config: { taskConfigV2: { tasks: {} } }, userStatus: { progress: {} } }), null);
});

test("Questify retains status precedence and skips ignored-ID scans for claimed quests or disabled filtering", () => {
    const f = fixture();
    const future = Date.now() + 100_000;
    const ignored = ["quest"];
    const make = (expiresAt: number | string, userStatus = {}) => ({ id: "quest", config: { expiresAt }, userStatus });
    assert.equal(f.status(make(future), ignored), "IGNORED");
    assert.equal(f.status(make(0), ignored), "EXPIRED");
    assert.equal(f.status(make(0, { completedAt: "completed" }), ignored), "IGNORED");
    assert.equal(f.status(make(0, { completedAt: "completed" }), []), "UNCLAIMED");
    assert.equal(f.status(make("invalid"), []), "UNCLAIMED");
    ignored.includes = () => { throw new Error("Ignored IDs must not be scanned."); };
    assert.equal(f.status(make(0, { claimedAt: "claimed" }), ignored), "CLAIMED");
    assert.equal(f.status(make(future), ignored, false), "UNCLAIMED");
});

test("Questify selects the latest eligible completion without sorting or copying ignored IDs per quest", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.quests.set(String(i), {
        id: String(i), config: { expiresAt: Date.now() + 10_000 }, userStatus: { completedAt: new Date(1000 * i).toISOString() }
    });
    f.ignored.push("99");
    f.quests.set("claimed", { id: "claimed", config: { expiresAt: 0 }, userStatus: { completedAt: "2100-01-01", claimedAt: "2100-01-01" } });
    assert.equal(f.latestQuest(), f.quests.get("98")); assert.equal(f.ignoredReads, 1); assert.equal(f.dateParses, 99);
    f.quests.set("tie", { id: "tie", config: { expiresAt: 0 }, userStatus: { completedAt: new Date(98_000).toISOString() } });
    assert.equal(f.latestQuest(), f.quests.get("98"));
    f.quests.clear(); assert.equal(f.latestQuest(), null);
});
