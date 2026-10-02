/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type * as Engine from "../src/components/settings/tabs/automations/engine";
import * as Model from "../src/components/settings/tabs/automations/model";

function fixture(poll?: (cursor: number) => Promise<{ cursor: number; events: unknown[]; }>, programs: Record<string, unknown> = {}) {
    const data = new Map<string, unknown>();
    const writes: string[][] = [];
    let clones = 0;
    let posts = 0;
    let systemCandidates = 0;
    const systemTypes: string[][] = [];
    let validations = 0;
    let compilations = 0;
    let account = "original-account";
    const handlers = new Map<string, Set<(event: unknown) => void>>();
    const modules = new Map<string, Record<string, unknown>>();
    const common = new Proxy({}, { get(_target, name) {
        if (name === "Logger") return class { error() {} warn() {} debug() {} };
        if (name === "RestAPI") return { async post({ body }: { body: Record<string, unknown>; }) { posts++; return { body: { ...body, id: "100000000000000001", author: { id: account } } }; } };
        if (name === "Constants") return { Endpoints: { MESSAGES: (id: string) => id } };
        if (name === "SnowflakeUtils") return { fromTimestamp: () => "100000000000000001" };
        if (name === "UserStore") return { getCurrentUser: () => ({ id: account }) };
        if (name === "FluxDispatcher") return {
            subscribe(name: string, handler: (event: unknown) => void) { const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set); },
            unsubscribe(name: string, handler: (event: unknown) => void) { handlers.get(name)?.delete(handler); },
        };
        return {};
    } });
    const storage = {
        async keys() { return [...data.keys()]; },
        async getMany(keys: string[]) { return keys.map(key => data.get(key)); },
        async del(key: string) { data.delete(key); },
        async get(key: string) { return data.get(key); },
        async update(key: string, updater: (value: unknown) => unknown) { data.set(key, updater(data.get(key))); },
        async set(key: string, value: unknown) { data.set(key, structuredClone(value)); },
        async setMany(entries: [string, unknown][]) { writes.push(entries.map(([key]) => key)); for (const [key, value] of entries) data.set(key, structuredClone(value)); },
    };
    function load(path: string): Record<string, unknown> {
        const cached = modules.get(path);
        if (cached) return cached;
        const exports: Record<string, unknown> = {};
        modules.set(path, exports);
        let source = readFileSync(path, "utf8");
        if (path.endsWith("engine.ts")) source += "\nexport { rememberCommands, pollSystem };";
        source = source.replace("function usesSystemTrigger(automation: Automation): boolean {", "function usesSystemTrigger(automation: Automation): boolean { countSystemCandidate();");
        if (path.endsWith("workflow.ts")) source = source
            .replace("function validateDefinition(automation: Automation): WorkflowIssue[] {", "function validateDefinition(automation: Automation): WorkflowIssue[] { countValidation();")
            .replace("const byId = new Map(automation.blocks.map", "countCompilation(); const byId = new Map(automation.blocks.map");
        const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { exports, Error, countSystemCandidate: () => systemCandidates++,
            VencordNative: { pluginHelpers: { AutomationCore: { ...programs, async pollSystemEvents(cursor: number, types: string[]) { systemTypes.push([...types]); if (poll) return poll(cursor); return { cursor: 1, events: [{ type: "process-start", process: { name: "unmatched.exe", pid: 1 } }] }; } } } }, countValidation: () => validations++, countCompilation: () => compilations++, crypto, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, window: { setTimeout, clearTimeout },
            structuredClone(value: unknown) { if (value && typeof value === "object" && "blocks" in value && Array.isArray(value.blocks)) clones++; return structuredClone(value); },
            require(name: string) {
                if (name === "@api/DataStore") return storage;
                if (name.startsWith("@") || name === "./spotify" || name === "./openRouter") return common;
                if (!name.startsWith(".")) return createRequire(import.meta.url)(name);
                return load(resolve(dirname(path), `${name}.ts`));
            },
        });
        return exports;
    }
    const api = load(resolve("src/components/settings/tabs/automations/engine.ts")) as typeof Engine & { pollSystem(): Promise<void>; rememberCommands(commands: Engine.AutomationCommandChoice[]): void; };
    return { api, data, writes, systemTypes, systemCandidates: () => systemCandidates, posts: () => posts, clones: () => clones, validations: () => validations, compilations: () => compilations, switchAccount(id = "new-account") { account = id; for (const handler of handlers.get("CONNECTION_OPEN") ?? []) handler({ user: { id: account } }); } };
}

