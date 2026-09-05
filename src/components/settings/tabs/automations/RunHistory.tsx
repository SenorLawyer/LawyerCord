/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { moment, React } from "@webpack/common";

import { type AutomationSnapshot, cancelAutomation, getAutomationSnapshot, subscribeAutomationState } from "./engine";

export function WorkflowRunHistory({ workflowId }: { workflowId: string; }) {
    const current = React.useSyncExternalStore(subscribeAutomationState, getAutomationSnapshot);
    const logs = current.logs.filter(log => log.automationId === workflowId);
    const runs = current.runs.filter(run => run.workflowId === workflowId);
    return <RunHistory current={{ ...current, logs, runs }} compact />;
}

export function RunHistory({ current, compact }: { current: AutomationSnapshot; compact?: boolean; }) {
    const runs = new Map<string, AutomationSnapshot["logs"]>();
    for (const log of current.logs) {
        const id = log.runId ?? "legacy";
        runs.set(id, [...runs.get(id) ?? [], log]);
    }
    return <div className={`vc-automations-runs${compact ? " compact" : ""}`}>
        {current.runs.map(run => <div className="vc-automations-run-live" key={run.id}>
            <span className="vc-automations-dot running" />
            <span>{current.automations.find(a => a.id === run.workflowId)?.name ?? "Automation"} is {run.status === "queued" ? "waiting to run" : "running"}</span>
            <Button size="small" variant="secondary" onClick={() => cancelAutomation(run.workflowId)}>Stop</Button>
        </div>)}
        {!runs.size && !current.runs.length && <p className="vc-automations-empty">Nothing has run yet. Open an automation and press Test to try it with sample data.</p>}
        {[...runs].slice(0, 100).map(([id, entries]) => {
            const first = entries[0];
            const status = entries.some(entry => entry.status === "failure") ? "failure" : first.status;
            return <details className="vc-automations-run" key={id}>
                <summary>
                    <span className={`vc-automations-dot ${status}`} />
                    <span className="vc-automations-run-title"><strong>{first.automationName}</strong><span>{first.message}</span></span>
                    <time title={new Date(first.timestamp).toLocaleString()}>{moment(first.timestamp).fromNow()}</time>
                </summary>
                <ol className="vc-automations-run-steps">
                    {entries.toReversed().map(event => <li className={`vc-automations-run-step ${event.status}`} key={event.id}>
                        <span className={`vc-automations-dot ${event.status}`} />
                        <div>
                            <strong>{event.blockLabel ?? "Run"}{event.port ? ` → ${event.port}` : ""}</strong>
                            <span>{event.message}{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ""}</span>
                            {event.usage && <span>AI usage: {event.usage}</span>}
                            {event.inputPreview && <details><summary>What went in</summary><pre>{event.inputPreview}</pre></details>}
                            {event.preview && <details><summary>What came out</summary><pre>{event.preview}</pre></details>}
                        </div>
                    </li>)}
                </ol>
            </details>;
        })}
    </div>;
}
