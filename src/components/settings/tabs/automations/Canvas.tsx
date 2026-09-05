/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { DeleteIcon } from "@components/Icons";
import { React } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { BLOCK_ICONS, blockDefinition } from "./blocks";
import { removeBlocks } from "./editorState";
import {
    edgeMidpoint,
    edgePath,
    GRID,
    HEADER_HEIGHT,
    inputAnchor,
    labelledPorts,
    NODE_WIDTH,
    nodeHeight,
    nodePosition,
    outputAnchor,
    type Point,
    portOffset,
    ROW_HEIGHT,
} from "./layout";
import {
    type Automation,
    type AutomationBlock,
    type AutomationBlockType,
    type AutomationPort,
    edgeTargets,
    outputPorts,
    portLabel,
    removeEdgeTarget,
} from "./model";

const CANVAS_PAD = 600;

export type CanvasDrag =
    | { kind: "node"; id: string; nodeX: number; nodeY: number; }
    | { kind: "edge"; id: string; port: AutomationPort; }
    | { kind: "new"; type: AutomationBlockType; }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number; };

/** Where the canvas is looking. Pan is a translation, so it works at any zoom. */
export interface CanvasView {
    x: number;
    y: number;
    zoom: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

export function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export interface Insertion {
    id: string;
    port: AutomationPort;
    at?: Point;
}

interface CanvasProps {
    automation: Automation;
    selectedId: string | null;
    selectedIds: Set<string>;
    insertion: Insertion | null;
    onToggleSelection(id: string): void;
    setSelectedId(id: string | null): void;
    setAutomation(automation: Automation): void;
    onDragStart(source: CanvasDrag, event: ReactPointerEvent<HTMLElement>): void;
    surfaceRef: { current: HTMLDivElement | null; };
    drag: CanvasDrag | null;
    pointer: Point | null;
    dropTarget: string | null;
    view: CanvasView;
    onZoomAt(delta: number, clientX: number, clientY: number): void;
    onPan(dx: number, dy: number): void;
    onZoomStep(zoomIn: boolean): void;
    onFit(): void;
    onTidy(): void;
    onResetZoom(): void;
}

export function Canvas({ automation, selectedId, selectedIds, insertion, onToggleSelection, setSelectedId, setAutomation, onDragStart, surfaceRef, drag, pointer, dropTarget, view, onZoomAt, onPan, onZoomStep, onFit, onTidy, onResetZoom }: CanvasProps) {
    const { blocks } = automation;
    const byId = new Map(blocks.map(block => [block.id, block]));

    const extent = blocks.reduce((size, block) => {
        const { x, y } = nodePosition(block);
        return { width: Math.max(size.width, x + NODE_WIDTH), height: Math.max(size.height, y + nodeHeight(block.type)) };
    }, { width: 900, height: 520 });

    const disconnect = (id: string, port: AutomationPort, targetId: string) => setAutomation({
        ...automation,
        blocks: blocks.map(block => block.id === id ? { ...block, [port]: removeEdgeTarget(block[port], targetId) } : block),
    });
    const removeCase = (id: string, caseIndex: number) => setAutomation({
        ...automation,
        blocks: blocks.map(block => block.id === id ? { ...block, config: { ...block.config, cases: block.config.cases?.filter((_route, index) => index !== caseIndex) } } : block),
    });
    const remove = (id: string) => {
        setAutomation(removeBlocks(automation, new Set([id])));
        if (selectedId === id) setSelectedId(null);
    };

    const bottomOf = (block: AutomationBlock) => nodePosition(block).y + nodeHeight(block.type);
    const edges = blocks.flatMap(block => [
        ...outputPorts(block.type).flatMap(port => edgeTargets(block[port]).flatMap(targetId => {
            const target = byId.get(targetId);
            return target ? [{ block, port, target, caseIndex: -1 }] : [];
        })),
        ...(block.config.cases ?? []).flatMap((route, caseIndex) => {
            const target = byId.get(route.target);
            return target ? [{ block, port: "next" as const, target, caseIndex }] : [];
        }),
    ]).map(edge => {
        const from = outputAnchor(edge.block, edge.port);
        const to = inputAnchor(edge.target);
        const below = Math.max(bottomOf(edge.block), bottomOf(edge.target)) + 30;
        return { ...edge, from, to, path: edgePath(from, to, below), mid: edgeMidpoint(from, to, below) };
    });

    const liveEdge = drag?.kind === "edge" && pointer
        ? (() => {
            const source = byId.get(drag.id);
            if (!source) return null;
            const from = outputAnchor(source, drag.port);
            return edgePath(from, pointer, Math.max(bottomOf(source), pointer.y) + 30);
        })()
        : null;

    const linked = (block: AutomationBlock, port: AutomationPort) => edgeTargets(block[port]).length > 0 || (port === "next" && (block.config.cases?.length ?? 0) > 0);

    return <div
        className={`vc-ab-canvas${drag?.kind === "pan" ? " panning" : ""}`}
        ref={surfaceRef}
        style={{ "--ab-grid": `${GRID * view.zoom}px`, "--ab-major": `${GRID * 5 * view.zoom}px`, "--ab-grid-x": `${view.x}px`, "--ab-grid-y": `${view.y}px` } as React.CSSProperties}
        onWheel={event => {
            if (event.ctrlKey || event.metaKey) onZoomAt(event.deltaY, event.clientX, event.clientY);
            else onPan(-event.deltaX, -event.deltaY);
        }}
        onPointerDown={event => {
            if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("vc-ab-canvas-world")) {
                setSelectedId(null);
                onDragStart({ kind: "pan", startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y }, event);
            }
        }}
    >
        <div
            className="vc-ab-canvas-world"
            style={{
                width: extent.width + CANVAS_PAD,
                height: extent.height + CANVAS_PAD,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                transformOrigin: "0 0",
            }}
        >
            {!blocks.length && <div className="vc-ab-canvas-empty">
                <strong>Add your first step</strong>
                <span>Click a block in the list on the left, or drag one onto this grid.</span>
                <span>Then drag from the dot on its right side to the next block to connect them.</span>
            </div>}
            <svg className="vc-ab-edges" width={extent.width + CANVAS_PAD} height={extent.height + CANVAS_PAD}>
                {edges.map(edge => {
                    const active = selectedId === edge.block.id || selectedId === edge.target.id;
                    const label = edge.caseIndex < 0 ? portLabel(edge.block.type, edge.port) : `Match ${edge.block.config.cases?.[edge.caseIndex]?.value || "…"}`;
                    return <g key={`${edge.block.id}-${edge.port}-${edge.target.id}-${edge.caseIndex}`} className={`vc-ab-edge ${edge.port}${active ? " active" : ""}`}>
                        <path className="vc-ab-edge-hit" d={edge.path}><title>{label}</title></path>
                        <path className="vc-ab-edge-line" d={edge.path} />
                        <g
                            className="vc-ab-edge-remove"
                            transform={`translate(${edge.mid.x} ${edge.mid.y})`}
                            onClick={() => edge.caseIndex < 0 ? disconnect(edge.block.id, edge.port, edge.target.id) : removeCase(edge.block.id, edge.caseIndex)}
                        >
                            <title>Remove this connection</title>
                            <circle r={10} />
                            <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" />
                        </g>
                    </g>;
                })}
                {liveEdge && <path className="vc-ab-edge-live" d={liveEdge} />}
            </svg>

