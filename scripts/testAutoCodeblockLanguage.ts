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

const { outputText } = transpileModule(readFileSync("src/equicordplugins/autoCodeblockLanguage.desktop/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

function fixture() {
    let lookups = 0;
    let highlights = 0;
    const calls: unknown[] = [];
    const shiki = { renderHighlighter: (args: { lang: string; content: string; extra: string; }) => { calls.push(args); return args; } };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@plugins/shikiCodeblocks.desktop": { __esModule: true, default: shiki },
        "@plugins/shikiCodeblocks.desktop/utils/misc": {
            requireHljs: () => Promise.resolve(),
            hljs: {
                getLanguage: () => { lookups++; return true; },
                listLanguages: () => ["python"],
                highlight: () => { highlights++; return { relevance: 0 }; },
                highlightAuto: () => { highlights++; return { language: "python", relevance: 12, secondBest: { relevance: 1 } }; }
            }
        },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin }
    };
    const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { plugin, shiki, calls, work: () => ({ lookups, highlights }) };
}

test("language guessing preserves explicit tags without scanning or highlighting", () => {
    const f = fixture();
    for (const language of ["python", "py", "plaintext", "text", "custom-language"]) {
        assert.equal(f.plugin.resolveLanguage(language, "const result = () => console.log(1);"), language);
    }
    assert.deepEqual(f.work(), { lookups: 0, highlights: 0 });
});

test("untagged blocks retain hints and cached detection while oversized blocks skip guessing", () => {
    const f = fixture();
    assert.equal(f.plugin.resolveLanguage(undefined, "def hello():\n    print('hello')"), "py");
    assert.equal(f.plugin.resolveLanguage("", "sample of sufficiently long text"), "python");
    const work = f.work();
    assert.equal(work.highlights, 1);
    assert.equal(f.plugin.resolveLanguage("", "sample of sufficiently long text"), "python");
    assert.deepEqual(f.work(), work);
    assert.equal(f.plugin.resolveLanguage("", "const data = () => console.log(1);\n".repeat(2000)), "");
    assert.deepEqual(f.work(), work);
    f.plugin.stop();
    assert.equal(f.plugin.resolveLanguage(undefined, "sample of sufficiently long text"), "python");
    assert.equal(f.work().highlights, 2);
});

test("the Shiki wrapper preserves tagged props and restores rendering on stop", async () => {
    const f = fixture();
    const original = f.shiki.renderHighlighter;
    f.plugin.start();
    await Promise.resolve();
    await Promise.resolve();
    const tagged = { lang: "python", content: "const result = () => console.log(1);", extra: "retained" };
    assert.equal(f.shiki.renderHighlighter(tagged), tagged);
    assert.deepEqual(f.work(), { lookups: 0, highlights: 0 });
    const untagged = { lang: "", content: "def hello():\n    print('hello')", extra: "retained" };
    assert.deepEqual({ ...f.shiki.renderHighlighter(untagged) }, { ...untagged, lang: "py" });
    assert.equal(untagged.lang, "");
    f.plugin.stop();
    assert.equal(f.shiki.renderHighlighter, original);
    assert.equal(f.shiki.renderHighlighter(untagged), untagged);
});
