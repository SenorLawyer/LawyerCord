/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { diffProcesses, extractQuestion, formatDuration, parseCodexLine, parsePs, parseRobloxLine, parseTasklist, projectName } from "../src/components/settings/tabs/automations/system";

// Roblox player log lines, as written on 2026-09-05.
assert.deepEqual(parseRobloxLine("2026-09-05T00:59:24.050Z,9.050683,5f98,6 [FLog::Output] ! Joining game '079195d5-adc0-48a7-8aa0-b8e0127eaa3d' place 140063367098641 at 10.30.1.92"), { kind: "join", jobId: "079195d5-adc0-48a7-8aa0-b8e0127eaa3d", placeId: "140063367098641" });
assert.deepEqual(parseRobloxLine("[FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:140063367098641, join_time:0.47, universeid:10204207151, referral_page:, sid:8a5"), { kind: "universe", placeId: "140063367098641", universeId: "10204207151" });
assert.deepEqual(parseRobloxLine("2026-09-05T00:57:51.668Z,1715.668701,5a90,6,Info [DFLog::NetworkClient] Client:Disconnect"), { kind: "leave" });
assert.equal(parseRobloxLine("[FLog::SessionL2ValidationHelper] onSessionHeartbeat sc_count 10"), null);

// Codex rollout lines.
const session = parseCodexLine(JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "C:\\Users\\me\\Dev\\TowABoat", originator: "Codex Desktop", source: { subagent: { depth: 1 } } } }));
assert.deepEqual(session, { kind: "session", sessionId: "s1", cwd: "C:\\Users\\me\\Dev\\TowABoat", originator: "Codex Desktop", subagent: true });
assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1", started_at: 1788442136 } })), { kind: "started", turnId: "t1", startedAt: 1788442136000 });
assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Done." } })), { kind: "finished", turnId: "t1", message: "Done." });
assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1", duration_ms: 12 } })), { kind: "aborted", turnId: "t1", durationMs: 12 });
assert.equal(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count", turn_id: "t1" } })), null);
assert.equal(parseCodexLine("not json"), null);

// Questions are judged from the end of the message.
assert.equal(extractQuestion("I found two options.\n\n**Should I apply the fix to both files?**"), "Should I apply the fix to both files?");
assert.equal(extractQuestion("All tests pass.\n\nThe change is committed."), undefined);
assert.equal(projectName("C:\\Users\\me\\Dev\\TowABoat\\"), "TowABoat");

// Process lists on both platforms, and the diff that produces start and exit events.
const tasklist = parseTasklist("\"RobloxPlayerBeta.exe\",\"1234\",\"Console\",\"1\",\"512,000 K\"\r\n\"Discord.exe\",\"99\",\"Console\",\"1\",\"1,024 K\"\r\n");
assert.deepEqual(tasklist, [{ name: "RobloxPlayerBeta.exe", pid: 1234, memoryKb: 512000 }, { name: "Discord.exe", pid: 99, memoryKb: 1024 }]);
assert.deepEqual(parsePs("  12 3456 /usr/bin/node\n 13 1 bash\n"), [{ pid: 12, memoryKb: 3456, name: "node" }, { pid: 13, memoryKb: 1, name: "bash" }]);
const diff = diffProcesses(new Map([["discord.exe", 99], ["old.exe", 5]]), new Map([["discord.exe", 99], ["robloxplayerbeta.exe", 1234]]));
assert.deepEqual(diff, { started: [{ name: "robloxplayerbeta.exe", pid: 1234 }], exited: [{ name: "old.exe", pid: 5 }] });

assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(8_045_000), "2h 14m 5s");
assert.equal(formatDuration(120_000), "2m");

console.log("automation system parser checks passed");
