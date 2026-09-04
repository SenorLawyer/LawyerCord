/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { validateResult } from "../src/components/settings/tabs/automations/ai";
import { duplicateBlocks, editorReducer, removeBlocks } from "../src/components/settings/tabs/automations/editorState";
import { compileTriggers, matchTriggers, type TriggerEvent } from "../src/components/settings/tabs/automations/events";
import { type Automation, type AutomationBlock, createAutomation, createAutomationBlock, createAutomationFile } from "../src/components/settings/tabs/automations/model";
import { createRunQueue } from "../src/components/settings/tabs/automations/runQueue";
import { abortable, delay, executeWorkflow, type RunEvent, type RuntimeEnvironment, updateSavedValue } from "../src/components/settings/tabs/automations/runtime";
import { nextOccurrence, schedulePreview, validateSchedule } from "../src/components/settings/tabs/automations/scheduling";
import { readPath } from "../src/components/settings/tabs/automations/values";
import { duplicateWorkflows, migrateWorkflow, parseWorkflowFile, validateWorkflow } from "../src/components/settings/tabs/automations/workflow";

function workflow(...blocks: AutomationBlock[]): Automation {
    return { ...createAutomation(), blocks, entryId: blocks[0]?.id };
}

function environment(workflows: Automation[]) {
    const events: RunEvent[] = [];
    const calls: string[] = [];
    const values = new Map<string, unknown>();
    let clock = 0;
    const env: RuntimeEnvironment = {
        now: () => clock,
        random: () => 0.5,
        delay: async (ms, signal) => { if (signal.aborted) throw new Error("Cancelled"); clock += ms; },
        external: async block => { calls.push(block.id); return { value: block.config.sample, port: block.config.sample === null ? "alternate" : "next" }; },
        persistent: async (id, operation, key, input) => { const name = id + key; const value = updateSavedValue(values.get(name), operation, input); values.set(name, value); return value; },
        workflows: () => workflows,
        trace: event => events.push(event),
    };
    return { env, events, calls, values };
}

