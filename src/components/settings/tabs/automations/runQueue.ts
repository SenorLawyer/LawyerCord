/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Automation } from "./model";

export interface QueuedRun {
    id: string;
    workflowId: string;
    status: "queued" | "running";
}

interface Job {
    id: string;
    workflow: Automation;
    controller: AbortController;
    execute(signal: AbortSignal, id: string): Promise<unknown>;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

export function createRunQueue(onChange: () => void, now: () => number = Date.now) {
    const pending: Job[] = [];
    const active = new Map<string, Job>();
    const lastStarted = new Map<string, number>();
    let limit = 4;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: QueuedRun[] = [];
    const changed = () => {
        snapshot = [...active.values()].map<QueuedRun>(job => ({ id: job.id, workflowId: job.workflow.id, status: "running" as const })).concat(pending.map(job => ({ id: job.id, workflowId: job.workflow.id, status: "queued" as const })));
        onChange();
    };
    const pump = () => {
        clearTimeout(timer);
        timer = undefined;
        let wakeAt = Infinity;
        for (let index = 0; index < pending.length && active.size < limit;) {
            const job = pending[index];
            const count = [...active.values()].filter(item => item.workflow.id === job.workflow.id).length;
            const capacity = job.workflow.runMode === "parallel" ? Math.max(1, job.workflow.concurrency ?? 1) : 1;
            if (count >= capacity) { index++; continue; }
            const next = (lastStarted.get(job.workflow.id) ?? -Infinity) + (job.workflow.cooldownSeconds ?? 0) * 1000;
            if (next > now()) { wakeAt = Math.min(wakeAt, next); index++; continue; }
            pending.splice(index, 1);
            active.set(job.id, job);
            lastStarted.set(job.workflow.id, now());
            void Promise.resolve().then(() => job.execute(job.controller.signal, job.id)).then(job.resolve, (error: unknown) => job.reject(error instanceof Error ? error : new Error("Run failed."))).finally(() => {
                active.delete(job.id);
                pump();
            });
        }
        if (Number.isFinite(wakeAt)) timer = setTimeout(pump, Math.min(2_147_000_000, Math.max(1, wakeAt - now())));
        changed();
    };
    return {
        snapshot: () => snapshot,
        setLimit(value: number) {
            if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error("Choose between 1 and 32 active runs.");
            limit = value;
            pump();
        },
        enqueue(workflow: Automation, execute: Job["execute"]): Promise<unknown> {
            const queued = pending.filter(job => job.workflow.id === workflow.id).length;
            const running = [...active.values()].some(job => job.workflow.id === workflow.id);
            if ((workflow.runMode ?? "skip") === "skip" && (running || queued > 0)) return Promise.reject(new Error("Trigger skipped because this workflow is already running."));
            if (queued >= (workflow.queueLimit ?? 50) && (running || active.size >= limit) || pending.length >= 200) return Promise.reject(new Error("Run queue is full. The newest trigger was rejected."));
            return new Promise((resolve, reject) => {
                pending.push({ id: crypto.randomUUID(), workflow: structuredClone(workflow), controller: new AbortController(), execute, resolve, reject });
                pump();
            });
        },
        cancel(workflowId?: string) {
            for (let index = pending.length - 1; index >= 0; index--) {
                if (workflowId && pending[index].workflow.id !== workflowId) continue;
                pending.splice(index, 1)[0].reject(new Error("Queued run cancelled."));
            }
            for (const job of active.values()) if (!workflowId || job.workflow.id === workflowId) job.controller.abort(new Error("Run cancelled."));
            clearTimeout(timer);
            timer = undefined;
            pump();
        },
    };
}
