/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function compile(path: string) {
    return transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
}

test("Replacing a quote cancels its pending emoji download without starting fallback or canvas work", async () => {
    let requests = 0;
    let canvasWork = 0;
    const types = runInNewContext(`${compile("src/equicordplugins/quoter/types.ts")};exports`, { exports: {} });
    const api = runInNewContext(`${compile("src/equicordplugins/quoter/utils.tsx")};exports`, {
        exports: {}, require: (name: string) => name === "./types" ? types : { IconUtils: { getEmojiURL: () => "https://example.com/emoji" } },
        document: { getElementById: () => ({}), createElement: () => { canvasWork++; throw Error("Unexpected canvas work"); } },
        fetch: (_url: string, options?: { signal?: AbortSignal }) => { requests++; return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(Error("Cancelled")), { once: true })); }
    });
    const controller = new AbortController();
    const job = api.createQuoteImage({ quote: "<a:test:123>", signal: controller.signal });
    await setImmediate();
    controller.abort();
    const settled = await Promise.race([job.then(() => false, () => true), new Promise(resolve => setTimeout(() => resolve(false), 30))]);
    assert.equal(settled, true);
    assert.equal(requests, 1);
    assert.equal(canvasWork, 0);
});
