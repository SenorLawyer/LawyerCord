/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AutomationBlockConfig, AutomationBlockType, BlockDefinition } from "./model";

export const EXTENDED_TYPES = ["for-each", "switch", "call-workflow", "return", "stop-run", "create-object", "parse-json", "stringify-json", "map-fields", "sort-array", "unique-array", "slice-array", "combine-arrays", "read-value", "write-value", "delete-value", "increment-value", "wait-reaction", "fetch-message", "list-reactions", "get-channel", "spotify-shuffle", "spotify-repeat", "unsupported"] as const;

export const EXTENDED_BLOCKS: readonly BlockDefinition[] = [
    { type: "for-each", label: "For each item", description: "Run the body for each item in a list.", category: "flow" },
    { type: "switch", label: "Switch", description: "Choose a route by matching a value.", category: "flow" },
    { type: "call-workflow", label: "Call workflow", description: "Pass input to another workflow and collect its result.", category: "flow" },
    { type: "return", label: "Return value", description: "Finish this workflow with a result.", category: "flow" },
    { type: "stop-run", label: "Stop run", description: "Stop every remaining branch in this run.", category: "flow" },
    { type: "create-object", label: "Create object", description: "Build a structured object from JSON and references.", category: "variables" },
    { type: "parse-json", label: "Parse JSON", description: "Read JSON text as a structured value.", category: "variables" },
    { type: "stringify-json", label: "JSON to text", description: "Convert a value to JSON text.", category: "variables" },
    { type: "map-fields", label: "Map fields", description: "Collect a field from every item.", category: "variables" },
    { type: "sort-array", label: "Sort items", description: "Sort a list by a field or value.", category: "variables" },
    { type: "unique-array", label: "Remove duplicates", description: "Keep the first item for each distinct value.", category: "variables" },
    { type: "slice-array", label: "Slice items", description: "Take items between two indexes.", category: "variables" },
    { type: "combine-arrays", label: "Combine lists", description: "Append one list to another.", category: "variables" },
    { type: "read-value", label: "Read saved value", description: "Read a value saved by this workflow.", category: "variables" },
    { type: "write-value", label: "Save value", description: "Keep a value across runs and restarts.", category: "variables" },
    { type: "delete-value", label: "Delete saved value", description: "Remove a saved workflow value.", category: "variables" },
    { type: "increment-value", label: "Increment saved value", description: "Add to a saved number atomically.", category: "variables" },
    { type: "wait-reaction", label: "Wait for reaction", description: "Wait for a reaction on a chosen message.", category: "waits" },
    { type: "fetch-message", label: "Fetch message", description: "Read one message by its channel and ID.", category: "data" },
    { type: "list-reactions", label: "List reactions", description: "Read the reaction counts on a message.", category: "data" },
    { type: "get-channel", label: "Inspect channel", description: "Read the channel name, type, and server.", category: "data" },
    { type: "spotify-shuffle", label: "Set shuffle", description: "Turn Spotify shuffle on or off.", category: "spotify" },
    { type: "spotify-repeat", label: "Set repeat", description: "Repeat the track, context, or neither.", category: "spotify" },
    { type: "unsupported", label: "Unsupported block", description: "Replace this block before running the workflow.", category: "flow", available: false },
];

export const EXTENDED_DEFAULTS: Partial<Record<AutomationBlockType, AutomationBlockConfig>> = Object.fromEntries(EXTENDED_TYPES.map(type => [type, {
    variable: type === "for-each" ? "item" : "result",
    ...(type === "create-object" ? { value: "{}" } : {}),
    ...(type === "switch" ? { cases: [] } : {}),
    ...(type.endsWith("-value") ? { persistentKey: "value", amount: 1 } : {}),
    ...(type === "wait-reaction" ? { timeoutSeconds: 60 } : {}),
    ...(type === "spotify-shuffle" ? { value: "true" } : {}),
    ...(type === "spotify-repeat" ? { value: "off" } : {}),
}]));

export const SAFE_RETRY_TYPES = new Set<AutomationBlockType>(["fetch-message", "list-reactions", "get-channel", "fetch-messages", "fetch-unread", "fetch-mentions", "get-user", "read-value"]);

export function outputKind(type: AutomationBlockType): string {
    if (["for-each", "return", "call-workflow", "read-value", "json-value", "set-variable"].includes(type)) return "value";
    if (["array-length", "math-variable", "random-number", "increment-value"].includes(type)) return "number";
    if (["create-object", "parse-json", "ai-extract-json", "get-user", "get-channel", "spotify-now-playing", "roblox-current-game", "roblox-game-info", "codex-last-turn", "run-program"].includes(type)) return "object";
    if (["fetch-messages", "fetch-mentions", "fetch-unread", "fetch-dm", "search-messages", "filter-array", "split-text", "map-fields", "sort-array", "unique-array", "slice-array", "combine-arrays", "list-reactions", "read-components", "list-processes", "codex-sessions"].includes(type)) return "list";
    if (["send-message", "send-dm", "reply-message", "edit-message", "wait-reply", "wait-dm", "fetch-message"].includes(type)) return "message";
    return "text";
}
