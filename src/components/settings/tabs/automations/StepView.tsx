/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { BLOCK_ICONS, blockDefinition } from "./blocks";
import { summarize } from "./Canvas";
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
            const routes = outputPorts(block.type).flatMap(port => edgeTargets(block[port]).map(id => ({ id, route: port === "error" ? "If it fails" : portLabel(block.type, port), depth: row.depth + (port === "next" && edgeTargets(block.next).length <= 1 ? 0 : 1) })));
            routes.push(...(block.config.cases ?? []).map(item => ({ id: item.target, route: `Matches ${item.value || "…"}`, depth: row.depth + 1 })));
            pending.push(...routes.toReversed());
        }
    };
    if (entryId) visit(entryId, "Start");
    for (const block of workflow.blocks) if (!seen.has(block.id)) visit(block.id, "Not connected");
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
    return <section className="vc-ab-steps" aria-label="Steps">
        <div className="vc-ab-steps-head">
            <span className="vc-ab-panel-label">Steps in order</span>
            <span className="vc-ab-field-description">The same automation, written out. Click a step to edit it.</span>
        </div>
        {!automation.blocks.length && <p className="vc-ab-field-description">Add a block from the list on the left to begin.</p>}
        {workflowOutline(automation).map((row, index) => {
            const block = byId.get(row.id);
            if (!block) return null;
            const item = blockDefinition(block.type);
            const Icon = BLOCK_ICONS[item.category];
            return <article className={`vc-ab-step ${item.category}${selectedId === row.id ? " selected" : ""}${row.link ? " link" : ""}`} key={row.key} style={{ marginInlineStart: Math.min(row.depth, 8) * 28 }}>
                <small className={`vc-ab-step-route ${row.route === "Not connected" ? "loose" : ""}`}>{row.route}{row.link ? " · Link to existing step" : ""}</small>
                <button type="button" className="vc-ab-step-main" onClick={() => onSelect(row.id)}>
                    <span className="vc-ab-step-number">{index + 1}</span>
                    <span className="vc-ab-node-icon"><Icon width={14} height={14} /></span>
                    <span className="vc-ab-step-copy"><strong>{item.label}</strong><span>{summarize(block)}</span></span>
                </button>
                {!row.link && outputPorts(block.type).length > 0 && <div className="vc-ab-step-actions">
                    {outputPorts(block.type).map(port => <button type="button" key={port} className={`vc-ab-chip-add ${port}`} onClick={() => onInsert(row.id, port)}>+ {port === "error" ? "If it fails" : portLabel(block.type, port)}</button>)}
                </div>}
            </article>;
        })}
    </section>;
}
