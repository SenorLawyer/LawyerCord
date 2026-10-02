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

test("ZIP preview limits pending archive downloads and cancels them when clearing the session", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/zipPreview/utils.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    let downloads = 0;
    const signals: AbortSignal[] = [];
    const api = runInNewContext(`${source};exports`, {
        exports: {}, VencordNative: undefined, URL, AbortController, AbortSignal: {}, setTimeout, clearTimeout,
        require: () => ({}), fetch: (_url: string, options: { signal: AbortSignal; }) => {
            downloads++;
            signals.push(options.signal);
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
        }
    });
    const jobs = Array.from({ length: 100 }, (_, index) => api.getCachedZip(`https://fixture.invalid/${index}.zip`));
    const pending = jobs.filter(job => job.status === "pending").map(job => job.promise.catch(() => {}));
    assert.equal(downloads, 2);
    assert.equal(jobs.filter(job => job.status === "rejected").length, 98);
    api.clearZipPreviewCache();
    assert.ok(signals.every(signal => signal.aborted));
    await Promise.all(pending);
});


for (const failure of ["HTTP error", "oversized response"]) {
    test(`ZIP ${failure} retains download slots until body cancellation settles`, async () => {
        const source = transpileModule(readFileSync("src/equicordplugins/zipPreview/utils.ts", "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        const cancellations: Array<() => void> = [];
        let downloads = 0;
        const api = runInNewContext(`${source};exports`, {
            exports: {}, VencordNative: undefined, URL, AbortController, setTimeout, clearTimeout,
            require: () => ({ MAX_ZIP_BYTES: 25 * 1024 * 1024 }), fetch: async () => {
                downloads++;
                return new Response(new ReadableStream({
                    cancel: () => new Promise<void>(resolve => cancellations.push(resolve))
                }), failure === "HTTP error" ? { status: 503 } : { headers: { "content-length": "1000000000000" } });
            }
        });
        const pending: Promise<unknown>[] = [];
        try {
            for (let i = 0; i < 2; i++) pending.push(api.getCachedZip(`https://fixture.invalid/${i}.zip`).promise.catch(() => undefined));
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(cancellations.length, 2);
            const excess = api.getCachedZip("https://fixture.invalid/excess.zip");
            if (excess.status === "pending") pending.push(excess.promise.catch(() => undefined));
            assert.equal(excess.status, "rejected");
            assert.equal(downloads, 2);
            for (const finish of cancellations) finish();
            await Promise.all(pending);
            const retry = api.getCachedZip("https://fixture.invalid/retry.zip");
            assert.equal(retry.status, "pending");
            pending.push(retry.promise.catch(() => undefined));
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(downloads, 3);
        } finally {
            await new Promise<void>(resolve => setImmediate(resolve));
            for (const finish of cancellations) finish();
            await Promise.all(pending);
            api.clearZipPreviewCache();
        }
    });
}
