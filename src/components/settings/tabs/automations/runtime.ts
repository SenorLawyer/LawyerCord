/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Automation, type AutomationBlock, type AutomationPort, edgeTargets, isRecord } from "./model";
import { compare, executeValue, resolveInput, template, textValue, VALUE_BLOCKS } from "./values";
import { compileWorkflow, validateWorkflow } from "./workflow";

export interface RunContext {
    runId: string;
    workflow: Automation;
    variables: Record<string, unknown>;
    signal: AbortSignal;
    dryRun: boolean;
}

export interface BlockResult {
    usage?: unknown;
    value?: unknown;
    port?: AutomationPort;
}

export interface RunEvent {
    usage?: string;
    inputPreview?: string;
    blockLabel?: string;
    runId: string;
    workflowId: string;
    blockId: string;
    status: "running" | "success" | "failure";
    port?: AutomationPort;
    durationMs?: number;
    message: string;
    preview?: string;
}

export interface RuntimeEnvironment {
    now(): number;
    random(): number;
    delay(ms: number, signal: AbortSignal): Promise<void>;
    external(block: AutomationBlock, context: RunContext): Promise<BlockResult>;
    persistent(workflowId: string, operation: string, key: string, value: unknown, signal: AbortSignal): Promise<unknown>;
    workflows(): Automation[];
    trace(event: RunEvent): void;
}

export function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Run cancelled.");
}

export function checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal);
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const cancel = () => reject(abortError(signal));
        signal.addEventListener("abort", cancel, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
    checkCancelled(signal);
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(abortError(signal)); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, Math.max(0, ms));
        signal.addEventListener("abort", cancel, { once: true });
    });
}

interface Budget {
    stopped?: boolean;
    remaining: number;
    deadline: number;
}

export async function executeWorkflow(workflow: Automation, variables: Record<string, unknown>, environment: RuntimeEnvironment, options: { signal?: AbortSignal; dryRun?: boolean; runId?: string; immutableSnapshot?: boolean; } = {}): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const minutes = workflow.maxRunMinutes ?? 15;
    const timer = minutes > 0 ? setTimeout(() => controller.abort(new Error("Run time limit reached.")), Math.min(minutes * 60_000, 2_147_000_000)) : undefined;
    try {
        return await run(options.immutableSnapshot ? workflow : Object.freeze(structuredClone(workflow)), structuredClone(variables), environment, {
            runId: options.runId ?? crypto.randomUUID(),
            signal: controller.signal,
            dryRun: options.dryRun ?? false,
        }, { remaining: workflow.maxSteps ?? 10_000, deadline: minutes > 0 ? environment.now() + minutes * 60_000 : Infinity }, [], new Map());
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
    }
}

