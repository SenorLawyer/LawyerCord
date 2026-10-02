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
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("MessageLogger reuses unchanged mounted edit diffs as history grows", context => {
    context.mock.method(Date, "now", () => 0);
    const source = readFileSync("src/plugins/messageLogger/index.tsx", "utf8");
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
    const fn = parsed.statements.find(statement => isFunctionDeclaration(statement) && ["EditContent", "parseEditContent"].includes(statement.name?.text ?? ""));
    assert.ok(fn && isFunctionDeclaration(fn));
    const compile = (value: string) => transpileModule(value, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const diff = runInNewContext(compile(readFileSync("src/plugins/messageLogger/diffUtils.ts", "utf8")) + ";exports.createMessageDiff", { exports: {}, require: () => ({ diffArrays }) });
    let computations = 0;
    let row = 0;
    const memo = new Map<number, { deps: unknown[]; value: unknown }>();
    const settings = { store: { showEditDiffs: true, separatedDiffs: false } };
    const api = runInNewContext(compile(fn.getText(parsed)) + ";exports", {
        exports: {}, settings, disabledDiffMessages: new Set(),
        useMemo: (factory: () => unknown, deps: unknown[]) => {
            const previous = memo.get(row);
            if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return previous.value;
            const value = factory();
            memo.set(row, { deps, value });
            return value;
        },
        createMessageDiff: (before: string, after: string) => { computations++; return diff(before, after); },
        buildViewSegments: () => [], renderDiffParts: (parts: unknown) => parts,
        Parser: { parse: (content: string) => content }, SelectedChannelStore: { getChannelId: () => "channel" }
    });
    const render = (content: string, next: string) => {
        const message = { id: "message", channel_id: "channel", content: next };
        return api.EditContent ? api.EditContent({ content, previousContent: next, message }) : api.parseEditContent(content, message, next);
    };
    for (let length = 1; length <= 100; length++) {
        for (row = 0; row < length; row++) {
            const before = `Message revision ${row}`;
            const after = `Message revision ${row + 1}`;
            assert.deepEqual(JSON.parse(JSON.stringify(render(before, after))), JSON.parse(JSON.stringify(diff(before, after))));
        }
    }
    assert.equal(computations, 100);
    row = 0;
    render("Changed first revision", "Message revision 1");
    assert.equal(computations, 101);
    settings.store.showEditDiffs = false;
    assert.equal(render("Unhighlighted", "Message revision 1"), "Unhighlighted");
    assert.equal(computations, 101);
    memo.clear();
    settings.store.showEditDiffs = true;
    render("Changed first revision", "Message revision 1");
    assert.equal(computations, 102);
});
