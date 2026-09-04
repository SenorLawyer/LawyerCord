/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    acceptsReply,
    conditionLeftTemplate,
    addEdgeTarget,
    edgeTargets,
    removeEdgeTarget,
    duplicateAutomation,
    addScheduleInterval,
    cloneAutomation,
    createAutomation,
    createAutomationBlock,
    createAutomationFile,
    findEndRepeat,
    findIfBoundary,
    findStartRepeat,
    formatSchedule,
    getAutomationVariableNames,
    getNextRunAt,
    graphEntry,
    outputPorts,
    portLabel,
    inheritedContext,
    migrateToGraph,
    parseAutomationFile,
    parseComponents,
} from "../src/components/settings/tabs/automations/model";

const now = Date.now();
const twoHours = 2 * 60 * 60 * 1000;
const hourly = { interval: 2, unit: "hours" as const, startAt: now - twoHours };

assert.equal(formatSchedule(hourly), "Every 2 hours");
assert.equal(getNextRunAt(hourly, now), now + twoHours);

const januaryThirtyFirst = new Date(2026, 0, 31, 12).getTime();
const februaryTwentyEighth = new Date(2026, 1, 28, 12).getTime();
assert.equal(addScheduleInterval(januaryThirtyFirst, "months", 1), februaryTwentyEighth);

const validComponents = parseComponents('[{"type":1,"components":[{"type":2,"label":"Go","custom_id":"go"}]}]');
assert.equal(validComponents.error, undefined);
assert.equal(validComponents.components[0].components?.[0].custom_id, "go");
assert.ok(parseComponents("not json").error);

const automation = createAutomation();
assert.equal(automation.trigger.type, "schedule");
const components = createAutomationBlock("send-components");
components.config.components?.push({ type: 10, content: "Original" });
automation.blocks = [components, createAutomationBlock("condition"), createAutomationBlock("wait-reply")];
const clone = cloneAutomation(automation);
clone.trigger.type = "mention";
assert.equal(automation.trigger.type, "schedule");
if (clone.blocks[0].config.components?.[1]) clone.blocks[0].config.components[1].content = "Changed";
assert.equal(automation.blocks[0].config.components?.[1].content, "Original");
assert.equal(automation.blocks[1].config.operator, "equals");
const parsed = parseAutomationFile(createAutomationFile([automation]));
assert.equal(parsed.automations.length, 1);
assert.equal(parsed.automations[0].blocks.length, 3);
assert.equal(parsed.format, "lawyercord-automation");

const variables = createAutomation();
variables.blocks = [createAutomationBlock("wait-reply"), createAutomationBlock("set-variable"), createAutomationBlock("delete-variable")];
variables.blocks[1].config.variable = "ticket";
variables.blocks[2].config.sourceVariable = "ticket";
assert.deepEqual(getAutomationVariableNames(variables, variables.blocks[2].id), ["reply", "replyUserId", "lastMessage", "lastMessage.id", "lastMessage.channel_id", "lastMessage.author.id", "lastMessage.content", "reply.id", "reply.channel_id", "reply.author.id", "reply.content", "ticket"]);
assert.ok(!getAutomationVariableNames(variables).includes("ticket"));

const live = createAutomation();
live.trigger = { type: "mention" };
live.blocks = [createAutomationBlock("fetch-mentions"), createAutomationBlock("ai-summarize"), createAutomationBlock("send-dm")];
assert.ok(getAutomationVariableNames(live).includes("triggerMessage.content"));
assert.equal(live.blocks[0].config.variable, "mentions");
assert.equal(live.blocks[1].config.sourceVariable, "messages");

const flow = [
    createAutomationBlock("condition"),
    createAutomationBlock("repeat"),
    createAutomationBlock("end-repeat"),
    createAutomationBlock("else"),
    createAutomationBlock("end-if"),
];
assert.deepEqual(findIfBoundary(flow, 0), { elseIndex: 3, endIndex: 4 });
assert.equal(findEndRepeat(flow, 1), 2);
assert.equal(findStartRepeat(flow, 2), 1);

console.log("automation schedule, component parser, and import/export checks passed");

const linear = ["send-message", "condition", "send-dm", "else", "delay", "end-if", "log"].map(type => createAutomationBlock(type as never));
const graph = migrateToGraph(linear);
const at = (index: number) => graph.find(block => block.id === linear[index].id);