function workflow() {
    const block = Model.createAutomationBlock("set-variable");
    block.config = { variable: "result", value: "original" };
    return { ...Model.createAutomation(), enabled: true, trigger: { type: "message" as const }, blocks: [block], entryId: block.id };
}

test("Repeated runs reuse the immutable definition and save only changed storage", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    await f.api.replaceAutomations([workflow()]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const id = f.api.getAutomationSnapshot().automations[0].id;
        await f.api.runAutomation(id);
        const before = f.clones();
        const compiled = f.compilations();
        const validated = f.validations();
        assert.ok(compiled > 0 && validated > 0);
        f.writes.length = 0;
        assert.equal((await f.api.runAutomation(id)).success, true);
        assert.equal(f.clones() - before, 0, "An unchanged workflow must not be cloned for its queue policy or last-run metadata.");
        assert.equal(f.compilations(), compiled);
        assert.equal(f.validations(), validated);
        assert.equal(f.writes.flat().includes("LawyerCord_automationGuilds"), false);
        assert.equal(f.writes.flat().includes("LawyerCord_automationLogs"), true);
        const savedLogs = f.data.get("LawyerCord_automationLogs") as Record<string, unknown>[];
        assert.ok(savedLogs.every(log => !Object.hasOwn(log, "preview") && !Object.hasOwn(log, "inputPreview")));
        assert.equal(f.api.getAutomationSnapshot().automations[0].lastStatus, "success");
    } finally { f.api.stopAutomationEngine(); }
});

test("Remembered command definitions are persisted without rewriting workflows", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    f.api.rememberCommands([{ id: "command", applicationId: "app", name: "test", description: "Test.", options: [], version: "1" }]);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.ok(f.data.has("LawyerCord_automationCommands"));
    assert.deepEqual(f.writes.flat(), ["LawyerCord_automationCommands"]);
});



test("Repeated child calls reuse one frozen definition and recheck deleted callees", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    const child = workflow();
    const parent = workflow();
    const repeat = Model.createAutomationBlock("repeat");
    const call = Model.createAutomationBlock("call-workflow");
    repeat.config.repeatCount = 20;
    repeat.next = call.id;
    call.config.workflowId = child.id;
    call.next = repeat.id;
    parent.blocks = [repeat, call];
    parent.entryId = repeat.id;
    await f.api.replaceAutomations([parent, child]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const before = f.clones();
        assert.equal((await f.api.runAutomation(parent.id)).success, true);
        assert.equal(f.clones() - before, 0, "Enabled definitions were prepared at startup, including the child.");
        await f.api.deleteAutomation(child.id);
        assert.equal((await f.api.runAutomation(parent.id)).success, false);
    } finally { f.api.stopAutomationEngine(); }
});

test("Account changes cancel delayed work and reject already queued runs", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    const flow = workflow();
    flow.runMode = "queue";
    const delay = Model.createAutomationBlock("delay");
    delay.config.durationSeconds = 0.1;
    const write = Model.createAutomationBlock("write-value");
    write.config = { persistentKey: "effect", input: { kind: "literal", value: true } };
    const send = Model.createAutomationBlock("send-message");
    send.config = { channelId: "100000000000000002", content: "Fixture only." };
    delay.next = send.id;
    send.next = write.id;
    flow.blocks = [delay, send, write];
    flow.entryId = delay.id;
    await f.api.replaceAutomations([flow]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const first = f.api.runAutomation(flow.id);
        const second = f.api.runAutomation(flow.id);
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        f.switchAccount();
        assert.equal((await first).success, false);
        assert.equal((await second).success, false);
        assert.equal(f.data.has(`LawyerCord_automationValues_${flow.id}`), false);
        assert.equal(f.posts(), 0);
        assert.equal((await f.api.runAutomation(flow.id)).success, true);
        assert.equal(f.posts(), 1, "A new explicit run may use the new account in the isolated fixture.");
    } finally { f.api.stopAutomationEngine(); }
});

