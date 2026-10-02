/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
let reads = 0;
let processes = 0;
let logBytes = Buffer.alloc(0);
let readLimit = Infinity;
const scannedFolders = [];
let codexFolder;
let codexNames = [];
const result = await build({
    entryPoints: ["src/equicordplugins/automationCore.desktop/native.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["electron"],
    plugins: [{ name: "isolated-paths", setup(build) {
        build.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export const DATA_DIR="/isolated-test";' }));
    } }],
});
const globals = {
    module: { exports: {} }, Buffer, URL, Date, process, AbortController,
    setInterval: () => { throw new Error("Native automation scans must not create background timers."); },
    setTimeout, clearTimeout,
    fetch: () => { throw new Error("Unexpected network call."); },
    require: name => {
        if (name === "electron") return { safeStorage: {}, shell: {} };
        if (name === "fs/promises") return {
            readdir: async path => { reads++; scannedFolders.push(path); return path === codexFolder ? codexNames : []; },
            stat: async () => { reads++; throw Object.assign(new Error("Missing test file"), { code: "ENOENT" }); },
            open: async () => ({
                stat: async () => ({ size: logBytes.length }),
                read: async (buffer, offset, length, position) => ({ bytesRead: logBytes.copy(buffer, offset, position, position + Math.min(length, readLimit)) }),
                close: async () => {}
            })
        };
        if (name === "child_process") return { spawn: () => { processes++; throw new Error("Unexpected process scan."); } };
        return require(name);
    },
};
const { readAppended, completionInput } = runInNewContext(result.outputFiles[0].text + "\n({ readAppended, completionInput });", globals);
const api = globals.module.exports;
await api.pollSystemEvents({}, 0, []);
assert.equal(reads, 0);
assert.equal(processes, 0);
await api.pollSystemEvents({}, 0, ["codex-finish"]);
assert.ok(reads > 0);
assert.equal(processes, 0);
const previousReads = reads;
await api.pollSystemEvents({}, 0, []);
assert.equal(reads, previousReads);
await api.pollSystemEvents({}, 0, ["process-start"]);
assert.equal(processes, 1);
await api.pollSystemEvents({}, 0, ["process-start"]);
assert.equal(processes, 1);
assert.equal(reads, previousReads);
console.log("Native scans are demand-driven, source-specific, and create no background timers.");

logBytes = Buffer.from('first\n{"message":"');
let chunk = await readAppended("fixture", 0);
assert.equal(chunk.offset, 6);
assert.equal(chunk.lines.filter(Boolean).join("\n"), "first");
logBytes = Buffer.from('first\n{"message":"😀"}\n');
readLimit = 14;
chunk = await readAppended("fixture", chunk.offset);
assert.equal(chunk.offset, 6);
assert.equal(chunk.lines.filter(Boolean).length, 0);
readLimit = Infinity;
chunk = await readAppended("fixture", chunk.offset);
assert.equal(chunk.lines.filter(Boolean).join("\n"), '{"message":"😀"}');
assert.equal(chunk.offset, logBytes.length);
logBytes = Buffer.from("reset\n");
chunk = await readAppended("fixture", chunk.offset);
assert.equal(chunk.lines.filter(Boolean).join("\n"), "reset");
assert.equal(chunk.offset, logBytes.length);
console.log("Incremental log reads retain partial lines and UTF-8 bytes across short reads and truncation.");

const cap = 4 * 1024 * 1024;
logBytes = Buffer.alloc(cap + 17, 0x78);
chunk = await readAppended("fixture", 0);
assert.equal(chunk.offset, cap, "An oversized line must advance rather than reread the same chunk every poll.");
assert.equal(chunk.discarding, true);
chunk = await readAppended("fixture", chunk.offset, chunk.discarding);
assert.equal(chunk.offset, logBytes.length);
assert.equal(chunk.discarding, true);
const boundary = '{"type":"event_msg","payload":{"type":"task_started","turn_id":"later"}}';
logBytes = Buffer.concat([logBytes, Buffer.from(`\n${boundary}\npartial 😀`)]);
chunk = await readAppended("fixture", chunk.offset, chunk.discarding);
assert.equal(chunk.lines.filter(Boolean).join("\n"), boundary);
assert.equal(chunk.discarding, false);
logBytes = Buffer.concat([logBytes, Buffer.from("\n")]);
chunk = await readAppended("fixture", chunk.offset, chunk.discarding);
assert.equal(chunk.lines.filter(Boolean).join("\n"), "partial 😀");
logBytes = Buffer.from("reset\n");
chunk = await readAppended("fixture", cap, true);
assert.equal(chunk.lines.filter(Boolean).join("\n"), "reset");
assert.equal(chunk.discarding, false);
console.log("Oversized log lines are skipped across polls without hiding subsequent events or ordinary partial lines.");

codexFolder = scannedFolders[0];
codexNames = ["fixture.jsonl"];
logBytes = Buffer.alloc(cap + 17, 0x78);
const beforeOversized = await api.pollSystemEvents({}, 0, ["codex-start"]);
assert.equal(beforeOversized.events.length, 0);
logBytes = Buffer.concat([logBytes, Buffer.from(`\n${boundary}\n`)]);
const afterOversized = await api.pollSystemEvents({}, beforeOversized.cursor, ["codex-start"]);
assert.equal(afterOversized.events.length, 1, "Codex polling must retain its discard position and reach the later turn.");
assert.equal(afterOversized.events[0].codex.turnId, "later");
assert.equal((await api.pollSystemEvents({}, afterOversized.cursor, ["codex-start"])).events.length, 0);

const input = { requestId: "fixture", timeoutSeconds: 30, messages: [], model: "vendor/model", systemPrompt: "", prompt: "Hello", maxTokens: 100, temperature: 0.2, json: false };
const cyclic = {};
cyclic.self = cyclic;
for (const messages of [[cyclic], [1n], [null], [{ role: "system", content: "invalid" }]]) {
    assert.equal(completionInput({ ...input, messages }), null);
}
const valid = completionInput({ ...input, messages: [{ role: "user", content: "history", extra: cyclic, bigint: 1n }] });
assert.deepEqual(Object.keys(valid.messages[0]), ["role", "content"]);
assert.equal(valid.messages[0].content, "history");
assert.equal(completionInput({ ...input, messages: Array.from({ length: 6 }, () => ({ role: "user", content: "a".repeat(20000) })) }), null);
console.log("AI history validation rejects malformed values and forwards only validated message fields.");
