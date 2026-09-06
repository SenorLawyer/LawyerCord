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

const { outputText } = transpileModule(readFileSync("src/utils/web.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

test("file selection and cancellation both settle and remove the input", async () => {
    for (const selected of [new File(["content"], "test.txt"), null]) {
        let removed = false;
        const input = {
            style: {}, files: selected ? [selected] : [],
            onchange: undefined as (() => void) | undefined,
            oncancel: undefined as (() => void) | undefined,
            click() { queueMicrotask(() => selected ? this.onchange?.() : this.oncancel?.()); },
            remove() { removed = true; }
        };
        const { chooseFile } = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, setImmediate,
            document: {
                createElement: () => input,
                body: { appendChild() { }, removeChild() { removed = true; } }
            }
        });
        const pending = chooseFile("text/plain");
        let settled = false;
        pending.then(() => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, true, "cancelled pickers must resolve instead of leaving callers pending");
        assert.equal(await pending, selected);
        assert.equal(removed, true);
    }
});
