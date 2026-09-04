/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { outputKind, SAFE_RETRY_TYPES } from "./catalog";
import { type Automation, AUTOMATION_BLOCK_TYPES, type AutomationBlock, type AutomationFile, BLOCK_DEFINITIONS, cloneAutomation, duplicateAutomation, graphEntry, isAutomation, isRecord, MESSAGE_BLOCKS, migrateToGraph } from "./model";
import { validateSchedule } from "./scheduling";

export interface WorkflowIssue {
    blockId?: string;
    message: string;
    severity: "error" | "warning";
}

export function destinations(block: AutomationBlock): string[] {
    return [...[block.next, block.alternate, block.error].flatMap(edge => typeof edge === "string" ? [edge] : Array.isArray(edge) ? edge.filter(id => typeof id === "string") : []), ...(Array.isArray(block.config.cases) ? block.config.cases.filter(item => isRecord(item) && typeof item.target === "string").map(item => item.target).filter(Boolean) : [])];
}

const compiled = new WeakMap<Automation, { byId: Map<string, AutomationBlock>; parents: Map<string, string[]>; entryId: string | undefined; }>();

export function compileWorkflow(automation: Automation) {
    const cached = Object.isFrozen(automation) ? compiled.get(automation) : undefined;
    if (cached) return cached;
    const byId = new Map(automation.blocks.map(block => [block.id, block]));
    const parents = new Map<string, string[]>();
    for (const block of automation.blocks) for (const target of destinations(block)) {
        const list = parents.get(target) ?? [];
        list.push(block.id);
        parents.set(target, list);
    }
    const result = { byId, parents, entryId: automation.entryId ?? graphEntry(automation.blocks)?.id };
    if (Object.isFrozen(automation)) compiled.set(automation, result);
    return result;
}

export function ancestors(automation: Automation, id: string): Set<string> {
    const { parents } = compileWorkflow(automation);
    const seen = new Set<string>();
    const pending = [...parents.get(id) ?? []];
    while (pending.length) {
        const next = pending.pop();
        if (!next || next === id || seen.has(next)) continue;
        seen.add(next);
        pending.push(...parents.get(next) ?? []);
    }
    return seen;
}

export function blockOutputs(automation: Automation, beforeId: string) {
    const upstream = ancestors(automation, beforeId);
    return automation.blocks.filter(block => upstream.has(block.id)).flatMap(block => {
        const kind = outputKind(block.type);
        const label = block.config.variable || BLOCK_DEFINITIONS.find(item => item.type === block.type)?.label || block.type;
        const fields = kind === "message" ? ["", ".id", ".channel_id", ".author.id", ".content"] : kind === "list" ? ["", ".0", ".0.content"] : [""];
        return fields.map(field => ({ value: `blocks.${block.id}.value${field}`, label: `${label}${field} · ${kind}` }));
    });
}

function messageSources(automation: Automation, id: string): Set<string> {
    const { parents, byId } = compileWorkflow(automation);
    const pending = [...parents.get(id) ?? []];
    const seen = new Set([id]);
    const sources = new Set<string>();
    while (pending.length) {
        const next = pending.pop();
        if (!next || seen.has(next)) continue;
        seen.add(next);
        const block = byId.get(next);
        if (block && (MESSAGE_BLOCKS.includes(block.type) || block.type === "fetch-message")) sources.add(next);
        else pending.push(...parents.get(next) ?? []);
    }
    return sources;
}

