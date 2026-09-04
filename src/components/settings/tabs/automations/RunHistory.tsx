/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { React } from "@webpack/common";

import { type AutomationSnapshot, cancelAutomation, getAutomationSnapshot, subscribeAutomationState } from "./engine";

export function WorkflowRunHistory({ workflowId }: { workflowId: string; }) {
    const current = React.useSyncExternalStore(subscribeAutomationState, getAutomationSnapshot);
    const logs = current.logs.filter(log => log.automationId === workflowId);
    const runs = current.runs.filter(run => run.workflowId === workflowId);
    return <details className="vc-ab-advanced">
        <summary>{runs.length ? `${runs.length} active or queued runs` : logs[0]?.message ?? "No runs yet"}</summary>
        <RunHistory current={{ ...current, logs, runs }} />
    </details>;
}

export function RunHistory({ current }: { current: AutomationSnapshot; }) {
    const runs = new Map<string, AutomationSnapshot["logs"]>();
    for (const log of current.logs) {
        const id = log.runId ?? "legacy";
        const entries = runs.get(id) ?? [];
        entries.push(log);
        runs.set(id, entries);
    }
    return <section className="vc-automations-panel-section">
        <Heading tag="h2">Run history</Heading>
        {current.runs.map(run => <div className="vc-ab-connection-target" key={run.id}>
            <span>{current.automations.find(a => a.id === run.workflowId)?.name} · {run.status}</span>
            <Button size="small" variant="secondary" onClick={() => cancelAutomation(run.workflowId)}>Cancel workflow runs</Button>
        </div>)}
        {!runs.size && <p>No runs yet. Use Test in the editor to try a workflow with sample data.</p>}
        {[...runs].slice(0, 100).map(([id, entries]) => <details className="vc-ab-advanced" key={id}>
            <summary>{entries[0].automationName} · {entries[0].message} · {new Date(entries[0].timestamp).toLocaleString()}</summary>
            {entries.toReversed().map(event => <article className="vc-ab-step" key={event.id}>
                <strong>{event.blockLabel ?? "Run"} · {event.status}{event.port ? ` · ${event.port}` : ""}</strong>
                <span>{event.message}{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ""}</span>
                {event.usage && <span>AI usage: {event.usage}</span>}
                {event.inputPreview && <details><summary>Input preview, this session only</summary><pre className="vc-ab-output-preview">{event.inputPreview}</pre></details>}
                {event.preview && <details><summary>Output preview, this session only</summary><pre className="vc-ab-output-preview">{event.preview}</pre></details>}
            </article>)}
        </details>)}
    </section>;
}
