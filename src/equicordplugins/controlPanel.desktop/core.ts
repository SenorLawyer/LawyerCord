/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";

import type { IndexedDiscordMessage } from "./types";

function tokenize(value: string): string[] {
    const normalized = value.toLocaleLowerCase().normalize("NFKC");
    const words = normalized.match(/[\p{L}\p{N}_'-]{2,}/gu) ?? [];
    const features = [...words];
    for (let index = 0; index + 1 < words.length; index++) features.push(`${words[index]} ${words[index + 1]}`);
    for (const word of words) {
        if (word.length < 4) continue;
        const padded = `^${word}$`;
        for (let index = 0; index + 2 < padded.length; index++) features.push(padded.slice(index, index + 3));
    }
    return features;
}

function hashFeature(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function vectorize(value: string, dimensions = 384): Float32Array {
    const vector = new Float32Array(dimensions);
    for (const feature of tokenize(value)) {
        const hash = hashFeature(feature);
        vector[hash % dimensions] += (hash & 0x80000000) === 0 ? 1 : -1;
    }
    let magnitude = 0;
    for (const component of vector) magnitude += component * component;
    magnitude = Math.sqrt(magnitude) || 1;
    for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;
    return vector;
}

function cosine(left: Float32Array, right: Float32Array): number {
    let value = 0;
    for (let index = 0; index < left.length; index++) value += left[index] * right[index];
    return value;
}

export function searchIndexedMessages(
    messages: Iterable<IndexedDiscordMessage>,
    query: string,
    requestedChannelIds: string[],
    approvedChannelIds: string[],
    limit: number,
): Array<IndexedDiscordMessage & { score: number; }> {
    const queryVector = vectorize(query);
    const queryTerms = new Set(tokenize(query).filter(term => !term.includes(" ") && term.length > 2));
    const approved = new Set(approvedChannelIds);
    const allowed = new Set((requestedChannelIds.length ? requestedChannelIds : approvedChannelIds).filter(id => approved.has(id)));
    const now = Date.now();
    return [...messages]
        .filter(message => allowed.has(message.channelId))
        .map(message => {
            const searchable = `${message.authorName} ${message.channelName} ${message.guildName ?? ""} ${message.content}`;
            const semantic = cosine(queryVector, vectorize(searchable));
            const normalized = searchable.toLocaleLowerCase();
            const exactHits = [...queryTerms].filter(term => normalized.includes(term)).length;
            const recency = Math.max(0, 1 - (now - Date.parse(message.timestamp)) / (180 * 24 * 60 * 60 * 1_000));
            return { ...message, score: Number((semantic * 0.72 + exactHits * 0.18 + recency * 0.1).toFixed(4)) };
        })
        .filter(message => message.score > 0.02)
        .sort((left, right) => right.score - left.score || right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
}

export function redactEvidenceText(value: string): string {
    return value
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
        .replace(/\b(?:\d[ -]?){9,15}\b/gu, "[REDACTED_PHONE_OR_ID]")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[REDACTED_IP]")
        .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{24}\.[\w-]{6}\.[\w-]{25,})\b/gu, "[REDACTED_TOKEN]")
        .replace(/\b(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/giu, "[REDACTED_SECRET]");
}

function canonicalEvidenceRecord(message: IndexedDiscordMessage, redact: boolean, anonymize: boolean): Record<string, unknown> {
    const authorHash = createHash("sha256").update(message.authorId).digest("hex").slice(0, 16);
    return {
        id: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
        channelName: message.channelName,
        guildName: message.guildName,
        authorId: anonymize ? `sha256:${authorHash}` : message.authorId,
        authorName: anonymize ? `User ${authorHash.slice(0, 8)}` : message.authorName,
        content: redact ? redactEvidenceText(message.content) : message.content,
        timestamp: message.timestamp,
        editedTimestamp: message.editedTimestamp,
        attachmentCount: message.attachmentCount,
        embedCount: message.embedCount,
        jumpUrl: message.jumpUrl,
    };
}

export function createChainedEvidence(
    messages: IndexedDiscordMessage[],
    redact: boolean,
    anonymize: boolean,
): { body: string; finalHash: string; } {
    let previousHash = "0".repeat(64);
    const lines = messages.map((message, index) => {
        const record = canonicalEvidenceRecord(message, redact, anonymize);
        const recordJson = JSON.stringify(record);
        const parentHash = previousHash;
        const recordHash = createHash("sha256").update(`${parentHash}\n${recordJson}`).digest("hex");
        previousHash = recordHash;
        return JSON.stringify({ sequence: index + 1, previousHash: parentHash, recordHash, record });
    });
    return {
        body: `${lines.join("\n")}${lines.length ? "\n" : ""}`,
        finalHash: previousHash,
    };
}