assert.deepEqual(graph.map(block => block.type), ["send-message", "condition", "send-dm", "delay", "log"], "markers become edges");
assert.equal(at(0)?.next, linear[1].id, "the first block flows into the condition");
assert.equal(at(1)?.next, linear[2].id, "the true branch is the then block");
assert.equal(at(1)?.alternate, linear[4].id, "the false branch is the else block");
assert.equal(at(2)?.next, linear[6].id, "both branches rejoin after end-if");
assert.equal(at(4)?.next, linear[6].id, "both branches rejoin after end-if");
assert.equal(at(6)?.next, undefined, "the last block ends the run");
assert.equal(graphEntry(graph)?.id, linear[0].id, "the entry is the block nothing points at");
assert.ok(graph.every(block => block.position), "migration lays every node out");
assert.equal(migrateToGraph(graph), graph, "migrating an existing graph is a no-op");

const loop = ["repeat", "send-message", "end-repeat", "stop"].map(type => createAutomationBlock(type as never));
const looped = migrateToGraph(loop);
const repeat = looped.find(block => block.type === "repeat");
const body = looped.find(block => block.type === "send-message");
assert.equal(repeat?.next, body?.id, "a repeat enters its body");
assert.equal(body?.next, repeat?.id, "the body loops back to the repeat");
assert.equal(repeat?.alternate, looped.find(block => block.type === "stop")?.id, "the repeat exits to what follows it");

console.log("graph migration checks passed");

const chain = migrateToGraph(["send-message", "wait-reply"].map(type => createAutomationBlock(type as never)));
chain[0].config.channelId = "123456789012345678";
const inherited = inheritedContext(chain, chain[1].id);
assert.equal(inherited.channelId, "123456789012345678", "a downstream block inherits the upstream channel");
assert.equal(inherited.channelFrom?.id, chain[0].id, "and knows which block it came from");
assert.equal(inherited.messageVariable, "lastMessage", "and which variable holds the upstream message");
assert.deepEqual(inheritedContext(chain, chain[0].id), {}, "the first block inherits nothing");

const graphVars = getAutomationVariableNames(
    { ...createAutomation(), blocks: chain },
    chain[1].id
);
assert.ok(graphVars.includes("lastMessage"), "variables follow the edges once blocks are connected");

console.log("context inheritance checks passed");

// Waiting is a branch: something arrived, or the wait ran out.
assert.deepEqual(outputPorts("wait-reply"), ["next", "alternate"], "a wait has a timeout branch");
assert.equal(portLabel("wait-reply", "alternate"), "Timed out");
assert.equal(portLabel("repeat", "alternate"), "When done");
assert.equal(portLabel("send-message", "next"), "Next");
assert.deepEqual(outputPorts("stop"), [], "stop ends the run");
assert.equal(createAutomationBlock("wait-reply").config.requireReply, true, "waiting requires a real reply by default");
assert.equal(createAutomation().maxRunMinutes, 15, "runs have a time budget by default");

console.log("wait branch checks passed");

// The bug that made a reply to somebody else trigger the flow.
const sent = "111111111111111111";
const filter = { channelId: "chan", selfId: "me", awaitedMessageId: sent };
const reply = (over: Partial<{ channelId: string; authorId: string; referencedId: string; }>) =>
    ({ channelId: "chan", authorId: "them", ...over });

assert.equal(acceptsReply(filter, reply({ referencedId: sent })), true, "a real reply to our message counts");
assert.equal(acceptsReply(filter, reply({ referencedId: "999" })), false, "a reply to someone else does not");
assert.equal(acceptsReply(filter, reply({})), false, "a plain message in the channel does not");
assert.equal(acceptsReply(filter, reply({ authorId: "me", referencedId: sent })), false, "our own message never counts");
assert.equal(acceptsReply(filter, reply({ channelId: "other", referencedId: sent })), false, "another channel does not");
assert.equal(acceptsReply({ channelId: "chan", selfId: "me" }, reply({})), true, "without a target, any message counts");
assert.equal(acceptsReply({ channelId: "chan", authorId: "them" }, reply({ authorId: "other" })), false, "the author filter still applies");

console.log("reply matching checks passed");

// The AI must read the message the block is already acting on, without extra wiring.
const aiInputFor = (config: { aiInput?: string; sourceVariable?: string; }) =>
    config.aiInput?.trim() || config.sourceVariable?.trim() || "lastMessage";

assert.equal(aiInputFor({ sourceVariable: "reply" }), "reply", "a reply block feeds the AI the reply it answers");
assert.equal(aiInputFor({ aiInput: "messages", sourceVariable: "reply" }), "messages", "an explicit choice wins");
assert.equal(aiInputFor({}), "lastMessage", "otherwise the last message the flow touched");
assert.equal(aiInputFor({ aiInput: "  " , sourceVariable: "reply" }), "reply", "blank does not count as a choice");

