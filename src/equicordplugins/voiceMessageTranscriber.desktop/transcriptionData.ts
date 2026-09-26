/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type TranscriptionTimestamp = [number, number | null];

export interface TranscriptionChunk {
    timestamp: TranscriptionTimestamp;
    text: string;
}

export interface TranscriptionResult {
    text: string;
    chunks: TranscriptionChunk[];
}

export interface TranscriptionProgress {
    file?: string;
    loaded?: number;
    progress?: number;
    status?: string;
    total?: number;
}

export function normalizeTranscriptionResult(value: unknown): TranscriptionResult {
    const candidate = value as Partial<TranscriptionResult> | null;
    const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
    const chunks = Array.isArray(candidate?.chunks)
        ? candidate.chunks.filter((chunk): chunk is TranscriptionChunk => (
            typeof chunk?.text === "string"
            && Array.isArray(chunk.timestamp)
            && Number.isFinite(chunk.timestamp[0]) && chunk.timestamp[0] >= 0
            && (chunk.timestamp[1] === null || Number.isFinite(chunk.timestamp[1]) && chunk.timestamp[1] >= chunk.timestamp[0])
        ))
        : [];

    return { text, chunks };
}

export function formatTimestamp(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

export function formatTimestampedTranscript(result: TranscriptionResult): string {
    return result.chunks.map(chunk => {
        const end = chunk.timestamp[1] == null ? "end" : formatTimestamp(chunk.timestamp[1]);
        return `[${formatTimestamp(chunk.timestamp[0])} - ${end}] ${chunk.text.trim()}`;
    }).join("\n");
}
