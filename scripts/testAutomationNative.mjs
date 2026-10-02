/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
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
let resolvedFile;
let fileInfo;
const result = await build({
    entryPoints: ["src/equicordplugins/automationCore.desktop/native.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["electron"],
    plugins: [{ name: "isolated-paths", setup(build) {
        build.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export const DATA_DIR="/isolated-test";' }));
    } }],
});
const globals = {
    module: { exports: {} }, Buffer, URL, Date, process, AbortController, AbortSignal, TextDecoder,
    setInterval: () => { throw new Error("Native automation scans must not create background timers."); },
    setTimeout, clearTimeout,
    fetch: () => { throw new Error("Unexpected network call."); },
    require: name => {
        if (name === "electron") return { safeStorage: {}, shell: {} };
        if (name === "fs/promises") return {
            readdir: async path => { reads++; scannedFolders.push(path); return path === codexFolder ? codexNames : []; },
            realpath: async path => path === homedir() ? homedir() : resolvedFile ?? path,
            stat: async () => { reads++; if (fileInfo) return fileInfo; throw Object.assign(new Error("Missing test file"), { code: "ENOENT" }); },
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
const { readAppended, completionInput, system, fetchRobloxGame } = runInNewContext(result.outputFiles[0].text + "\n({ readAppended, completionInput, system, fetchRobloxGame });", globals);
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

const startedLine = id => JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
logBytes = Buffer.from(Array.from({ length: 250 }, (_, i) => startedLine(`abandoned-${i}`)).join("\n") + "\n");
system.codex.files.clear();
await api.pollSystemEvents({}, 0, ["codex-start"]);
assert.equal(system.codex.turns?.size ?? [...system.codex.files.values()].filter(file => file.turn).length, 1, "A session only retains its current unfinished turn.");
codexNames = [];
await api.pollSystemEvents({}, 0, ["codex-start"]);
assert.equal(system.codex.turns?.size ?? [...system.codex.files.values()].filter(file => file.turn).length, 0, "Removing a tracked session releases its unfinished turn.");
console.log("Abandoned Codex turns are owned and released by their tracked session.");

let gameRequests = 0;
globals.fetch = async url => {
    gameRequests++;
    const universeId = new URL(url).searchParams.get("universeIds");
    const text = JSON.stringify({ data: [{ id: universeId, rootPlaceId: universeId, name: `Game ${universeId}` }] });
    return new Response(text);
};
for (let i = 1; i <= 250; i++) await fetchRobloxGame(String(i), String(i), "fixture");
assert.equal(system.gameCache instanceof Map ? system.gameCache.size : system.gameCache ? 1 : 0, 1, "Only the latest game lookup is retained.");
const beforeGameHit = gameRequests;
assert.equal((await fetchRobloxGame("250", "250", "new-job")).jobId, "new-job");
assert.equal(gameRequests, beforeGameHit, "The most recent game is still reused.");

codexNames = ["overlap.jsonl"];
logBytes = Buffer.from(startedLine("overlap") + "\n");
const firstScan = api.pollSystemEvents({}, 0, ["process-start"]);
const secondScan = api.pollSystemEvents({}, 0, ["codex-start"]);
await firstScan;
const overlapped = await secondScan;
assert.ok(overlapped.events.some(event => event.codex?.turnId === "overlap"), "A caller awaits its requested source even when another source is scanning.");
console.log("Game metadata retention is bounded and overlapping source requests are scanned before returning.");

logBytes = Buffer.from(startedLine("complete") + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "complete", last_agent_message: "Done." } }) + "\n");
system.codex.files.clear();
const completeEvents = await api.pollSystemEvents({}, 0, ["codex-start", "codex-finish"]);
assert.equal(completeEvents.events.find(event => event.type === "codex-start" && event.codex.turnId === "complete").codex.status, "started");
assert.equal(completeEvents.events.find(event => event.type === "codex-finish" && event.codex.turnId === "complete").codex.status, "finished");

resolvedFile = join(parse(homedir()).root, "outside-user-folder", "secret.txt");
assert.equal((await api.readTextFile({}, { path: join(homedir(), "linked-folder", "secret.txt") })).success, false);
resolvedFile = resolve(homedir(), "fixture.txt");
logBytes = Buffer.from("short");
fileInfo = { size: 20, isFile: () => true };
const fileResult = await api.readTextFile({}, { path: resolvedFile });
assert.equal(fileResult.text, "short");
assert.equal(fileResult.success, true);
console.log("Codex event snapshots stay distinct, linked paths remain inside the home folder, and short reads contain no padding.");