test("Run admission belongs to the session that requested it before loading yields", async () => {
    for (const replacement of ["account", "round-trip", "restart"]) {
        const f = fixture();
        await f.api.loadAutomationState();
        const flow = workflow();
        const send = Model.createAutomationBlock("send-message");
        send.config = { channelId: "100000000000000002", content: "Fixture only." };
        flow.blocks = [send];
        flow.entryId = send.id;
        await f.api.replaceAutomations([flow]);
        await f.api.setAutomationSystemEnabled(true);
        await f.api.startAutomationEngine();
        try {
            const run = f.api.runAutomation(flow.id);
            if (replacement === "restart") {
                f.api.stopAutomationEngine();
                await f.api.startAutomationEngine();
            } else {
                f.switchAccount();
                if (replacement === "round-trip") f.switchAccount("original-account");
            }
            assert.equal((await run).success, false, replacement);
            assert.equal(f.posts(), 0, `${replacement} must discard the prior session's admission`);
            assert.equal((await f.api.runAutomation(flow.id)).success, true);
            assert.equal(f.posts(), 1);
        } finally { f.api.stopAutomationEngine(); }
    }
});

test("Edits during a run affect the next run without changing its active definition", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    const flow = workflow();
    const wait = Model.createAutomationBlock("delay");
    wait.config.durationSeconds = 0.05;
    const write = Model.createAutomationBlock("write-value");
    write.config = { persistentKey: "effect", input: { kind: "literal", value: "original" } };
    wait.next = write.id;
    flow.blocks = [wait, write];
    flow.entryId = wait.id;
    await f.api.replaceAutomations([flow]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const active = f.api.runAutomation(flow.id);
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        write.config.input = { kind: "literal", value: "edited" };
        flow.name = "Edited workflow";
        await f.api.upsertAutomation(flow);
        assert.equal((await active).success, true);
        assert.equal((f.data.get(`LawyerCord_automationValues_${flow.id}`) as { effect: string; }).effect, "original");
        assert.equal(f.api.getAutomationSnapshot().automations[0].name, "Edited workflow");
        assert.equal((await f.api.runAutomation(flow.id)).success, true);
        assert.equal((f.data.get(`LawyerCord_automationValues_${flow.id}`) as { effect: string; }).effect, "edited");
    } finally { f.api.stopAutomationEngine(); }
});

test("System polling visits indexed candidates and responds to enabled edits", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    const watched = { ...workflow(), trigger: { type: "process-start" as const, matchText: "chosen.exe" } };
    await f.api.replaceAutomations([...Array.from({ length: 100 }, workflow), watched]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const before = f.systemCandidates();
        await f.api.pollSystem();
        assert.equal(f.systemCandidates(), before, "Polling must use the trigger index rather than rescan every workflow.");
        assert.deepEqual(f.systemTypes.at(-1), ["process-start"]);
        await f.api.setAutomationEnabled(watched.id, false);
        await f.api.pollSystem();
        assert.deepEqual(f.systemTypes.at(-1), []);
    } finally { f.api.stopAutomationEngine(); }
});

test("Member search schedules the last query after the rate gap and releases cancelled work", () => {
    let now = 10_000;
    let account = "first";
    let sequence = 0;
    const timers = new Map<number, { at: number; callback: () => void; }>();
    const requested: string[] = [];
    const exports: { searchGuildMembers?: (guild: string, query: string, callback: (ids: string[]) => void) => () => void; } = {};
    const source = readFileSync("src/components/settings/tabs/automations/memberSearch.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { exports, Date: { now: () => now }, window: {
        setTimeout(callback: () => void, delay: number) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
        clearTimeout(id: number) { timers.delete(id); },
    }, require() { return { UserStore: { getCurrentUser: () => ({ id: account }) }, GuildMemberStore: { getMemberIds: () => [] }, FluxDispatcher: { dispatch({ query }: { query: string; }) { requested.push(query); } } }; } });
    assert.ok(exports.searchGuildMembers);
    const search = exports.searchGuildMembers;
    const advance = (ms: number) => {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    };
    search("100000000000000001", "first", () => {});
    advance(350);
    search("100000000000000001", "final", () => {});
    advance(350);
    assert.deepEqual(requested, ["first"]);
    advance(650);
    assert.deepEqual(requested, ["first", "final"]);
    const cancel = search("100000000000000001", "cancelled", () => {});
    advance(350);
    cancel();
    advance(1000);
    assert.deepEqual(requested, ["first", "final"]);
    search("100000000000000001", "old account", () => {});
    account = "second";
    advance(350);
    assert.deepEqual(requested, ["first", "final"]);
    search("100000000000000001", "first", () => {});
    advance(350);
    assert.deepEqual(requested, ["first", "final", "first"], "A previous account's search must not suppress a fresh request.");
});


