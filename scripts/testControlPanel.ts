/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
    createChainedEvidence,
    redactEvidenceText,
    searchIndexedMessages,
} from "../src/equicordplugins/controlPanel.desktop/core";
import type { IndexedDiscordMessage } from "../src/equicordplugins/controlPanel.desktop/types";

async function main() {
const approvedChannel = "1085873944751521792";
const otherChannel = "1085873944751521793";
const baseMessage: IndexedDiscordMessage = {
    id: "1200000000000000001",
    channelId: approvedChannel,
    guildId: "690342051778396403",
    channelName: "case-room",
    guildName: "LawyerCord",
    authorId: "1045011641940574208",
    authorName: "Counsel",
    content: "Deployment failed because the signing certificate expired.",
    timestamp: new Date().toISOString(),
    editedTimestamp: null,
    attachmentCount: 0,
    embedCount: 0,
    jumpUrl: "https://discord.com/channels/690342051778396403/1085873944751521792/1200000000000000001",
};

const hiddenMessage: IndexedDiscordMessage = {
    ...baseMessage,
    id: "1200000000000000002",
    channelId: otherChannel,
    content: "Deployment certificate discussion outside approved scope.",
};

const results = searchIndexedMessages(
    [baseMessage, hiddenMessage],
    "deployment certificate problem",
    [],
    [approvedChannel],
    10,
);
assert.equal(results.length, 1, "search returns only explicitly approved channels");
assert.equal(results[0].id, baseMessage.id);
assert.ok(results[0].score > 0.2, "hybrid semantic score is meaningful for a related phrase");

const redacted = redactEvidenceText(
    "Email admin@example.com from 192.168.1.9; password=hello and mfa.abcdefghijklmnopqrstuvwxyz"
);
assert.doesNotMatch(redacted, /admin@example\.com|192\.168\.1\.9|password=hello|mfa\./u);
assert.match(redacted, /\[REDACTED_EMAIL\]/u);
assert.match(redacted, /\[REDACTED_IP\]/u);
assert.match(redacted, /\[REDACTED_SECRET\]/u);

const evidence = createChainedEvidence([baseMessage, { ...baseMessage, id: "1200000000000000003" }], true, true);
const records = evidence.body.trim().split("\n").map(line => JSON.parse(line));
let previousHash = "0".repeat(64);
for (const entry of records) {
    assert.equal(entry.previousHash, previousHash, "every record identifies its chain parent");
    const expected = createHash("sha256").update(`${previousHash}\n${JSON.stringify(entry.record)}`).digest("hex");
    assert.equal(entry.recordHash, expected, "record hash covers its parent and canonical record");
    previousHash = entry.recordHash;
}
assert.equal(evidence.finalHash, previousHash);
assert.match(records[0].record.authorId, /^sha256:/u);
assert.doesNotMatch(records[0].record.content, /admin@example\.com/u);

const html = await readFile("src/equicordplugins/controlPanel.desktop/dashboard.html", "utf8");
assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https?:/iu, "dashboard has no remote script or stylesheet");
assert.match(html, /Semantic search/u);
assert.match(html, /Evidence exports/u);
assert.match(html, /Plugin capability inventory/u);

console.log("control-panel search, redaction, evidence-chain, and local-asset checks passed");
}

void main();
