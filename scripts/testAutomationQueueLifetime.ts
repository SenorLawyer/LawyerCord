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

import { createAutomation } from "../src/components/settings/tabs/automations/model";
import type { createRunQueue } from "../src/components/settings/tabs/automations/runQueue";

test("Queue cooldown history belongs to saved workflows and outstanding jobs", async () => {
    let history: Map<string, number> | undefined;
    const source = readFileSync("src/components/settings/tabs/automations/runQueue.ts", "utf8").replace("const lastStarted = new Map<string, number>();", "const lastStarted = new Map<string, number>(); inspectHistory(lastStarted);");
    const exports: { createRunQueue?: typeof createRunQueue; } = {};
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { exports, crypto, Error, AbortController, structuredClone, setTimeout, clearTimeout, inspectHistory: (map: Map<string, number>) => { history = map; } });
    assert.ok(exports.createRunQueue);
    const queue = exports.createRunQueue(() => {});
    const saved = createAutomation();
    queue.retainWorkflows?.([saved.id]);
    await queue.enqueue(saved, async () => {});
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.ok(history);
    assert.equal(history.size, 1);
    for (let i = 0; i < 20; i++) await queue.enqueue(createAutomation(), async () => {});
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(history.size, 1, "Finished unsaved test workflows do not retain cooldown records.");
    let finish: (() => void) | undefined;
    const active = queue.enqueue(saved, () => new Promise<void>(resolve => { finish = resolve; }));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    queue.retainWorkflows?.([]);
    assert.equal(history.size, 1, "An outstanding run still owns its cooldown record.");
    finish?.();
    await active;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(history.size, 0, "The last outstanding run releases a removed workflow.");
    queue.cancel();
});
