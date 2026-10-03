/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface RegexResult {
    matches: boolean[];
    text: string;
}

interface Job {
    id: number;
    pattern: string;
    texts: string[];
    extract: boolean;
    signal?: AbortSignal;
    finish(result?: RegexResult, error?: Error): void;
}

const source = `onmessage = ({ data }) => {
    try {
        const regex = new RegExp(data.pattern, "i");
        const match = data.extract ? regex.exec(data.texts[0]) : null;
        postMessage({ id: data.id, matches: data.extract ? [] : data.texts.map(text => regex.test(text)), text: match ? match[1] ?? match[0] : "" });
    } catch (error) { postMessage({ id: data.id, error: error.message }); }
};`;
export function createRegexEvaluator() {
    const pending: Job[] = [];
    let sequence = 0;
    let retainedCharacters = 0;
    let worker: Worker | undefined;
    let active: Job | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function terminate(): void {
        worker?.terminate();
        worker = undefined;
    }

    function pump(): void {
        if (active || !pending.length) return;
        const job = active = pending.shift();
        if (!job) return;
        if (job.signal?.aborted) {
            job.finish(undefined, job.signal.reason instanceof Error ? job.signal.reason : new Error("Run cancelled."));
            return;
        }
        try {
            if (!worker) {
                const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
                try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
                const owner = worker;
                worker.onmessage = (event: MessageEvent<RegexResult & { id: number; error?: string; }>) => {
                    if (worker !== owner || active?.id !== event.data.id) return;
                    if (event.data.error) active?.finish(undefined, new Error(event.data.error));
                    else active?.finish(event.data);
                };
                worker.onerror = event => {
                    event.preventDefault();
                    if (worker !== owner) return;
                    terminate();
                    active?.finish(undefined, new Error("The regular expression worker could not run."));
                };
            }
            timer = setTimeout(() => {
                terminate();
                job.finish(undefined, new Error("The regular expression took longer than one second. Simplify the pattern or reduce its input."));
            }, 1_000);
            worker.postMessage({ id: job.id, pattern: job.pattern, texts: job.texts, extract: job.extract });
        } catch {
            terminate();
            job.finish(undefined, new Error("The regular expression worker is unavailable in this client."));
        }
    }

    function evaluateRegex(pattern: string, texts: string[], extract = false, signal?: AbortSignal): Promise<RegexResult> {
        if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Run cancelled."));
        if (pattern.length > 4_096 || texts.length > 10_000 || texts.some(text => text.length > 100_000) || texts.reduce((total, text) => total + text.length, 0) > 1_000_000)
            return Promise.reject(new Error("Regular expressions support a pattern of up to 4096 characters, 10000 values, 100000 characters per value and 1000000 characters in total."));
        const characters = pattern.length + texts.reduce((total, text) => total + text.length, 0);
        if (retainedCharacters + characters > 4_000_000) return Promise.reject(new Error("Queued regular expressions exceed 4000000 characters. Try again after the current runs finish."));
        if (pending.length >= 64) return Promise.reject(new Error("Too many regular expression requests are queued. Try again after the current runs finish."));
        return new Promise((resolve, reject) => {
            let finished = false;
            retainedCharacters += characters;
            const cancel = () => {
                if (active === job) terminate();
                job.finish(undefined, signal?.reason instanceof Error ? signal.reason : new Error("Run cancelled."));
            };
            const job: Job = {
                id: ++sequence, pattern, texts, extract, signal,
                finish(result, error) {
                    if (finished) return;
                    finished = true;
                    retainedCharacters -= characters;
                    signal?.removeEventListener("abort", cancel);
                    if (active === job) { clearTimeout(timer); timer = undefined; active = undefined; }
                    else {
                        const index = pending.indexOf(job);
                        if (index >= 0) pending.splice(index, 1);
                    }
                    if (error) reject(error);
                    else if (result) resolve(result);
                    pump();
                }
            };
            signal?.addEventListener("abort", cancel, { once: true });
            pending.push(job);
            pump();
        });
    }

    function stopRegexWorker(): void {
        terminate();
        const jobs = [...pending];
        pending.length = 0;
        if (active) jobs.unshift(active);
        for (const job of jobs) job.finish(undefined, new Error("Regular expression evaluation stopped."));
    }

    return { evaluateRegex, stopRegexWorker };
}
