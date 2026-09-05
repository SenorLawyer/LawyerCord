/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type AutomationBlock, isRecord, type ValueInput } from "./model";

export function readPath(value: unknown, path: string): unknown {
    if (!path) return value;
    for (const key of path.split(".")) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("That data path is not allowed.");
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
        value = Reflect.get(value, key);
    }
    return value;
}

export function textValue(value: unknown): string {
    return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

export function template(value: string, variables: Record<string, unknown>): string {
    return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_match: string, path: string) => textValue(readPath(variables, path.trim())));
}

export function resolveInput(input: ValueInput | undefined, variables: Record<string, unknown>, fallback?: string): unknown {
    if (!input) return fallback ? readPath(variables, fallback) : undefined;
    if (input.kind === "literal") return structuredClone(input.value);
    if (input.kind === "template") return template(input.value, variables);
    const result = readPath(variables, input.value);
    if (result === undefined) throw new Error(`Input "${input.value}" is not available on this branch.`);
    return result;
}

export function compare(left: unknown, right: unknown, operator = "equals"): boolean {
    switch (operator) {
        case "not-equals": return textValue(left) !== textValue(right);
        case "contains": return textValue(left).includes(textValue(right));
        case "greater": return Number(left) > Number(right);
        case "less": return Number(left) < Number(right);
        case "regex": return new RegExp(textValue(right), "i").test(textValue(left));
        default: return textValue(left) === textValue(right);
    }
}

export const VALUE_BLOCKS = new Set(["create-object", "parse-json", "stringify-json", "map-fields", "sort-array", "unique-array", "slice-array", "combine-arrays", "set-variable", "delete-variable", "math-variable", "text-variable", "random-number", "current-time", "array-length", "join-array", "json-value", "filter-array", "split-text", "regex-extract", "random-item"]);

export function executeValue(block: AutomationBlock, variables: Record<string, unknown>, now: number, random: () => number): unknown {
    const c = block.config;
    const input = resolveInput(c.input, variables, c.sourceVariable);
    const text = template(c.value ?? "", variables);
    const list = () => { if (!Array.isArray(input)) throw new Error("Choose a list as the input."); return input as unknown[]; };
    const field = (value: unknown) => c.fieldPath ? readPath(value, c.fieldPath) : value;
    switch (block.type) {
        case "create-object": {
            const result: unknown = JSON.parse(template(c.value ?? "{}", variables));
            if (!isRecord(result)) throw new Error("Enter a JSON object.");
            return result;
        }
        case "parse-json": return JSON.parse(textValue(input));
        case "stringify-json": return JSON.stringify(input);
        case "map-fields": return list().map(field);
        case "sort-array": return [...list()].sort((a: unknown, b: unknown) => {
            const left = field(a), right = field(b);
            const order = typeof left === "number" && typeof right === "number" ? left - right : textValue(left).localeCompare(textValue(right));
            return c.descending ? -order : order;
        });
        case "unique-array": {
            const seen = new Set<string>();
            return list().filter((item: unknown) => {
                const key = JSON.stringify(field(item));
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }
        case "slice-array": return list().slice(c.min ?? 0, c.max);
        case "combine-arrays": {
            const second = resolveInput(c.secondInput, variables);
            if (!Array.isArray(second)) throw new Error("Choose a second list.");
            return [...list(), ...second];
        }
        case "set-variable": return c.input ? input : text;
        case "delete-variable": delete variables[c.sourceVariable ?? ""]; return undefined;
        case "math-variable": {
            const a = Number(input ?? 0), b = c.amount ?? 1;
            if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Math needs finite numbers.");
            switch (c.operation) {
                case "subtract": return a - b;
                case "multiply": return a * b;
                case "divide": if (b === 0) throw new Error("Cannot divide by zero."); return a / b;
                case "round": return Math.round(a * 10 ** b) / 10 ** b;
                default: return a + b;
            }
        }
        case "text-variable": {
            const value = textValue(input);
            switch (c.operation) {
                case "uppercase": return value.toUpperCase();
                case "lowercase": return value.toLowerCase();
                case "append": return value + text;
                case "prepend": return text + value;
                case "replace": return value.replaceAll(template(c.needle ?? "", variables), template(c.replacement ?? "", variables));
                default: return value.trim();
            }
        }
        case "random-number": return Math.floor(random() * ((c.max ?? 100) - (c.min ?? 0) + 1)) + (c.min ?? 0);
        case "current-time": return c.value === "timestamp" ? now : new Date(now).toISOString();
        case "array-length": return Array.isArray(input) ? input.length : textValue(input).length;
        case "join-array": return list().map(item => textValue(field(item))).join(c.separator ?? "\n");
        case "json-value": return readPath(input, c.fieldPath ?? "");
        case "filter-array": return list().filter(item => compare(field(item), template(c.compareValue ?? "", variables), c.operator));
        case "split-text": return textValue(input).split(c.separator ?? "\n");
        case "regex-extract": {
            const match = new RegExp(template(c.matchText ?? "", variables), "i").exec(textValue(input));
            return match ? match[1] ?? match[0] : "";
        }
        case "random-item": { const items = list(); return items[Math.floor(random() * items.length)]; }
        default: throw new Error("This block does not produce a local value.");
    }
}