export function migrateWorkflow(input: unknown): Automation {
    if (!isRecord(input) || !Array.isArray(input.blocks)) throw new Error("This workflow has no block list.");
    const value = structuredClone(input);
    value.blocks = input.blocks.map(raw => {
        if (!isRecord(raw) || typeof raw.type !== "string" || typeof raw.id !== "string" || !isRecord(raw.config)) throw new Error("A block is malformed.");
        if (raw.position !== undefined && (!isRecord(raw.position) || typeof raw.position.x !== "number" || !Number.isFinite(raw.position.x) || typeof raw.position.y !== "number" || !Number.isFinite(raw.position.y))) throw new Error("A block position is malformed.");
        if (raw.config.cases !== undefined && (!Array.isArray(raw.config.cases) || raw.config.cases.some(route => !isRecord(route) || typeof route.target !== "string" || typeof route.value !== "string"))) throw new Error("Switch routes must contain a match value and a block ID.");
        if (AUTOMATION_BLOCK_TYPES.some(type => type === raw.type)) return raw;
        return { ...raw, type: "unsupported", config: { unsupported: raw } };
    });
    if (!isAutomation(value)) throw new Error("The workflow settings are malformed.");
    const migrated = cloneAutomation(value);
    if (input.schemaVersion !== 2) migrated.blocks = migrateToGraph(migrated.blocks);
    if (input.schemaVersion !== 2) {
        migrated.runMode = "skip";
        migrated.schedule = { ...migrated.schedule, missed: "legacy" };
    }
    migrated.schemaVersion = 2;
    migrated.entryId ??= graphEntry(migrated.blocks)?.id;
    return migrated;
}

export function duplicateWorkflows(workflows: Automation[]): Automation[] {
    const copies = workflows.map(workflow => duplicateAutomation(workflow));
    const ids = new Map(workflows.map((workflow, i) => [workflow.id, copies[i].id]));
    for (const copy of copies) for (const block of copy.blocks) {
        if (block.config.workflowId) block.config.workflowId = ids.get(block.config.workflowId) ?? block.config.workflowId;
    }
    return copies;
}

const numericFields = new Set(["timeoutSeconds", "durationSeconds", "limit", "repeatCount", "chancePercent", "amount", "min", "max", "maxTokens", "temperature", "embedIndex", "componentRow", "componentIndex", "retryCount", "retryDelaySeconds", "skipCount"]);
const booleanFields = new Set(["descending", "includeBots", "aiEnabled", "allowMentions", "silent", "requireReply"]);
const structuredFields = new Set(["input", "secondInput", "cases", "sample", "unsupported", "embed", "components", "modalFields", "commandOptions", "jsonDrafts"]);

