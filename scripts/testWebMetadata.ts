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

const { outputText } = transpileModule(readFileSync("src/utils/web-metadata.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

test("extension metadata ignores malformed and external messages before legitimate initialization", async () => {
    for (const url of [
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/dist/LawyerCord.css",
        "moz-extension://d4acdf6a-4bb7-4cdd-a195-8f971cba5ab2/dist/LawyerCord.css"
    ]) {
        let listener: ((event: { data: unknown }) => void) | undefined;
        let removed = 0;
        const api = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, IS_EXTENSION: true,
            window: {
                addEventListener(type: string, callback: typeof listener) {
                    assert.equal(type, "message");
                    listener = callback;
                },
                removeEventListener(type: string, callback: typeof listener) {
                    assert.equal(type, "message");
                    assert.equal(callback, listener);
                    removed++;
                }
            }
        });
        assert.ok(listener);
        let ready = false;
        api.metaReady.then(() => { ready = true; });
        for (const data of [null, 1, "vencord:meta", {}, { type: "other" },
            ...[undefined, null, {}, { RENDERER_CSS_URL: 1 },
                { RENDERER_CSS_URL: "https://example.com/dist/LawyerCord.css" },
                { RENDERER_CSS_URL: `${url}?override=1` },
                { RENDERER_CSS_URL: url.replace("LawyerCord.css", "other.css") }
            ].map(meta => ({ type: "vencord:meta", meta }))]) {
            assert.doesNotThrow(() => listener?.({ data }));
            await Promise.resolve();
            assert.equal(ready, false);
            assert.equal(removed, 0);
            assert.equal(api.RENDERER_CSS_URL, undefined);
        }
        listener({ data: { type: "vencord:meta", meta: { RENDERER_CSS_URL: url } } });
        await api.metaReady;
        assert.equal(ready, true);
        assert.equal(removed, 1);
        assert.equal(api.RENDERER_CSS_URL, url);
    }
});
