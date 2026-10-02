/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { diffArrays } from "diff";

export interface DiffPart {
    type: "added" | "removed" | "unchanged";
    text: string;
}

export function createWordDiff(oldText: string, newText: string): DiffPart[] {
    if (oldText === newText) return oldText ? [{ type: "unchanged", text: oldText }] : [];

    const replacement: DiffPart[] = [];
    if (oldText) replacement.push({ type: "removed", text: oldText });
    if (newText) replacement.push({ type: "added", text: newText });
    if (oldText.length + newText.length > 16_000) return replacement;

    const tokenize = (text: string) => text.match(/<(?:a?:|[@#])[^>]*>|[\s\S]/gu) ?? [];
    const changes = diffArrays(tokenize(oldText), tokenize(newText), { maxEditLength: 256, timeout: 20 });
    if (!changes) return replacement;

    return changes.map(change => ({
        type: change.added ? "added" : change.removed ? "removed" : "unchanged",
        text: change.value.join("")
    }));
}

export { createWordDiff as createMessageDiff };
