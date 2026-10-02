/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Discord MCP attachment downloads retain four slots until completion and release deadlines", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/discordMcp.desktop/native.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const pending: Array<(response: Response) => void> = [];
    const timers = new Set<() => void>();
    const require = createRequire(import.meta.url);
    const fetchAttachment = runInNewContext(`${source}\nfetchAttachmentData;`, {
        exports: {}, __dirname: ".", Buffer, URL, AbortController, AbortSignal,
        require: (name: string) => name === "@main/utils/constants" ? { DATA_DIR: "fixture" }
            : name === "./policy" ? { DISCORD_MCP_TOOL_NAMES: [] } : require(name),
        setTimeout: (callback: () => void) => { timers.add(callback); return callback; },
        clearTimeout: (callback: () => void) => timers.delete(callback),
        fetch: () => new Promise<Response>(resolve => pending.push(resolve))
    });
    const requests = Array.from({ length: 100 }, () => fetchAttachment("https://cdn.discordapp.com/attachments/1/2/a")
        .then(() => "success", () => "rejected"));
    const admitted = pending.length;
    for (const finish of pending) finish(new Response(new Uint8Array([1])));
    const results = await Promise.all(requests);
    assert.equal(admitted, 4);
    assert.equal(results.filter(result => result === "success").length, 4);
    assert.equal(timers.size, 0);
    const retry = fetchAttachment("https://cdn.discordapp.com/attachments/1/2/a");
    assert.equal(pending.length, 5);
    pending[4](new Response(new Uint8Array([2])));
    assert.deepEqual(Array.from((await retry).data), [2]);
    assert.equal(timers.size, 0);
});
