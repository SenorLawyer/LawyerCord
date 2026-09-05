/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { LoadedZipEntry, ZipEntry, ZipPreviewResult } from "../src/equicordplugins/zipPreview/utils";

function fixture() {
    const operations: ReturnType<typeof Promise.withResolvers<Uint8Array>>[] = [];
    const api = {} as {
        parseZipBuffer(buffer: ArrayBuffer): ZipPreviewResult;
        loadZipEntry(entry: ZipEntry): Promise<LoadedZipEntry>;
        clearZipPreviewCache(): void;
    };
    const mocks: Record<string, object> = {
        "@utils/web": {},
        "./archive": {
            inspectZipArchive: () => ({ entries: Array.from({ length: 7 }, (_, i) => ({ path: `${i}.txt`, uncompressedSize: 1 })) }),
            extractZipArchiveEntry() {
                const operation = Promise.withResolvers<Uint8Array>();
                operations.push(operation);
                return operation.promise;
            }
        }
    };
    const source = readFileSync("src/equicordplugins/zipPreview/utils.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, {
        exports: api, VencordNative: {},
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const entries = api.parseZipBuffer(new ArrayBuffer(0)).entries;
    return { api, entries, operations };
}

test("ZIP entry loads cap active workers at two and waiting requests at four", async () => {
    const { api, entries, operations } = fixture();
    const loads = entries.slice(0, 6).map(entry => api.loadZipEntry(entry));
    assert.equal(operations.length, 2);
    await assert.rejects(api.loadZipEntry(entries[6]), /Too many ZIP entries/);
    for (let i = 0; i < 6; i++) {
        assert.equal(operations.length, Math.min(i + 2, 6));
        operations[i].resolve(new Uint8Array([i]));
        assert.equal((await loads[i]).data[0], i);
    }
    await Promise.all(loads);
    const retry = api.loadZipEntry(entries[6]);
    assert.equal(operations.length, 7);
    operations[6].resolve(new Uint8Array([6]));
    assert.equal((await retry).data[0], 6);
});

test("ZIP entry loads coalesce concurrent clicks and retry failed extraction", async () => {
    const { api, entries, operations } = fixture();
    const first = api.loadZipEntry(entries[0]);
    const second = api.loadZipEntry(entries[0]);
    assert.equal(operations.length, 1);
    const failed = [assert.rejects(first, /Broken entry/), assert.rejects(second, /Broken entry/)];
    operations[0].reject(new Error("Broken entry"));
    await Promise.all(failed);
    const retry = api.loadZipEntry(entries[0]);
    const repeated = api.loadZipEntry(entries[0]);
    assert.equal(operations.length, 2);
    const bytes = new Uint8Array([7]);
    operations[1].resolve(bytes);
    assert.equal((await retry).data, bytes);
    assert.equal((await repeated).data, bytes);
});

test("clearing ZIP previews rejects queued work and suppresses active results", async () => {
    const { api, entries, operations } = fixture();
    const loads = entries.slice(0, 6).map(entry => api.loadZipEntry(entry));
    const rejected = loads.map(load => assert.rejects(load, /ZIP preview was closed/));
    api.clearZipPreviewCache();
    await Promise.all(rejected.slice(2));
    assert.equal(operations.length, 2);
    operations.forEach(operation => operation.resolve(new Uint8Array([1])));
    await Promise.all(rejected);
    await assert.rejects(api.loadZipEntry(entries[0]), /no longer available/);
    await setImmediate();
    assert.equal(operations.length, 2, "cleared queued entries never start extracting");
    const fresh = api.parseZipBuffer(new ArrayBuffer(0)).entries;
    const next = api.loadZipEntry(fresh[0]);
    operations[2].resolve(new Uint8Array([9]));
    assert.equal((await next).data[0], 9);
});