            {blocks.map(block => {
                const item = blockDefinition(block.type);
                const { x, y } = nodePosition(block);
                const ports = outputPorts(block.type);
                const rows = labelledPorts(block.type);
                const Icon = BLOCK_ICONS[item.category];
                const dragging = drag?.kind === "node" && drag.id === block.id;
                const isEntry = automation.entryId === block.id;
                return <article
                    key={block.id}
                    className={`vc-ab-node ${item.category}${selectedIds.has(block.id) ? " selected" : ""}${dragging ? " dragging" : ""}${dropTarget === block.id ? " droppable" : ""}`}
                    style={{ left: x, top: y, width: NODE_WIDTH, height: nodeHeight(block.type) }}
                    data-node-id={block.id}
                    tabIndex={0}
                    aria-label={item.label}
                    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(block.id); } }}
                    onPointerDown={event => {
                        if ((event.target as HTMLElement).closest(".vc-ab-port, .vc-ab-node-delete")) return;
                        if (event.ctrlKey || event.metaKey || event.shiftKey) { onToggleSelection(block.id); return; }
                        setSelectedId(block.id);
                        onDragStart({ kind: "node", id: block.id, nodeX: x, nodeY: y }, event);
                    }}
                >
                    {isEntry && <span className="vc-ab-node-start">Start</span>}
                    <span className="vc-ab-port in" style={{ top: HEADER_HEIGHT / 2 }} />
                    <header className="vc-ab-node-head" style={{ height: HEADER_HEIGHT }}>
                        <span className="vc-ab-node-icon"><Icon width={16} height={16} /></span>
                        <span className="vc-ab-node-copy">
                            <strong>{item.label}</strong>
                            <small>{summarize(block)}</small>
                        </span>
                        <button type="button" className="vc-ab-node-delete" aria-label={`Delete ${item.label}`} onClick={() => remove(block.id)}><DeleteIcon width={14} height={14} /></button>
                    </header>
                    {rows.map(port => <div key={port} className={`vc-ab-node-row ${port}`} style={{ height: ROW_HEIGHT }}><em>{portLabel(block.type, port)}</em></div>)}
                    {ports.map(port => {
                        const offset = portOffset(block.type, port);
                        const pending = insertion?.id === block.id && insertion.port === port;
                        return <span
                            key={port}
                            className={`vc-ab-out ${port}${linked(block, port) ? " linked" : ""}${pending ? " pending" : ""}`}
                            style={{ top: offset.y }}
                        >
                            <span
                                className={`vc-ab-port out ${port}`}
                                title={port === "error" ? "If this step fails. Drag to connect." : `${portLabel(block.type, port)}. Drag to connect.`}
                                onPointerDown={event => {
                                    event.stopPropagation();
                                    onDragStart({ kind: "edge", id: block.id, port }, event);
                                }}
                            />
                        </span>;
                    })}
                </article>;
            })}
        </div>

        <div className="vc-ab-canvas-tools">
            <div className="vc-ab-zoom">
                <button type="button" aria-label="Zoom out" onClick={() => onZoomStep(false)}>&minus;</button>
                <button type="button" className="vc-ab-zoom-level" title="Back to 100%" onClick={onResetZoom}>{Math.round(view.zoom * 100)}%</button>
                <button type="button" aria-label="Zoom in" onClick={() => onZoomStep(true)}>+</button>
            </div>
            <Button size="small" variant="secondary" title="Show the whole automation" onClick={onFit}>Fit</Button>
            <Button size="small" variant="secondary" title="Line the blocks up neatly from left to right" onClick={onTidy}>Tidy up</Button>
        </div>
    </div>;
}

