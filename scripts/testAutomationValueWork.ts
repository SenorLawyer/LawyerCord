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

import { type AutomationBlock, createAutomation, createAutomationBlock } from "../src/components/settings/tabs/automations/model";

import { executeWorkflow, type RunEvent } from "../src/components/settings/tabs/automations/runtime";

function fixture() {
    let patterns = 0;
    class CountedRegExp extends RegExp { constructor(pattern: string, flags?: string) { super(pattern, flags); patterns++; } }
    const source = readFileSync(process.env.AUDIT_VALUES_SOURCE ?? "src/components/settings/tabs/automations/values.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const exports: { executeValue?: (block: AutomationBlock, variables: Record<string, unknown>, now: number, random: () => number) => unknown; } = {};
    runInNewContext(code, { exports, structuredClone, RegExp: CountedRegExp, require(name: string) {
        if (name === "./regex") return { async evaluateRegex(pattern: string, texts: string[]) { const regex = new CountedRegExp(pattern, "i"); return { matches: texts.map(text => regex.test(text)) }; } };
        return { isRecord: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) };
    } });
    assert.ok(exports.executeValue);
    const execute = exports.executeValue;
    return { patterns: () => patterns, run(type: AutomationBlock["type"], config: AutomationBlock["config"], variables: Record<string, unknown>) {
        return execute({ id: "value", type, config }, variables, 123, () => 0.5);
    } };
}

test("Array filters expand the comparison once and compile one regex per block", async () => {
    const f = fixture();
    let reads = 0;
    const variables = { items: Array.from({ length: 1000 }, (_, i) => ({ content: i % 2 ? "no" : "yes" })), get pattern() { reads++; return "^yes$"; } };
    const result = await f.run("filter-array", { sourceVariable: "items", fieldPath: "content", compareValue: "{{pattern}}", operator: "regex" }, variables) as unknown[];
    assert.equal(result.length, 500);
    assert.equal(reads, 1);
    assert.equal(f.patterns(), 1);
    assert.equal(variables.items.length, 1000);
});

test("Value operations do not expand an unused value template", () => {
    const f = fixture();
    let reads = 0;
    const variables = { items: [1, 2, 3], get unused() { reads++; return "unused"; } };
    assert.equal(f.run("array-length", { sourceVariable: "items", value: "{{unused}}" }, variables), 3);
    assert.equal(reads, 0);
    assert.equal(f.run("set-variable", { value: "Count {{items.length}}" }, variables), "Count 3");
    assert.equal(f.run("text-variable", { sourceVariable: "items.length", operation: "append", value: " items" }, variables), "3 items");
});

test("Filters preserve ordering, operators, empty inputs and invalid-pattern behavior", async () => {
    const f = fixture();
    const items = [1, 2, 3, 2];
    for (const [operator, compareValue, expected] of [
        ["equals", "2", [2, 2]], ["not-equals", "2", [1, 3]], ["greater", "2", [3]],
        ["less", "2", [1]], ["contains", "2", [2, 2]], ["regex", "^[12]$", [1, 2, 2]]
    ] as const) {
        const result = await f.run("filter-array", { sourceVariable: "items", operator, compareValue }, { items }) as number[];
        assert.deepEqual(Array.from(result), expected);
    }
    assert.deepEqual(Array.from(f.run("filter-array", { sourceVariable: "items", operator: "regex", compareValue: "[" }, { items: [] }) as unknown[]), []);
    await assert.rejects(Promise.resolve(f.run("filter-array", { sourceVariable: "items", operator: "regex", compareValue: "[" }, { items })));
    assert.throws(() => f.run("filter-array", { sourceVariable: "items" }, { items: "invalid" }));
    assert.deepEqual(items, [1, 2, 3, 2]);
});


async function previewRun(value: unknown, count: boolean | "log" | "template" = false) {
    const fetch = createAutomationBlock("fetch-messages");
    fetch.config = { channelId: "100000000000000001", variable: "result" };
    const length = createAutomationBlock(count === "log" ? "log" : "array-length");
    length.config = count === "log" ? { content: "{{result}} ignored {{result}}" }
        : count === "template" ? { input: { kind: "template", value: "{{result}}" }, variable: "result" }
            : { sourceVariable: "result", variable: "result" };
    if (count) fetch.next = length.id;
    const workflow = { ...createAutomation(), blocks: count ? [fetch, length] : [fetch], entryId: fetch.id };
    const events: RunEvent[] = [];
    const result = await executeWorkflow(workflow, {}, {
        now: Date.now, random: Math.random, delay: async () => {},
        external: async () => ({ value }), persistent: async () => undefined,
        workflows: () => [workflow], trace: event => events.push(event)
    });
    return { result, events };
}

test("Runtime previews stop traversing message lists when the displayed prefix is full", async () => {
    let reads = 0;
    const messages = Array.from({ length: 100 }, (_, id) => ({ id, get content() { reads++; return "x".repeat(2000); } }));
    const { result, events } = await previewRun(messages, true);
    assert.equal(result, 100);
    assert.ok(reads <= 2, `Read ${reads} message bodies for two limited previews.`);
    assert.ok(events.every(event => (event.preview?.length ?? 0) <= 2000 && (event.inputPreview?.length ?? 0) <= 2000));
});

test("Diagnostic previews preserve ordinary JSON and do not change workflow values", async () => {
    for (const value of ["plain text", { text: "quoted \" newline\n", items: [1, true, null] }, [1, { nested: "value" }], new Date("2026-01-01T00:00:00Z")]) {
        const { result, events } = await previewRun(value);
        assert.equal(result, value);
        assert.equal(events.at(-1)?.preview, typeof value === "string" ? value : JSON.stringify(value));
    }
});


test("Log templates stop expanding later references once the diagnostic prefix is full", async () => {
    let reads = 0;
    const value = { get content() { reads++; return "x".repeat(100000); } };
    const { result, events } = await previewRun(value, "log");
    assert.equal(result, value);
    assert.equal(reads, 2);
    assert.equal(events.at(-1)?.preview?.length, 2000);
});


test("Previewing literal inputs does not duplicate their execution clone", async () => {
    const block = createAutomationBlock("array-length");
    block.config = { input: { kind: "literal", value: Array.from({ length: 100 }, () => "x".repeat(2000)) }, variable: "result" };
    const flow = { ...createAutomation(), blocks: [block], entryId: block.id };
    const clone = globalThis.structuredClone;
    let listClones = 0;
    globalThis.structuredClone = value => { if (Array.isArray(value)) listClones++; return clone(value); };
    try {
        assert.equal(await executeWorkflow(flow, {}, {
            now: Date.now, random: Math.random, delay: async () => {}, external: async () => ({}),
            persistent: async () => undefined, workflows: () => [flow], trace() {}
        }), 100);
        assert.equal(listClones, 1);
    } finally { globalThis.structuredClone = clone; }
});

test("Diagnostic object traversal also bounds omitted properties", async () => {
    let reads = 0;
    const value = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [index, undefined]));
    for (const key in value) Object.defineProperty(value, key, { enumerable: true, get() { reads++; return undefined; } });
    const { result } = await previewRun(value);
    assert.equal(result, value);
    assert.ok(reads <= 2000);
});


test("Input templates expand completely for execution but only a prefix for diagnostics", async () => {
    let reads = 0;
    const messages = Array.from({ length: 100 }, () => ({ get content() { reads++; return "x".repeat(2000); } }));
    const { result, events } = await previewRun(messages, "template");
    assert.equal(result, 201501);
    assert.equal(reads, 102);
    assert.equal(events.find(event => event.inputPreview)?.inputPreview?.length, 2000);
});