test("Account changes release cooldown queued work even if the original account returns", async () => {
    const f = fixture();
    await f.api.loadAutomationState();
    const flow = workflow();
    flow.runMode = "queue";
    flow.cooldownSeconds = 60;
    await f.api.replaceAutomations([flow]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        assert.equal((await f.api.runAutomation(flow.id)).success, true);
        const queued = f.api.runAutomation(flow.id);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        f.switchAccount();
        f.switchAccount("original-account");
        assert.equal((await queued).success, false);
    } finally { f.api.stopAutomationEngine(); }
});

for (const returnToOriginal of [false, true]) test(`System polling discards events across account ${returnToOriginal ? "A to B to A" : "A to B"} without replay`, async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cursors: number[] = [];
    const f = fixture(async cursor => {
        cursors.push(cursor);
        if (cursors.length === 1) await gate;
        return { cursor: 1, events: cursor < 1 ? [{ type: "process-start", process: { name: "unmatched.exe", pid: 1 } }] : [] };
    });
    await f.api.loadAutomationState();
    const send = Model.createAutomationBlock("send-message");
    send.config = { channelId: "100000000000000002", content: "Fixture only." };
    const flow = { ...workflow(), trigger: { type: "process-start" as const, matchText: "unmatched.exe" }, blocks: [send], entryId: send.id };
    await f.api.replaceAutomations([flow]);
    await f.api.setAutomationSystemEnabled(true);
    await f.api.startAutomationEngine();
    try {
        const pending = f.api.pollSystem();
        f.switchAccount();
        if (returnToOriginal) f.switchAccount("original-account");
        release?.();
        await pending;
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        assert.equal(f.posts(), 0, "An old account's poll cannot start work in the new session.");
        await f.api.pollSystem();
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        assert.deepEqual(cursors, [0, 1], "Discarded events must be consumed so the next poll cannot replay them.");
        assert.equal(f.posts(), 0);
        assert.equal((await f.api.runAutomation(flow.id)).success, true);
        assert.equal(f.posts(), 1, "Fresh work in the current account still executes.");
    } finally { release?.(); f.api.stopAutomationEngine(); }
});


test("Stop and account replacement cancel the exact native program request", async () => {
    for (const reason of ["stop", "account", "ipcerror"]) {
        let requestId = "";
        const cancelled: string[] = [];
        let release: (() => void) | undefined;
        const f = fixture(undefined, {
            runProgram(input: { requestId: string; }) { requestId = input.requestId; return new Promise(resolve => { release = () => resolve({ success: false, error: "Stopped" }); }); },
            async cancelProgram(id: string) { cancelled.push(id); if (reason === "ipcerror") throw new Error("Renderer disconnected"); }
        });
        await f.api.loadAutomationState();
        const flow = workflow();
        const program = Model.createAutomationBlock("run-program");
        program.config.value = "fixture";
        flow.blocks = [program];
        flow.entryId = program.id;
        await f.api.replaceAutomations([flow]);
        await f.api.setAutomationSystemEnabled(true);
        await f.api.startAutomationEngine();
        try {
            const run = f.api.runAutomation(flow.id);
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(requestId);
            if (reason !== "account") f.api.stopAutomationEngine();
            else f.switchAccount();
            assert.deepEqual(cancelled, [requestId]);
            release?.();
            assert.equal((await run).success, false);
        } finally { release?.(); f.api.stopAutomationEngine(); }
    }
});