export function validateWorkflow(automation: Automation, workflows: Automation[] = [automation]): WorkflowIssue[] {
    const issues: WorkflowIssue[] = [];
    const add = (message: string, blockId?: string, severity: WorkflowIssue["severity"] = "error") => issues.push({ message, blockId, severity });
    if (automation.trigger.type === "schedule") {
        const error = validateSchedule(automation.schedule);
        if (error) add(error);
    }
    const { byId, entryId } = compileWorkflow(automation);
    if (!automation.blocks.length) add("Add at least one block.");
    if (byId.size !== automation.blocks.length) add("Block IDs must be unique.");
    if (entryId && !byId.has(entryId)) add("Choose an existing entry block.");
    for (const [key, value] of Object.entries({ maxRunMinutes: automation.maxRunMinutes, maxSteps: automation.maxSteps, concurrency: automation.concurrency, queueLimit: automation.queueLimit, cooldownSeconds: automation.cooldownSeconds })) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) add(`${key} must be a nonnegative finite number.`);
    }
    if (automation.runMode && !["queue", "skip", "parallel"].includes(automation.runMode)) add("Choose a supported run mode.");
    for (const block of automation.blocks) {
        const { config } = block;
        if (["reply-message", "edit-message", "delete-message", "add-reaction", "remove-reaction", "wait-reply", "wait-reaction", "interact-button", "interact-select", "interact-modal"].includes(block.type) && !config.input && (!config.sourceVariable || config.sourceVariable === "lastMessage") && !config.messageId && messageSources(automation, block.id).size > 1) add("Several messages can reach this block. Select its input explicitly.", block.id);
        if (config.jsonDrafts && Object.keys(config.jsonDrafts).length) add("Fix the invalid JSON input before saving or testing.", block.id);
        if (config.cases !== undefined && (!Array.isArray(config.cases) || config.cases.some(item => !isRecord(item) || typeof item.target !== "string" || typeof item.value !== "string"))) add("Switch routes must contain a match value and a block ID.", block.id);
        if (config.variable && ["blocks", "__proto__", "prototype", "constructor", "__channelId", "__userId", "__blockInput", "__blockResult"].includes(config.variable.trim())) add("Choose a variable name that is not reserved by the runner.", block.id);
        if (BLOCK_DEFINITIONS.find(item => item.type === block.type)?.available === false) add("Replace this unsupported block before running.", block.id);
        for (const [key, value] of Object.entries(config)) {
            if (value === undefined || structuredFields.has(key)) continue;
            if (numericFields.has(key) ? typeof value !== "number" || !Number.isFinite(value) : booleanFields.has(key) ? typeof value !== "boolean" : typeof value !== "string") add(`Invalid ${key} setting.`, block.id);
        }
        for (const edge of [block.next, block.alternate, block.error]) {
            if (edge !== undefined && !(typeof edge === "string" || Array.isArray(edge) && edge.every(id => typeof id === "string"))) add("A connection is malformed.", block.id);
        }
        for (const target of destinations(block)) if (!byId.has(target)) add("A connection points to a missing block.", block.id);
        for (const input of [config.input, config.secondInput]) {
            if (!input) continue;
            if (!isRecord(input) || !["literal", "reference", "template"].includes(input.kind) || input.kind !== "literal" && typeof input.value !== "string") { add("Choose a valid input.", block.id); continue; }
            if (input.kind === "literal" && ["for-each", "sort-array", "unique-array", "slice-array", "combine-arrays", "map-fields"].includes(block.type) && !Array.isArray(input.value)) add("This block needs a list input.", block.id);
            if (input.kind !== "reference") continue;
            if (input.value.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part))) add("That input path is not allowed.", block.id);
            const match = /^blocks\.([\w-]+)\.value/.exec(input.value);
            if (match && !ancestors(automation, block.id).has(match[1])) add("The selected output does not come from an upstream block.", block.id);
            else if (match && !alwaysReaches(automation, match[1], block.id)) add("This input may be absent on another branch. Supply it on every incoming route.", block.id, "warning");
            const source = match ? byId.get(match[1]) : undefined;
            if (source && ["for-each", "sort-array", "unique-array", "slice-array", "combine-arrays", "map-fields"].includes(block.type) && outputKind(source.type) !== "list" && outputKind(source.type) !== "value") add("This block needs a list input.", block.id);
        }
        if (config.retryCount && !SAFE_RETRY_TYPES.has(block.type)) add("Retries are only available for read operations.", block.id);
        if (config.retryCount !== undefined && (!Number.isInteger(config.retryCount) || config.retryCount < 0 || config.retryCount > 5)) add("Choose between zero and five retries.", block.id);
        if (block.type === "call-workflow") {
            if (!workflows.some(item => item.id === config.workflowId)) add("Choose an existing workflow.", block.id);
            if (config.workflowId === automation.id) add("A workflow cannot call itself.", block.id);
        }
        if (config.matchMode === "regex" || config.operator === "regex") {
            try { new RegExp(config.matchText ?? config.compareValue ?? ""); } catch { add("Enter a valid regular expression.", block.id); }
        }
    }
    return issues;
}

function alwaysReaches(automation: Automation, sourceId: string, targetId: string): boolean {
    const { byId, entryId } = compileWorkflow(automation);
    const pending = entryId ? [entryId] : [];
    const seen = new Set<string>();
    while (pending.length) {
        const id = pending.pop();
        if (!id || id === sourceId || seen.has(id)) continue;
        if (id === targetId) return false;
        seen.add(id);
        const block = byId.get(id);
        if (block) pending.push(...destinations(block));
    }
    return true;
}

export function parseWorkflowFile(value: unknown): AutomationFile {
    if (!isRecord(value) || value.format !== "lawyercord-automation" || ![1, 2].includes(Number(value.version)) || !Array.isArray(value.automations) || value.automations.length > 100) throw new Error("This is not a supported automation file.");
    const automations = value.automations.map(migrateWorkflow);
    if (new Set(automations.map(item => item.id)).size !== automations.length) throw new Error("Workflow IDs must be unique.");
    const errors = automations.flatMap(item => validateWorkflow(item, automations)).filter(issue => issue.severity === "error" && !issue.message.includes("unsupported") && !issue.message.includes("existing workflow"));
    if (errors.length) throw new Error(errors[0].message);
    return { format: "lawyercord-automation", version: 2, exportedAt: new Date().toISOString(), automations, guilds: [] };
}