async function main() {
    const wait = createAutomationBlock("wait-reply");
    const normal = createAutomationBlock("set-variable");
    const timeout = createAutomationBlock("set-variable");
    normal.config = { variable: "result", value: "normal" };
    timeout.config = { variable: "result", value: "timeout" };
    wait.config.sample = null;
    wait.next = normal.id;
    wait.alternate = timeout.id;
    const waiting = workflow(wait, normal, timeout);
    const setup = environment([waiting]);
    assert.equal(await executeWorkflow(waiting, {}, setup.env), "timeout");
    assert.equal(setup.events.filter(event => event.status === "running").length, 2);
    wait.config.sample = { content: "reply" };
    assert.equal(await executeWorkflow(waiting, {}, setup.env), "normal");

    const root = createAutomationBlock("note"), left = createAutomationBlock("log"), right = createAutomationBlock("log"), shared = createAutomationBlock("log");
    root.next = [left.id, right.id]; left.next = shared.id; right.next = shared.id;
    const fan = workflow(root, left, right, shared);
    const fanEnv = environment([fan]);
    await executeWorkflow(fan, {}, fanEnv.env);
    assert.deepEqual(fanEnv.events.filter(e => e.status === "running").map(e => e.blockId), [root.id, left.id, shared.id, right.id, shared.id]);

    const each = createAutomationBlock("for-each"), add = createAutomationBlock("math-variable"), returned = createAutomationBlock("return");
    each.config.input = { kind: "literal", value: [2, 4, 6] };
    each.next = add.id; each.alternate = returned.id;
    add.config = { sourceVariable: "result", variable: "result", amount: 1 }; add.next = each.id;
    returned.config.input = { kind: "reference", value: "result" };
    const loop = workflow(each, add, returned);
    assert.equal(await executeWorkflow(loop, { result: 0 }, environment([loop]).env), 3);
    const inner = createAutomationBlock("repeat"); inner.config.repeatCount = 2;
    each.next = inner.id; inner.next = add.id; inner.alternate = each.id; add.next = inner.id;
    loop.blocks.push(inner);
    assert.equal(await executeWorkflow(loop, { result: 0 }, environment([loop]).env), 6);
    const breakBlock = createAutomationBlock("break-loop");
    inner.next = breakBlock.id; loop.blocks.push(breakBlock);
    assert.equal(await executeWorkflow(loop, { result: 0 }, environment([loop]).env), 0);

    const failure = createAutomationBlock("fail"); failure.error = timeout.id;
    const recovered = workflow(failure, timeout);
    assert.equal(await executeWorkflow(recovered, {}, environment([recovered]).env), "timeout");
    const stopper = createAutomationBlock("stop-run");
    root.next = [stopper.id, right.id];
    const stopped = workflow(root, stopper, right);
    right.next = undefined;
    const stoppedEnv = environment([stopped]);
    await executeWorkflow(stopped, {}, stoppedEnv.env);
    assert.ok(!stoppedEnv.events.some(e => e.blockId === right.id));

    const cyclic = createAutomationBlock("note"); cyclic.next = cyclic.id;
    const endless = { ...workflow(cyclic), maxSteps: 10 };
    await assert.rejects(executeWorkflow(endless, {}, environment([endless]).env), /step limit/);
    const longWait = createAutomationBlock("delay"); longWait.config.durationSeconds = 61; longWait.next = normal.id;
    const limited = { ...workflow(longWait, normal), maxRunMinutes: 1 };
    await assert.rejects(executeWorkflow(limited, {}, environment([limited]).env), /time limit/);
    const cancellation = new AbortController();
    const cancelEnv = environment([waiting]);
    cancelEnv.env.external = async () => { cancellation.abort(new Error("Test cancellation")); return { value: "late" }; };
    await assert.rejects(executeWorkflow(waiting, {}, cancelEnv.env, { signal: cancellation.signal }), /cancellation/);
    assert.ok(!cancelEnv.events.some(e => e.blockId === normal.id));

    const subReturn = createAutomationBlock("return"); subReturn.config.input = { kind: "reference", value: "input" };
    const child = workflow(subReturn);
    const call = createAutomationBlock("call-workflow"); call.config = { workflowId: child.id, variable: "result", input: { kind: "literal", value: { useful: [1, 2] } } };
    const parent = workflow(call);
    assert.deepEqual(await executeWorkflow(parent, {}, environment([parent, child]).env), { useful: [1, 2] });
    const recurse = createAutomationBlock("call-workflow"); recurse.config.workflowId = parent.id; child.blocks = [recurse]; child.entryId = recurse.id;
    await assert.rejects(executeWorkflow(parent, {}, environment([parent, child]).env), /Recursive/);
    child.blocks = [subReturn]; child.entryId = subReturn.id;
    const copies = duplicateWorkflows([parent, child]);
    assert.equal(copies[0].blocks[0].config.workflowId, copies[1].id);
    assert.ok(copies.every(copy => !copy.enabled));

    const write = createAutomationBlock("write-value"); write.config.input = { kind: "literal", value: 5 };
    const read = createAutomationBlock("read-value"); write.next = read.id;
    const persist = workflow(write, read);
    const persistentEnv = environment([persist]);
    assert.equal(await executeWorkflow(persist, {}, persistentEnv.env, { dryRun: true }), 5);
    assert.equal(persistentEnv.values.size, 0);
    await executeWorkflow(persist, {}, persistentEnv.env);
    assert.equal(persistentEnv.values.size, 1);
    assert.throws(() => updateSavedValue("wrong", "increment-value", 1), /finite number/);
    const dry = environment([waiting]);
    await executeWorkflow(waiting, {}, dry.env, { dryRun: true });
    assert.equal(dry.calls.length, 0);
    delete wait.config.sample;
    await assert.rejects(executeWorkflow(waiting, {}, dry.env, { dryRun: true }), /sample result/);

    const queue = createRunQueue(() => {});
    queue.setLimit(2);
    const q = { ...createAutomation(), queueLimit: 1 };
    const order: number[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.enqueue(q, async () => { order.push(1); await gate; });
    const second = queue.enqueue(q, async () => { order.push(2); });
    await assert.rejects(queue.enqueue(q, async () => {}), /full/);
    const other = queue.enqueue(createAutomation(), async () => { order.push(3); });
    await other;
    assert.deepEqual(order, [1, 3], "A waiting workflow must not block another workflow.");
    release?.();
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 3, 2]);
    const skip = { ...q, id: "skip", runMode: "skip" as const };
    let finish: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const skipped = queue.enqueue(skip, async signal => abortable(pending, signal));
    await assert.rejects(queue.enqueue(skip, async () => {}), /skipped/);
    queue.cancel(skip.id);
    await assert.rejects(skipped, /cancelled/);
    finish?.();
    queue.cancel();

    const trigger = { ...createAutomation(), enabled: true, trigger: { type: "message" as const, channelId: "chosen" } };
    const index = compileTriggers([trigger]);
    const event: TriggerEvent = { type: "MESSAGE_CREATE", channelId: "chosen", guildId: "", authorId: "user", content: "hello", self: false, bot: false, mention: false, fromEngine: false };
    assert.equal(matchTriggers(index, event).length, 1);
    assert.equal(matchTriggers(index, { ...event, channelId: "other" }).length, 0);
    assert.equal(matchTriggers(index, { ...event, fromEngine: true }).length, 0);
    assert.equal(matchTriggers(index, { ...event, self: true }).length, 0);
    assert.equal(compileTriggers([{ ...trigger, enabled: false }]).size, 0);

    const legacy = { ...waiting, schemaVersion: undefined };
    assert.equal(migrateWorkflow(legacy).runMode, "skip");
    const file = parseWorkflowFile(createAutomationFile([waiting]));
    assert.equal(file.version, 2);
    assert.equal(file.automations[0].blocks[0].id, wait.id);
    assert.throws(() => parseWorkflowFile({ ...file, automations: [waiting, waiting] }), /unique/);
    const unsupported = migrateWorkflow({ ...waiting, blocks: [{ ...wait, type: "future-block" }] });
    assert.equal(unsupported.blocks[0].type, "unsupported");
    assert.ok(validateWorkflow(unsupported).some(issue => issue.message.includes("unsupported")));
    assert.ok(validateWorkflow({ ...waiting, entryId: "missing" }).some(issue => issue.message.includes("entry")));
    assert.throws(() => readPath({}, "__proto__.polluted"), /not allowed/);
    assert.throws(() => parseWorkflowFile({ ...file, automations: [{ ...waiting, blocks: [{ ...wait, config: { cases: "wrong" } }] }] }), /Switch routes/);
    assert.ok(validateWorkflow(workflow({ ...normal, config: { jsonDrafts: { input: "{" } } })).some(issue => issue.message.includes("invalid JSON")));
    assert.ok(validateWorkflow(workflow({ ...normal, config: { variable: "blocks" } })).some(issue => issue.message.includes("reserved")));
    const isolated = workflow({ ...normal, config: { variable: "result", input: { kind: "reference", value: "input" } } });
    const isolatedEnv = environment([isolated]);
    const parallel = await Promise.all([1, 2, 3].map(input => executeWorkflow(isolated, { input }, isolatedEnv.env)));
    assert.deepEqual(parallel, [1, 2, 3]);
    let queueClock = 0;
    const cooling = createRunQueue(() => {}, () => queueClock);
    const cooled = { ...createAutomation(), cooldownSeconds: 100 };
    await cooling.enqueue(cooled, async () => {});
    const coolWait = cooling.enqueue(cooled, async () => "resumed");
    queueClock = 200_000;
    cooling.cancel("unrelated");
    assert.equal(await Promise.race([coolWait, delay(100, new AbortController().signal).then(() => "stalled")]), "resumed");
    cooling.cancel();
    assert.throws(() => validateResult({ count: "wrong" }, { type: "object", properties: { count: { type: "number" } } }), /must be number/);

    const scheduled = createAutomation();
    scheduled.schedule = { interval: 1, unit: "days", startAt: Date.UTC(2026, 0, 1), mode: "cron", timezone: "Europe/Amsterdam", cron: "30 9 * * 1-5" };
    const occurrences = schedulePreview(scheduled, Date.UTC(2026, 2, 27, 10));
    assert.equal(new Date(occurrences[0]).toISOString(), "2026-03-30T07:30:00.000Z");
    assert.equal(new Date(nextOccurrence(scheduled, Date.UTC(2026, 9, 23, 10))).toISOString(), "2026-10-26T08:30:00.000Z");
    scheduled.schedule.cron = "0 0 29 2 *";
    assert.equal(new Date(nextOccurrence(scheduled, Date.UTC(2026, 0, 1))).getUTCFullYear(), 2028);
    scheduled.schedule.cron = "bad";
    assert.ok(validateSchedule(scheduled.schedule));
    scheduled.schedule.cron = "30 2 * * *";
    assert.equal(new Date(nextOccurrence(scheduled, Date.parse("2026-03-28T23:00:00Z"))).toISOString(), "2026-03-29T01:30:00.000Z");
    assert.deepEqual(schedulePreview(scheduled, Date.parse("2026-10-24T22:00:00Z")).slice(0, 2).map(time => new Date(time).toISOString()), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    scheduled.schedule.mode = "calendar";
    scheduled.schedule.time = "09:00";
    scheduled.schedule.weekdays = [1];
    assert.equal(new Date(nextOccurrence(scheduled, Date.parse("2026-08-31T08:00:00Z"))).toISOString(), "2026-09-07T07:00:00.000Z");

    const initial = { workflow: waiting, past: [], future: [] };
    const edited = editorReducer(initial, { type: "edit", workflow: { ...waiting, name: "Changed" } });
    assert.equal(editorReducer(edited, { type: "undo" }).workflow.name, waiting.name);
    assert.equal(editorReducer(editorReducer(edited, { type: "undo" }), { type: "redo" }).workflow.name, "Changed");
    const duplicated = duplicateBlocks(waiting, new Set(waiting.blocks.map(block => block.id)));
    assert.equal(duplicated.workflow.blocks.length, waiting.blocks.length * 2);
    assert.equal(removeBlocks(duplicated.workflow, duplicated.ids).blocks.length, waiting.blocks.length);
    const controller = new AbortController();
    const sleeping = delay(60_000, controller.signal);
    controller.abort();
    await assert.rejects(sleeping);
    console.log("Automation runtime, queues, migration, scheduling, inputs, and editor checks passed.");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
