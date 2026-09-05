/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isRecord } from "./model";

export interface AIMessage {
    role: "user" | "assistant";
    content: string;
}

export function parseConversation(json: string): AIMessage[] {
    if (!json.trim()) return [];
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value) || value.length > 40 || !value.every((item: unknown): item is AIMessage => isRecord(item) && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.length <= 20000) || JSON.stringify(value).length > 100000) throw new Error("Conversation must contain up to 40 user or assistant messages with role and content.");
    return value;
}

export function validateResult(value: unknown, schema: unknown, path = "result", depth = 0): void {
    if (!isRecord(schema) || depth > 20) throw new Error("The result schema is invalid or too deeply nested.");
    const supported = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description"]);
    for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported result schema keyword: ${key}.`);
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (schema.type !== undefined && schema.type !== type && !(schema.type === "integer" && typeof value === "number" && Number.isInteger(value))) throw new Error(`${path} must be ${String(schema.type)}.`);
    if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path} is not an allowed value.`);
    if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateResult(item, schema.items, `${path}.${index}`, depth + 1));
    if (isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key !== "string" || !Object.hasOwn(value, key)) throw new Error(`${path} is missing a required field.`);
        for (const [key, item] of Object.entries(value)) {
            if (Object.hasOwn(properties, key)) validateResult(item, properties[key], `${path}.${key}`, depth + 1);
            else if (schema.additionalProperties === false) throw new Error(`${path} contains an unexpected field: ${key}.`);
        }
    }
}
