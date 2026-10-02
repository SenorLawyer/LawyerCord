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

import type { AutomationBlock } from "../src/components/settings/tabs/automations/model";

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
