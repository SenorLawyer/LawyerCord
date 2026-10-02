/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { diffArrays } from "diff";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Part { type: "added" | "removed" | "unchanged"; text: string; }

function fixture() {
    let copiedCharacters = 0;
    let searches = 0;
    const source = readFileSync(process.env.AUDIT_MESSAGE_DIFF_SOURCE ?? "src/plugins/messageLogger/diffUtils.ts", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    class InstrumentedArray extends Array {
        static from(value: string) {
            copiedCharacters += value.length;
            return Array.from(value);
        }
    }
    const api = runInNewContext(`${outputText}\nexports;`, { exports: {}, Array: InstrumentedArray,
        require(name: string) {
            assert.equal(name, "diff");
            return { diffArrays(before: string[], after: string[], options: { maxEditLength: number; timeout: number; }) {
                searches++;
                assert.equal(options.maxEditLength, 256);
                assert.equal(options.timeout, 20);
                return diffArrays(before, after, options);
            } };
        } }) as { createWordDiff(before: string, after: string): Part[]; };
    return { diff: api.createWordDiff, counts: () => ({ copiedCharacters, searches }) };
}

function reconstruct(parts: Part[], type: "added" | "removed") {
    return parts.filter(part => part.type !== type).map(part => part.text).join("");
}

test("Message diffs preserve both versions and keep Discord markup and Unicode tokens intact", () => {
    const { diff } = fixture();
    const texts = ["", "a", "aba", "bab", "😀x\n", "x😀", "\ud800x", "<@123>", "<@!123>", "<@&123>", "<#123>", "<:old:123>", "<a:new:456>", "<:unterminated", "<:😀:123>"];
    for (const before of texts) for (const after of texts) {
        const parts = diff(before, after);
        assert.equal(reconstruct(parts, "added"), before);
        assert.equal(reconstruct(parts, "removed"), after);
        for (const text of [before, after]) {
            if (!text.startsWith("<") || !text.endsWith(">")) continue;
            assert.ok(parts.some(part => part.text.includes(text)));
        }
        for (let i = 1; i < parts.length; i++) assert.notEqual(parts[i].type, parts[i - 1].type);
    }
});

test("Message tokenization does not copy the remaining string for every character", () => {
    const f = fixture();
    const before = "a".repeat(500) + "X";
    const after = "a".repeat(500) + "Y";
    const parts = f.diff(before, after);
    assert.equal(reconstruct(parts, "added"), before);
    assert.equal(reconstruct(parts, "removed"), after);
    assert.ok(f.counts().copiedCharacters <= before.length + after.length);
});

test("Large replacements use a bounded search and oversized records bypass it without losing text", () => {
    const f = fixture();
    const before = "a".repeat(1000);
    const after = "b".repeat(1000);
    const parts = f.diff(before, after);
    assert.equal(reconstruct(parts, "added"), before);
    assert.equal(reconstruct(parts, "removed"), after);
    assert.equal(parts.length, 2);
    assert.equal(f.counts().searches, 1);
    const largeBefore = before.repeat(10);
    const largeAfter = after.repeat(10);
    const largeParts = f.diff(largeBefore, largeAfter);
    assert.equal(reconstruct(largeParts, "added"), largeBefore);
    assert.equal(reconstruct(largeParts, "removed"), largeAfter);
    assert.equal(f.counts().searches, 1);
});
