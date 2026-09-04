/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DeleteIcon } from "@components/Icons";
import { React } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { BLOCK_ICONS, blockDefinition } from "./blocks";
import { removeBlocks } from "./editorState";
import {
    type Automation,
    type AutomationBlock,
    type AutomationBlockType,
    edgeTargets,
    outputPorts,
    portLabel,
    removeEdgeTarget,
} from "./model";

export const GRID = 20;
export const NODE_WIDTH = 240;
/** Node geometry is fixed so edge anchors land exactly on the rendered port dots. */
const HEADER_HEIGHT = 52;
const BRANCH_ROW = 26;
const CANVAS_PAD = 400;

export function nodeHeight(type: AutomationBlockType): number {
    const ports = outputPorts(type);
    return HEADER_HEIGHT + (ports.length > 1 ? ports.length * BRANCH_ROW : 0);
}

/** Vertical centre of a port, relative to the node's top edge. */
function portOffset(type: AutomationBlockType, index: number): number {
    return outputPorts(type).length > 1
        ? HEADER_HEIGHT + index * BRANCH_ROW + BRANCH_ROW / 2
        : HEADER_HEIGHT / 2;
}

export type CanvasDrag =
    | { kind: "node"; id: string; nodeX: number; nodeY: number; }
    | { kind: "edge"; id: string; port: "next" | "alternate" | "error"; }
    | { kind: "new"; type: AutomationBlockType; }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number; };

export interface PendingDrop {
    type: AutomationBlockType;
    x: number;
    y: number;
}

function snap(value: number): number {
    return Math.round(value / GRID) * GRID;
}

export function nodePosition(block: AutomationBlock): { x: number; y: number; } {
    return block.position ?? { x: 80, y: 60 };
}

function inputAnchor(block: AutomationBlock) {
    const { x, y } = nodePosition(block);
    return { x, y: y + HEADER_HEIGHT / 2 };
}

function outputAnchor(block: AutomationBlock, port: "next" | "alternate" | "error") {
    const { x, y } = nodePosition(block);
    return { x: x + NODE_WIDTH, y: y + portOffset(block.type, outputPorts(block.type).indexOf(port)) };
}

function curve(from: { x: number; y: number; }, to: { x: number; y: number; }): string {
    const distance = Math.max(60, Math.abs(to.x - from.x) * 0.6);
    return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
}

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

/** The box every node occupies, used for fitting the view to the workflow. */
export function graphBounds(blocks: AutomationBlock[]) {
    if (!blocks.length) return { x: 0, y: 0, width: 900, height: 520 };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const block of blocks) {
        const { x, y } = nodePosition(block);
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + NODE_WIDTH);
        bottom = Math.max(bottom, y + nodeHeight(block.type));
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}

interface CanvasProps {
    automation: Automation;
    selectedId: string | null;
    selectedIds: Set<string>;
    onToggleSelection(id: string): void;
    setSelectedId(id: string | null): void;
    setAutomation(automation: Automation): void;
    onNodeDragStart(source: CanvasDrag, event: ReactPointerEvent<HTMLElement>): void;
    surfaceRef: { current: HTMLDivElement | null; };
    drag: CanvasDrag | null;
    pointer: { x: number; y: number; } | null;
    dropTarget: string | null;
    view: CanvasView;
    onZoomAt(delta: number, clientX: number, clientY: number): void;
}

