/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { React } from "@webpack/common";

import { blockDefinition } from "./blocks";
import { type Automation, type AutomationPort, edgeTargets, outputPorts, portLabel } from "./model";
import { compileWorkflow } from "./workflow";

export function workflowOutline(workflow: Automation) {
    const { byId, entryId } = compileWorkflow(workflow);
    const rows: { id: string; depth: number; route: string; link: boolean; key: string; }[] = [];
    const seen = new Set<string>();
    const visit = (root: string, route: string) => {
        const pending = [{ id: root, depth: 0, route }];
        while (pending.length) {
            const row = pending.pop();
            if (!row || !byId.has(row.id)) continue;
            rows.push({ ...row, key: String(rows.length), link: seen.has(row.id) });
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            const block = byId.get(row.id);
            if (!block) continue;
            const routes = outputPorts(block.type).flatMap(port => edgeTargets(block[port]).map(id => ({ id, route: portLabel(block.type, port), depth: row.depth + (port === "next" && edgeTargets(block.next).length <= 1 ? 0 : 1) })));
            routes.push(...(block.config.cases ?? []).map(item => ({ id: item.target, route: item.value, depth: row.depth + 1 })));
            pending.push(...routes.toReversed());
        }
    };
    if (entryId) visit(entryId, "Start");
    for (const block of workflow.blocks) if (!seen.has(block.id)) visit(block.id, "Disconnected");
    return rows;
}

interface StepViewProps {
    automation: Automation;
    selectedId: string | null;
    onSelect(id: string): void;
    onInsert(id: string, port: AutomationPort): void;
}

export function StepView({ automation, selectedId, onSelect, onInsert }: StepViewProps) {
    const { byId } = compileWorkflow(automation);
    return <section className="vc-ab-steps" aria-label="Workflow steps">
        <Heading tag="h2">Steps</Heading>
        {!automation.blocks.length && <p>Add a block from the library to begin.</p>}
        {workflowOutline(automation).map(row => {
            const block = byId.get(row.id);
            if (!block) return null;
            return <article className={selectedId === row.id ? "vc-ab-step selected" : "vc-ab-step"} key={row.key} style={{ marginInlineStart: Math.min(row.depth, 8) * 20 }}>
                <small>{row.route}{row.link ? " · Link to existing step" : ""}</small>
                <Button variant="secondary" onClick={() => onSelect(row.id)}>{blockDefinition(block.type).label}{block.config.variable ? ` → ${block.config.variable}` : ""}</Button>
                {!row.link && <div className="vc-ab-step-actions">{outputPorts(block.type).map(port => <Button key={port} size="small" variant="secondary" onClick={() => onInsert(row.id, port)}>Insert on {portLabel(block.type, port).toLowerCase()}</Button>)}</div>}
            </article>;
        })}
    </section>;
}