console.log("inline AI input checks passed");

// The message handler runs for every message in every channel, so the bail-out must be right.
const liveTriggers = ["mention", "message", "dm"];
const wantsMessages = (list: { enabled: boolean; trigger: { type: string; }; }[]) =>
    list.some(a => a.enabled && liveTriggers.includes(a.trigger.type));

assert.equal(wantsMessages([]), false, "no automations means no per-message work");
assert.equal(wantsMessages([{ enabled: false, trigger: { type: "message" } }]), false, "a disabled automation costs nothing");
assert.equal(wantsMessages([{ enabled: true, trigger: { type: "schedule" } }]), false, "a scheduled automation never inspects messages");
assert.equal(wantsMessages([{ enabled: true, trigger: { type: "startup" } }]), false, "neither does a startup one");
assert.equal(wantsMessages([{ enabled: true, trigger: { type: "mention" } }]), true, "a mention trigger does");
assert.equal(wantsMessages([
    { enabled: true, trigger: { type: "schedule" } },
    { enabled: true, trigger: { type: "dm" } },
]), true, "one live trigger among many is enough");

console.log("trigger bail-out checks passed");

// A condition must accept a bare variable and a written-out template alike.
assert.equal(conditionLeftTemplate("postReply.content"), "{{postReply.content}}", "a bare name is wrapped");
assert.equal(conditionLeftTemplate("{{postReply.content}}"), "{{postReply.content}}", "a template is left alone, not double wrapped");
assert.equal(conditionLeftTemplate("  reply.content  "), "{{reply.content}}", "whitespace does not break it");
assert.equal(conditionLeftTemplate("Sent {{a}} and {{b}}"), "Sent {{a}} and {{b}}", "a mixed template is left alone");
assert.equal(conditionLeftTemplate("", "literal text"), "literal text", "a literal value is used when no variable is named");
assert.equal(conditionLeftTemplate("", ""), null, "naming nothing falls back to the last message");
assert.equal(conditionLeftTemplate(undefined, undefined), null, "so does leaving both unset");

console.log("condition input checks passed");

// The client should carry no automation listener at all unless something reacts to messages.
const liveTriggerTypes = ["mention", "message", "dm"];
const shouldSubscribe = (running: boolean, list: { enabled: boolean; trigger: { type: string; }; }[]) =>
    running && list.some(a => a.enabled && liveTriggerTypes.includes(a.trigger.type));

assert.equal(shouldSubscribe(true, []), false, "an idle engine hooks nothing");
assert.equal(shouldSubscribe(true, [{ enabled: true, trigger: { type: "schedule" } }]), false, "a scheduled automation hooks nothing");
assert.equal(shouldSubscribe(true, [{ enabled: false, trigger: { type: "message" } }]), false, "a disabled one hooks nothing");
assert.equal(shouldSubscribe(true, [{ enabled: true, trigger: { type: "message" } }]), true, "an enabled message trigger hooks in");
assert.equal(shouldSubscribe(false, [{ enabled: true, trigger: { type: "message" } }]), false, "a stopped engine hooks nothing");

console.log("subscription lifecycle checks passed");

// Duplicating must produce a standalone copy, never one wired back into the original.
const source = { ...createAutomation(), name: "repost auto", enabled: true, lastStatus: "success" as const };
source.blocks = migrateToGraph(["send-message", "condition", "send-dm", "else", "delay", "end-if"].map(t => createAutomationBlock(t as never)));
const copy = duplicateAutomation(source);
const sourceIds = new Set(source.blocks.map(b => b.id));

assert.notEqual(copy.id, source.id, "the copy is its own automation");
assert.equal(copy.name, "repost auto copy");
assert.equal(copy.enabled, false, "a copy never starts enabled");
assert.equal(copy.lastStatus, undefined, "and carries no run history");
assert.equal(copy.blocks.length, source.blocks.length);
assert.ok(copy.blocks.every(b => !sourceIds.has(b.id)), "every block gets a fresh id");

const copyIds = new Set(copy.blocks.map(b => b.id));
for (const block of copy.blocks) {
    for (const t of edgeTargets(block.next)) assert.ok(copyIds.has(t), "next points inside the copy");
    for (const t of edgeTargets(block.alternate)) assert.ok(copyIds.has(t), "alternate points inside the copy");
}
const branch = copy.blocks.find(b => b.type === "condition");
assert.ok(branch?.next && branch.alternate, "branch wiring survives duplication");
assert.equal(duplicateAutomation(source, "custom").name, "custom", "an explicit name wins");