export function Canvas({ automation, selectedId, selectedIds, onToggleSelection, setSelectedId, setAutomation, onNodeDragStart, surfaceRef, drag, pointer, dropTarget, view, onZoomAt }: CanvasProps) {
    const { blocks } = automation;
    const byId = new Map(blocks.map(block => [block.id, block]));

    const extent = blocks.reduce((size, block) => {
        const { x, y } = nodePosition(block);
        return { width: Math.max(size.width, x + NODE_WIDTH), height: Math.max(size.height, y + nodeHeight(block.type)) };
    }, { width: 900, height: 520 });

    // Removes just the line you clicked, leaving the port's other targets alone.
    const disconnect = (id: string, port: "next" | "alternate" | "error", targetId: string) => setAutomation({
        ...automation,
        blocks: blocks.map(block => block.id === id ? { ...block, [port]: removeEdgeTarget(block[port], targetId) } : block),
    });

    const remove = (id: string) => {
        setAutomation(removeBlocks(automation, new Set([id])));
        if (selectedId === id) setSelectedId(null);
    };

    // A port can point at several blocks, so every target gets its own line.
    const edges = blocks.flatMap(block => outputPorts(block.type).flatMap(port =>
        edgeTargets(block[port]).flatMap(targetId => {
            const target = byId.get(targetId);
            if (!target) return [];
            return [{ block, port, targetId, from: outputAnchor(block, port), to: inputAnchor(target), caseIndex: -1 }];
        }))).concat(blocks.flatMap(block => (block.config.cases ?? []).flatMap((route, caseIndex) => {
        const target = byId.get(route.target);
        return target ? [{ block, port: "next" as const, targetId: route.target, from: outputAnchor(block, "next"), to: inputAnchor(target), caseIndex }] : [];
    })));

    const liveEdge = drag?.kind === "edge" && pointer
        ? { from: outputAnchor(byId.get(drag.id) ?? blocks[0], drag.port), to: pointer }
        : null;

    return <div
        className="vc-ab-canvas"
        ref={surfaceRef}
        // The dot grid is painted on the viewport, so it has to pan and scale with the world.
        style={{ backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onWheel={event => onZoomAt(event.deltaY, event.clientX, event.clientY)}
        onPointerDown={event => {
            if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("vc-ab-canvas-world")) {
                setSelectedId(null);
                onNodeDragStart({ kind: "pan", startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y }, event);
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
                <strong>Start your workflow</strong>
                <span>Click a block on the left to drop one in, or drag it onto the grid.</span>
                <span>Drag a node's right-hand dot onto another node to connect them. Click a line to remove it.</span>
            </div>}
            <svg className="vc-ab-edges" width={extent.width + CANVAS_PAD} height={extent.height + CANVAS_PAD}>
                {edges.map(edge => <g key={`${edge.block.id}-${edge.port}-${edge.targetId}-${edge.caseIndex}`} className={`vc-ab-edge ${edge.port}`}>
                    <path className="vc-ab-edge-hit" d={curve(edge.from, edge.to)} onClick={() => edge.caseIndex < 0 ? disconnect(edge.block.id, edge.port, edge.targetId) : setAutomation({ ...automation, blocks: blocks.map(block => block.id === edge.block.id ? { ...block, config: { ...block.config, cases: block.config.cases?.filter((_route, index) => index !== edge.caseIndex) } } : block) })}>
                        <title>{edge.caseIndex < 0 ? "Click to disconnect" : `Match ${edge.block.config.cases?.[edge.caseIndex].value}. Click to remove route.`}</title>
                    </path>
                    <path className="vc-ab-edge-line" d={curve(edge.from, edge.to)} />
                </g>)}
                {liveEdge && <path className="vc-ab-edge-live" d={curve(liveEdge.from, liveEdge.to)} />}
            </svg>

            {blocks.map(block => {
                const item = blockDefinition(block.type);
                const { x, y } = nodePosition(block);
                const ports = outputPorts(block.type);
                const Icon = BLOCK_ICONS[item.category];
                const dragging = drag?.kind === "node" && drag.id === block.id;
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
                        onNodeDragStart({ kind: "node", id: block.id, nodeX: x, nodeY: y }, event);
                    }}
                >
                    <header className="vc-ab-node-head">
                        <span className="vc-ab-node-icon"><Icon width={15} height={15} /></span>
                        <span className="vc-ab-node-copy">
                            <strong>{item.label}</strong>
                            <small>{summarize(block)}</small>
                        </span>
                        <button type="button" className="vc-ab-node-delete" aria-label={`Delete ${item.label}`} onClick={() => remove(block.id)}><DeleteIcon width={13} height={13} /></button>
                    </header>
                    <div className="vc-ab-node-ports">
                        <span className="vc-ab-port in" style={{ top: portOffset("note", 0) }} />
                        {ports.map((port, index) => <span
                            key={port}
                            className={`vc-ab-out ${port}`}
                            style={{ top: portOffset(block.type, index) }}
                        >
                            {ports.length > 1 && <em>{portLabel(block.type, port)}</em>}
                            <span
                                className={`vc-ab-port out ${port}`}
                                title={`Drag to connect: ${portLabel(block.type, port)}`}
                                onPointerDown={event => {
                                    event.stopPropagation();
                                    onNodeDragStart({ kind: "edge", id: block.id, port }, event);
                                }}
                            />
                        </span>)}
                    </div>
                </article>;
            })}
        </div>
    </div>;
}

/** One line of the block's most important setting, so a node reads at a glance. */
function summarize(block: AutomationBlock): string {
    const { config } = block;
    const text = config.content?.trim() || config.value?.trim() || config.matchText?.trim();
    if (block.type === "condition") return `${config.sourceVariable || "value"} ${config.operator ?? "equals"} ${config.compareValue || "…"}`;
    if (block.type === "chance") return `${config.chancePercent ?? 50}% of the time`;
    if (block.type === "repeat") return `${config.repeatCount ?? 2} times`;
    if (block.type === "delay") return `${config.durationSeconds ?? 1}s`;
    if (block.type === "run-command") return config.commandName ? `/${config.commandName}` : "No command chosen";
    if (config.variable?.trim() && !text) return `Saves ${config.variable.trim()}`;
    return text ? (text.length > 34 ? `${text.slice(0, 34)}…` : text) : blockDefinition(block.type).description;
}

export { snap };
