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

function load(path: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    return runInNewContext(outputText + "\nexports;", {
        exports: {}, require: (name: string) => modules[name] ?? {},
        structuredClone, queueMicrotask, TextEncoder, TextDecoder, ...globals
    });
}

test("cloud snapshots and exports exclude local model values before deserializing them", async () => {
    const records = new Map<string, unknown>([
        ["VoiceMessageTranscriber_model", new Uint8Array(1024 * 1024)],
        ["Vencord_cloudSecret", { private: true }], ["public", { saved: true }]
    ]);
    const reads: string[] = [];
    let bulkReads = 0;
    const request = (result: unknown) => {
        const value: { result: unknown; onsuccess?: () => void; } = { result };
        queueMicrotask(() => value.onsuccess?.());
        return value;
    };
    const dataStore = load("src/api/DataStore/index.ts", {});
    const store = {
        entries: (_customStore: unknown, filter?: (key: string) => boolean) => dataStore.entries(
            async (_mode: string, callback: (value: object) => unknown) => callback({
                getAllKeys: () => request([...records.keys()]),
                getAll() { bulkReads++; return request([...records.values()]); },
                get(key: string) { reads.push(key); return request(records.get(key)); }
            }), filter
        )
    };
    const settings = { plugins: {}, cloud: { url: "https://first.invalid" } };
    const offline = load("src/api/SettingsSync/offline.ts", {
        "@api/Settings": { DefaultSettings: settings, PlainSettings: settings, flushSettings: async () => {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "1" }) } },
        "..": { DataStore: store }
    }, { VencordNative: { settings: { get: () => settings }, quickCss: { get: async () => "" } } });
    const snapshot = await offline.captureCloudImportState();
    assert.deepEqual(Array.from(snapshot.dataStore.keys()), ['"public"']);
    const cloud = JSON.parse(await offline.exportSettings({ cloud: true }));
    assert.deepEqual(cloud.dataStore, [["public", { saved: true }]]);
    assert.equal(bulkReads, 0);
    assert.deepEqual(reads, ["public", "public"]);
    await assert.rejects(offline.exportSettings({ cloud: false }));
    assert.equal(bulkReads, 1, "full local exports still read every value and preserve the existing unsupported-value check");
});