console.log("duplicate automation checks passed");

// Import hands out fresh block ids. Forgetting to remap the edges silently orphans the graph.
const shared = { ...createAutomation(), name: "shared" };
shared.blocks = migrateToGraph(["send-message", "wait-reply", "condition", "send-dm", "else", "delay", "end-if"].map(t => createAutomationBlock(t as never)));
const importedCopy = duplicateAutomation(shared, `${shared.name} (imported)`);
const importedIds = new Set(importedCopy.blocks.map(b => b.id));

assert.equal(importedCopy.name, "shared (imported)");
const edgeCount = importedCopy.blocks.reduce((n, b) => n + (b.next ? 1 : 0) + (b.alternate ? 1 : 0), 0);
assert.ok(edgeCount >= 4, "the imported copy still has its edges");
for (const b of importedCopy.blocks) {
    for (const t of edgeTargets(b.next)) assert.ok(importedIds.has(t), `${b.type}.next survived the import`);
    for (const t of edgeTargets(b.alternate)) assert.ok(importedIds.has(t), `${b.type}.alternate survived the import`);
}

// And every block must still be reachable from the entry, not just referenced.
const seen = new Set<string>();
const visit = (id?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const b = importedCopy.blocks.find(x => x.id === id);
    edgeTargets(b?.next).forEach(visit);
    edgeTargets(b?.alternate).forEach(visit);
};
visit(graphEntry(importedCopy.blocks)?.id);
assert.equal(seen.size, importedCopy.blocks.length, "no block is orphaned by importing");

console.log("import edge remapping checks passed");

// A port can feed several blocks. The helpers keep one target a plain string for smaller files.
assert.deepEqual(edgeTargets(undefined), [], "nothing points nowhere");
assert.deepEqual(edgeTargets("a"), ["a"], "a single target reads as one");
assert.deepEqual(edgeTargets(["a", "b"]), ["a", "b"]);

assert.equal(addEdgeTarget(undefined, "a"), "a", "the first target stays a plain string");
assert.deepEqual(addEdgeTarget("a", "b"), ["a", "b"], "a second target makes it a list");
assert.equal(addEdgeTarget("a", "a"), "a", "adding the same target twice changes nothing");
assert.deepEqual(addEdgeTarget(["a", "b"], "b"), ["a", "b"], "and that holds for lists too");

assert.equal(removeEdgeTarget(["a", "b"], "a"), "b", "dropping to one target collapses back to a string");
assert.equal(removeEdgeTarget("a", "a"), undefined, "removing the only target clears the port");
assert.equal(removeEdgeTarget("a", "b"), "a", "removing an unrelated target is a no-op");

// The runner walks a fan-out depth first, finishing one branch before starting the next.
const order: string[] = [];
const fan: Record<string, { next?: string | string[]; }> = {
    root: { next: ["left", "right"] },
    left: { next: "leftEnd" },
    leftEnd: {},
    right: {},
};
const stack = ["root"];
for (let guard = 0; stack.length && guard < 20; guard++) {
    const id = stack.shift()!;
    order.push(id);
    stack.unshift(...edgeTargets(fan[id]?.next));
}
assert.deepEqual(order, ["root", "left", "leftEnd", "right"], "the first branch finishes before the second starts");

console.log("fan-out edge checks passed");

// Your own messages are ignored unless a trigger opts in, and the engine's own output never counts.
const selfId = "me";
const shouldFire = (
    trigger: { type: string; includeSelf?: boolean; },
    authorId: string,
    messageId: string,
    postedByEngine: Set<string>,
) => {
    if (postedByEngine.has(messageId)) return false;
    if (!["mention", "message", "dm"].includes(trigger.type)) return false;
    if (authorId === selfId && trigger.includeSelf !== true) return false;
    return true;
};

const engineSent = new Set(["engine-1"]);
assert.equal(shouldFire({ type: "message" }, "someone", "m1", engineSent), true, "other people fire a message trigger");
assert.equal(shouldFire({ type: "message" }, selfId, "m2", engineSent), false, "your own messages are ignored by default");
assert.equal(shouldFire({ type: "message", includeSelf: true }, selfId, "m3", engineSent), true, "unless the trigger opts in");
assert.equal(shouldFire({ type: "message", includeSelf: true }, selfId, "engine-1", engineSent), false, "but never the automation's own output");
assert.equal(shouldFire({ type: "schedule" }, "someone", "m4", engineSent), false, "a scheduled automation ignores messages");

console.log("self-trigger checks passed");
