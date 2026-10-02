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

const require = createRequire(import.meta.url);
test("Codex session headers do not read megabytes of unrelated turn history", async () => {
    let bytes = Buffer.alloc(0);
    let transferred = 0;
    let closed = 0;
    const code = transpileModule(readFileSync("src/equicordplugins/automationCore.desktop/native.ts", "utf8") + "\nexport { readCodexHeader };", { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const { readCodexHeader } = runInNewContext(code + "\nexports;", {
        exports: {}, Buffer, process,
        require(name: string) {
            if (name === "@main/utils/constants") return { DATA_DIR: "fixture" };
            if (name.includes("automations/system")) return { parseCodexLine: (line: string) => { try { return JSON.parse(line); } catch { return null; } } };
            if (name === "electron") return {};
            if (name === "fs/promises") return { open: async () => ({
                stat: async () => ({ size: bytes.length }),
                read: async (buffer: Buffer, offset: number, length: number, position: number) => { const bytesRead = bytes.copy(buffer, offset, position, position + length); transferred += bytesRead; return { bytesRead }; },
                close: async () => { closed++; }
            }) };
            return require(name);
        }
    });
    bytes = Buffer.from(JSON.stringify({ kind: "session", sessionId: "fixture", cwd: "test" }) + "\n{}\n{}\n" + "x".repeat(4 * 1024 * 1024));
    assert.equal((await readCodexHeader("fixture"))?.sessionId, "fixture");
    assert.ok(transferred <= 4096, `Read ${transferred} bytes for a short header`);
    bytes = Buffer.from(JSON.stringify({ kind: "session", sessionId: "long", cwd: "😀".repeat(3000) }) + "\n{}\n{}\n");
    assert.equal((await readCodexHeader("fixture"))?.cwd, "😀".repeat(3000));
    assert.equal(closed, 2);
});
