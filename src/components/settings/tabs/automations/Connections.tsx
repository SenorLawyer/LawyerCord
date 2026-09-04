/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { React } from "@webpack/common";

import { blockDefinition } from "./blocks";
import { SelectField } from "./fields";
import { addEdgeTarget, type Automation, type AutomationBlock, type AutomationPort, edgeTargets, outputPorts, portLabel, removeEdgeTarget } from "./model";

export function Connections({ automation, block, onChange, onInsert }: { automation: Automation; block: AutomationBlock; onChange(value: Automation): void; onInsert(port: AutomationPort): void; }) {
    const [expanded, setExpanded] = React.useState<AutomationPort[]>([]);
    const change = (port: AutomationPort, target: string, remove = false) => onChange({
        ...automation,
        blocks: automation.blocks.map(item => item.id === block.id ? { ...item, [port]: remove ? removeEdgeTarget(item[port], target) : addEdgeTarget(item[port], target) } : item),
    });
    return <section className="vc-ab-connections" aria-label="Edit connections">
        {outputPorts(block.type).map(port => <details key={port} onToggle={event => {
            const { open } = event.currentTarget;
            setExpanded(previous => previous.includes(port) === open ? previous : open ? [...previous, port] : previous.filter(item => item !== port));
        }}>
            <summary>{portLabel(block.type, port)} · {edgeTargets(block[port]).length} connections</summary>
            {expanded.includes(port) && <>{edgeTargets(block[port]).map(id => {
                const target = automation.blocks.find(item => item.id === id);
                return <div className="vc-ab-connection-target" key={id}><span>{target ? blockDefinition(target.type).label : "Missing block"}</span><Button size="small" variant="dangerSecondary" onClick={() => change(port, id, true)}>Disconnect</Button></div>;
            })}
            <SelectField label="Connect to" value="" options={[{ label: "Choose a block", value: "" }, ...automation.blocks.filter(item => item.id !== block.id && !edgeTargets(block[port]).includes(item.id)).map(item => ({ label: item.config.variable || blockDefinition(item.type).label, value: item.id }))]} onChange={target => { if (target) change(port, String(target)); }} />
            <Button size="small" variant="secondary" onClick={() => onInsert(port)}>Insert a block</Button></>}
        </details>)}
    </section>;
}
