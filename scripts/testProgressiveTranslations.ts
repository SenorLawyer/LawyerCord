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

function fixture() {
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let deferred = false;
    const code = transpileModule(readFileSync("src/equicordplugins/messageTranslate/utils/translate.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, AbortController, setTimeout, clearTimeout,
        fetch: async (_url: string, options?: RequestInit) => {
            signal = options?.signal ?? undefined;
            if (deferred) await new Promise<void>(resolve => { release = resolve; });
            return { ok: true, json: async () => ({ src: "fr", confidence: 1, sentences: [{ trans: "translated" }] }) };
        },
        require(name: string) {
            if (name.includes("Logger")) return { Logger: class { error() {} } };
            return { settings: { store: { targetLanguage: "en", confidenceRequirement: 0.8 } } };
        }
    });
    return { api, defer: () => { deferred = true; }, resolve: () => release?.(), signal: () => signal };
}

test("Translation history is bounded as distinct messages accumulate", async () => {
    const { api } = fixture();
    for (let i = 0; i < 1200; i++) await api.translate(String(i), "original");
    assert.equal(api.getCached("0"), undefined);
    assert.equal(api.getCached("1199")?.translated, "translated");
});

test("Clearing translation lifetime aborts requests and discards late results", async () => {
    const f = fixture();
    f.defer();
    const pending = f.api.translate("1", "old");
    f.api.resetTranslations?.();
    f.resolve();
    assert.equal(await pending, null);
    assert.equal(f.signal()?.aborted, true);
    assert.equal(f.api.getCached("1"), undefined);
});