async function run(workflow: Automation, variables: Record<string, unknown>, env: RuntimeEnvironment, options: Omit<RunContext, "workflow" | "variables">, budget: Budget, callers: string[], dryValues: Map<string, unknown>): Promise<unknown> {
    if (callers.includes(workflow.id)) throw new Error("Recursive workflow calls are not allowed.");
    const issues = validateWorkflow(workflow, env.workflows()).filter(issue => issue.severity === "error");
    if (issues.length) throw new Error(issues[0].message);
    const { byId, entryId } = compileWorkflow(workflow);
    const context: RunContext = { ...options, workflow, variables };
    const pending = entryId ? [entryId] : [];
    const loops: { id: string; index: number; items: unknown[]; pendingLength: number; }[] = [];
    variables.blocks = {};
    let yieldedAt = env.now();
    while (pending.length && !budget.stopped) {
        checkCancelled(context.signal);
        if (env.now() >= budget.deadline) throw new Error("Run time limit reached.");
        if (budget.remaining-- <= 0) throw new Error("Block step limit reached. Check the workflow for an endless loop.");
        if (budget.remaining % 100 === 0 && env.now() - yieldedAt >= 8) { await env.delay(0, context.signal); yieldedAt = env.now(); }
        const id = pending.pop();
        const block = id ? byId.get(id) : undefined;
        if (!block) throw new Error("A connection points to a missing block.");
        const started = env.now();
        if (isRecord(variables.blocks)) delete variables.blocks[block.id];
        const emit = (event: Omit<RunEvent, "runId" | "workflowId" | "blockId">) => env.trace({ ...event, runId: context.runId, workflowId: workflow.id, blockId: block.id, blockLabel: block.type });
        let port: AutomationPort = "next";
        let targets: string[] | undefined;
        let value: unknown;
        let usage: unknown;
        try {
            const c = block.config;
            const input = () => resolveInput(c.input, variables, c.sourceVariable);
            emit({ status: "running", message: "Block started.", inputPreview: textValue(input()).slice(0, 2000) });
            if (VALUE_BLOCKS.has(block.type)) value = executeValue(block, variables, env.now(), env.random);
            else if (block.type === "condition") {
                const left = c.input ? input() : c.sourceVariable ? (c.sourceVariable.includes("{{") ? template(c.sourceVariable, variables) : resolveInput({ kind: "reference", value: c.sourceVariable }, variables)) : c.value ? template(c.value, variables) : variables.lastMessage;
                port = compare(!c.input && !c.sourceVariable && isRecord(left) ? left.content : left, template(c.compareValue ?? "", variables), c.operator) ? "next" : "alternate";
            } else if (block.type === "chance") port = env.random() * 100 < (c.chancePercent ?? 50) ? "next" : "alternate";
            else if (block.type === "switch") {
                const match = c.cases?.find(item => template(item.value, variables) === textValue(input()));
                targets = match ? [match.target] : edgeTargets(block.alternate);
            } else if (block.type === "repeat" || block.type === "for-each") {
                let loop = loops.at(-1);
                if (loop?.id !== block.id) {
                    const data = block.type === "for-each" ? input() : Array.from({ length: Math.min(1000, Math.max(0, Math.trunc(c.repeatCount ?? 1))) }, (_item: unknown, index: number) => index + 1);
                    if (!Array.isArray(data)) throw new Error("For each needs a list input.");
                    loop = { id: block.id, index: 0, items: data, pendingLength: pending.length };
                    loops.push(loop);
                }
                if (loop.index >= loop.items.length) { loops.pop(); port = "alternate"; }
                else {
                    value = loop.items[loop.index++];
                    variables.loopIndex = loop.index;
                }
            } else if (block.type === "break-loop") {
                const loop = loops.pop();
                if (!loop) throw new Error("Break loop must run inside a loop.");
                pending.length = loop.pendingLength;
                targets = edgeTargets(byId.get(loop.id)?.alternate);
            } else if (block.type === "stop") targets = [];
            else if (block.type === "stop-run") { budget.stopped = true; pending.length = 0; targets = []; }
            else if (block.type === "return") {
                value = input();
                emit({ status: "success", message: "Value returned.", durationMs: env.now() - started });
                return value;
            } else if (block.type === "call-workflow") {
                const child = env.workflows().find(item => item.id === c.workflowId);
                if (!child) throw new Error("The called workflow no longer exists.");
                value = await run(structuredClone(child), { input: input() }, env, options, budget, [...callers, workflow.id], dryValues);
            } else if (block.type === "delay" || block.type === "wait-until") {
                const when = template(c.value ?? "", variables);
                const duration = block.type === "delay" ? (c.durationSeconds ?? 1) * 1000 : (/^\d+$/.test(when) ? Number(when) : Date.parse(when)) - env.now();
                if (!Number.isFinite(duration)) throw new Error("Choose a valid wait time.");
                if (!context.dryRun) {
                    let remaining = Math.max(0, duration);
                    do { const chunk = Math.min(remaining, 2_147_000_000); await env.delay(chunk, context.signal); remaining -= chunk; } while (remaining > 0);
                }
            } else if (["read-value", "write-value", "delete-value", "increment-value"].includes(block.type)) {
                const key = template(c.persistentKey ?? "", variables).trim();
                if (!key || key.length > 128) throw new Error("Use a saved value name between 1 and 128 characters.");
                const supplied = block.type === "increment-value" ? c.amount ?? 1 : input();
                if (context.dryRun) {
                    const scoped = `${workflow.id}:${key}`;
                    value = updateSavedValue(dryValues.get(scoped), block.type, supplied);
                    dryValues.set(scoped, value);
                } else value = await abortable(env.persistent(workflow.id, block.type, key, supplied, context.signal), context.signal);
            } else if (block.type === "fail") throw new Error(template(c.errorMessage ?? "Workflow failed.", variables));
            else if (!["log", "note", "end-if", "end-repeat", "else"].includes(block.type)) {
                let result: BlockResult;
                if (context.dryRun) {
                    if (!Object.hasOwn(c, "sample")) throw new Error("Add a sample result to test this external block.");
                    result = { value: structuredClone(c.sample), port: c.sample === null && ["wait-reply", "wait-dm", "wait-reaction"].includes(block.type) ? "alternate" : "next" };
                } else {
                    let attempt = 0;
                    while (true) {
                        checkCancelled(context.signal);
                        try { result = await abortable(env.external(block, context), context.signal); break; }
                        catch (error) {
                            checkCancelled(context.signal);
                            if (attempt++ >= (c.retryCount ?? 0)) throw error;
                            await env.delay((c.retryDelaySeconds ?? 1) * 1000 * attempt, context.signal);
                        }
                    }
                }
                value = result.value;
                usage = result.usage;
                port = result.port ?? "next";
            }
            checkCancelled(context.signal);
            if (value !== undefined) {
                if (c.variable?.trim()) variables[c.variable.trim()] = value;
                const outputs = variables.blocks;
                if (isRecord(outputs)) outputs[block.id] = { value, usage };
                if (isRecord(value) && typeof value.channel_id === "string" && typeof value.id === "string") variables.lastMessage = value;
            }
            emit({ status: "success", port, usage: usage ? textValue(usage).slice(0, 1000) : undefined, message: block.type === "log" ? "Log recorded." : port === "alternate" ? "Alternate route selected." : "Block completed.", durationMs: env.now() - started, preview: (block.type === "log" ? template(c.content ?? "Checkpoint reached.", variables) : textValue(value)).slice(0, 2000) });
        } catch (error) {
            checkCancelled(context.signal);
            const message = error instanceof Error ? error.message : "Block failed.";
            emit({ status: "failure", message, durationMs: env.now() - started });
            if (!block.error) throw error;
            variables.error = { message, blockId: block.id };
            port = "error";
            targets = undefined;
        }
        pending.push(...(targets ?? edgeTargets(block[port])).toReversed());
    }
    return variables.result;
}

export function updateSavedValue(current: unknown, operation: string, input: unknown): unknown {
    if (operation === "read-value") return current;
    if (operation === "delete-value") return undefined;
    if (operation === "increment-value") {
        const number = current ?? 0;
        if (typeof number !== "number" || !Number.isFinite(number) || typeof input !== "number" || !Number.isFinite(input)) throw new Error("A saved counter must contain a finite number.");
        return number + input;
    }
    return structuredClone(input);
}