/** The block's most important settings in plain words, so a node reads at a glance. */
export function summarize(block: AutomationBlock): string {
    const { config } = block;
    const quote = (value: string | undefined, fallback: string) => value?.trim() ? `\u201c${value.trim()}\u201d` : fallback;
    const verbs: Record<string, string> = { equals: "is", "not-equals": "is not", contains: "contains", greater: "is more than", less: "is less than", regex: "matches" };
    const seconds = (value: number | undefined, fallback: number) => `${value ?? fallback} second${(value ?? fallback) === 1 ? "" : "s"}`;
    switch (block.type) {
        case "condition": return `${config.sourceVariable?.trim() || "the message"} ${verbs[config.operator ?? "equals"]} ${quote(config.compareValue, "\u2026")}`;
        case "chance": return `${config.chancePercent ?? 50}% of the time`;
        case "repeat": return `${config.repeatCount ?? 2} times`;
        case "for-each": return `Every item, saved as ${config.variable || "item"}`;
        case "delay": return `Wait ${seconds(config.durationSeconds, 1)}`;
        case "wait-reply": case "wait-dm": return `${config.matchText?.trim() ? `For ${quote(config.matchText, "")}, ` : ""}up to ${seconds(config.timeoutSeconds, 60)}`;
        case "run-command": return config.commandName ? `/${config.commandName}` : "No command chosen yet";
        case "switch": return `${config.cases?.length ?? 0} route${config.cases?.length === 1 ? "" : "s"}`;
        case "notify": return [config.name, config.content].filter(value => value?.trim()).join(": ") || "No text yet";
        case "set-variable": return `${config.variable || "value"} = ${quote(config.value, "empty")}`;
        case "fetch-messages": case "fetch-unread": case "fetch-dm": case "fetch-mentions": return `Reads ${config.limit ?? 25}, saved as ${config.variable || "messages"}`;
        case "react-message": case "remove-reaction": return config.emoji || "No emoji yet";
        case "call-workflow": return config.workflowId ? "Runs another automation" : "No automation chosen yet";
        case "spotify-volume": return `${config.amount ?? 50}%`;
        case "spotify-seek": return `${config.durationSeconds ?? 30} seconds in`;
    }
    const text = config.content?.trim() || config.value?.trim() || config.matchText?.trim();
    if (text) return text.length > 70 ? `${text.slice(0, 70)}\u2026` : text;
    if (config.aiEnabled) return "Written by AI";
    if (config.variable?.trim() && config.variable !== "lastMessage") return `Saved as ${config.variable.trim()}`;
    return blockDefinition(block.type).description;
}
