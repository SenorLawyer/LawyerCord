/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as Model from "../src/components/settings/tabs/automations/model";
import type * as Runtime from "../src/components/settings/tabs/automations/runtime";
import type * as Events from "../src/components/settings/tabs/automations/events";
import type * as Regex from "../src/components/settings/tabs/automations/regex";

function fixture() {
    const blobs = new Map<string, Blob>();
    const workers = new Set<Worker>();
    let created = 0;
    class BrowserWorker {
        onmessage?: (event: { data: unknown; }) => void;
        onerror?: (event: { preventDefault(): void; }) => void;
        private stopped = false;
        private ready: Promise<Worker>;
        constructor(url: string) {
            const blob = blobs.get(url);
            assert.ok(blob);
            this.ready = blob.text().then(source => {
                const worker = new Worker(`const { parentPort } = require("node:worker_threads"); let onmessage; const postMessage = data => parentPort.postMessage(data); ${source}; parentPort.on("message", data => onmessage({ data }));`, { eval: true });
                created++;
                workers.add(worker);
                worker.on("exit", () => workers.delete(worker));
                worker.on("message", data => this.onmessage?.({ data }));
                worker.on("error", () => this.onerror?.({ preventDefault() {} }));
                if (this.stopped) void worker.terminate();
                return worker;
            });
        }
        postMessage(data: unknown) { void this.ready.then(worker => { if (!this.stopped) worker.postMessage(data); }); }
        terminate() { this.stopped = true; void this.ready.then(worker => worker.terminate()); }
    }
    const modules = new Map<string, Record<string, unknown>>();
    const require = createRequire(import.meta.url);
    function load(path: string): Record<string, unknown> {
        const cached = modules.get(path);
        if (cached) return cached;
        const exports: Record<string, unknown> = {};
        modules.set(path, exports);
        const code = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { exports, Error, Blob, Worker: BrowserWorker, setTimeout, clearTimeout, structuredClone, crypto, AbortController, require(name: string) {
            return name.startsWith(".") ? load(resolve(dirname(path), `${name}.ts`)) : require(name);
        }, URL: {
            createObjectURL(blob: Blob) { const url = crypto.randomUUID(); blobs.set(url, blob); return url; },
            revokeObjectURL(url: string) { blobs.delete(url); }
        } });
        return exports;
    }
    const api = load(resolve("src/components/settings/tabs/automations/regex.ts")) as typeof Regex;
    const runtime = load(resolve("src/components/settings/tabs/automations/runtime.ts")) as typeof Runtime;
    const events = load(resolve("src/components/settings/tabs/automations/events.ts")) as typeof Events;
    return { evaluate: api.evaluateRegex, stop: api.stopRegexWorker, runtime, events, created: () => created, blobs, workers };
}

test("Real regex workers preserve tests, captures and reuse without holding blob URLs", async () => {
    const f = fixture();
    try {
        assert.deepEqual(Array.from((await f.evaluate("(?<=hello )world", ["HELLO WORLD", "world"])).matches), [true, false]);
        assert.equal((await f.evaluate("(a+)(b)\\2", ["Aaabb"], true)).text, "Aaa");
        await assert.rejects(f.evaluate("[", ["text"]));
        assert.equal((await f.evaluate("^ok$", ["ok"])).matches[0], true);
        assert.equal(f.created(), 1);
        assert.equal(f.blobs.size, 0);
    } finally { f.stop(); }
});

test("Catastrophic patterns leave the main thread responsive and time out before queued work", async () => {
    const f = fixture();
    let beats = 0;
    const interval = setInterval(() => beats++, 10);
    try {
        const started = Date.now();
        const slow = assert.rejects(f.evaluate("^(a+)+$", ["a".repeat(40) + "!"]), /one second/);
        const queued = f.evaluate("^ok$", ["ok"]);
        await slow;
        assert.equal((await queued).matches[0], true);
        assert.ok(beats >= 5);
        assert.ok(Date.now() - started < 5000);
        assert.equal(f.created(), 2);
    } finally { clearInterval(interval); f.stop(); }
});

test("Aborting active and pending regex jobs preserves following jobs and engine stop releases all work", async () => {
    const f = fixture();
    try {
        const active = new AbortController();
        const pending = new AbortController();
        const first = assert.rejects(f.evaluate("^(a+)+$", ["a".repeat(40) + "!"], false, active.signal));
        const second = assert.rejects(f.evaluate("x", ["x"], false, pending.signal));
        const third = f.evaluate("yes", ["yes"]);
        pending.abort();
        active.abort();
        await Promise.all([first, second]);
        assert.equal((await third).matches[0], true);
        const stopped = assert.rejects(f.evaluate("^(a+)+$", ["a".repeat(40) + "!"]));
        f.stop();
        await stopped;
        await assert.rejects(f.evaluate("x".repeat(4097), ["x"]), /4096/);
        await assert.rejects(f.evaluate("x", ["x".repeat(100001)]), /100000/);
        assert.equal((await f.evaluate("again", ["again"])).matches[0], true);
    } finally { f.stop(); }
});


test("Queued regex inputs have an aggregate bound that cancellation releases", async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
        const jobs = [assert.rejects(f.evaluate("^(a+)+$", ["a".repeat(40) + "!"], false, controller.signal))];
        const texts = Array.from({ length: 10 }, () => "x".repeat(100000));
        for (let index = 0; index < 3; index++) jobs.push(assert.rejects(f.evaluate("x", texts, false, controller.signal)));
        await assert.rejects(f.evaluate("x", texts), /4000000/);
        controller.abort();
        await Promise.all(jobs);
        assert.equal((await f.evaluate("x", texts)).matches.length, 10);
    } finally { f.stop(); }
});


test("Runtime regex values, conditions and triggers use the worker and preserve routing", async () => {
    const f = fixture();
    const extract = Model.createAutomationBlock("regex-extract");
    extract.config = { input: { kind: "literal", value: "hello 123" }, matchText: "(\\d+)", variable: "result" };
    const condition = Model.createAutomationBlock("condition");
    condition.config = { input: { kind: "reference", value: "result" }, operator: "regex", compareValue: "^123$" };
    const fail = Model.createAutomationBlock("fail");
    extract.next = condition.id;
    condition.alternate = fail.id;
    const workflow = { ...Model.createAutomation(), blocks: [extract, condition, fail], entryId: extract.id, enabled: true, trigger: { type: "message" as const, matchMode: "regex" as const, matchText: "^hello" } };
    const env: Runtime.RuntimeEnvironment = { now: Date.now, random: Math.random, delay: f.runtime.delay, external: async () => { throw new Error("Unexpected external block."); }, persistent: async () => undefined, workflows: () => [workflow], trace() {} };
    try {
        assert.equal(await f.runtime.executeWorkflow(workflow, {}, env), "123");
        const index = f.events.compileTriggers([workflow]);
        const event: Events.TriggerEvent = { type: "MESSAGE_CREATE", channelId: "channel", guildId: "guild", authorId: "user", content: "HELLO", self: false, bot: false, mention: false, fromEngine: false };
        assert.equal((await f.events.matchTriggers(index, event)).length, 1);
        assert.equal((await f.events.matchTriggers(index, { ...event, content: "other" })).length, 0);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(f.events.matchTriggers(index, event, controller.signal));
        assert.equal(f.created(), 1);
    } finally { f.stop(); }
});
