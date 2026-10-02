/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Speech model settings read only model values one at a time and stop scanning on unmount", async () => {
    const source = readFileSync("src/equicordplugins/voiceMessageTranscriber.desktop/index.tsx", "utf8");
    const start = source.indexOf("component: () => {") + "component: ".length;
    const end = source.indexOf("\n    }\n});", start);
    const code = transpileModule(`const Component = ${source.slice(start, end)}; Component`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    let cleanup: (() => void) | undefined;
    let resolveGet: ((value: ArrayBuffer) => void) | undefined;
    let bulkReads = 0;
    const reads: string[] = [];
    const component = runInNewContext(code, {
        React: { createElement: () => null }, Button: "button", showToast: () => undefined, Toasts: { Type: {} },
        useState: (value: unknown) => [value, () => undefined],
        useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); },
        lodash: { isArrayBuffer: (value: unknown) => value instanceof ArrayBuffer },
        DataStore: {
            entries: async () => { bulkReads++; return []; },
            keys: async () => ["other-plugin-data", "VoiceMessageTranscriber_model1", "VoiceMessageTranscriber_model2"],
            get: (key: string) => { reads.push(key); return new Promise<ArrayBuffer>(resolve => { resolveGet = resolve; }); }
        }
    });
    component();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bulkReads, 0);
    assert.deepEqual(reads, ["VoiceMessageTranscriber_model1"]);
    cleanup?.();
    assert.ok(resolveGet);
    resolveGet(new ArrayBuffer(16));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1);
});
