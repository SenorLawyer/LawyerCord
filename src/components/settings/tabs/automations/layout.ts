/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type AutomationBlock, type AutomationBlockType, type AutomationPort, edgeTargets, graphEntry, outputPorts } from "./model";

export const GRID = 20;
export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 66;
export const ROW_HEIGHT = 28;
const ERROR_STRIP = 18;
const COLUMN_STEP = NODE_WIDTH + 100;
const ROW_STEP = 100;
const ROW_GAP = 40;
const ORIGIN = 60;

export interface Point {
    x: number;
    y: number;
}

/** Output ports that get their own labelled row. The error port never does: it lives in the corner. */
export function labelledPorts(type: AutomationBlockType): AutomationPort[] {
    const ports = outputPorts(type).filter(port => port !== "error");
    return ports.length > 1 ? ports : [];
}

export function nodeHeight(type: AutomationBlockType): number {
    const rows = labelledPorts(type).length;
    return HEADER_HEIGHT + rows * ROW_HEIGHT + (rows ? ERROR_STRIP : 0);
}

export function snap(value: number): number {
    return Math.round(value / GRID) * GRID;
}

export function nodePosition(block: AutomationBlock): Point {
    return block.position ?? { x: 0, y: 0 };
}

/** Where a port's dot sits, relative to the node's top-left corner. */
export function portOffset(type: AutomationBlockType, port: AutomationPort): Point {
    if (port === "error") return { x: NODE_WIDTH, y: nodeHeight(type) - 11 };
    const index = labelledPorts(type).indexOf(port);
    return { x: NODE_WIDTH, y: index < 0 ? HEADER_HEIGHT / 2 : HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

export function inputAnchor(block: AutomationBlock): Point {
    const { x, y } = nodePosition(block);
    return { x, y: y + HEADER_HEIGHT / 2 };
}

export function outputAnchor(block: AutomationBlock, port: AutomationPort): Point {
    const { x, y } = nodePosition(block);
    const offset = portOffset(block.type, port);
    return { x: x + offset.x, y: y + offset.y };
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

/** Forward edges curve. Backward edges loop underneath both nodes so they never cross through them. */
export function edgePath(from: Point, to: Point, below: number): string {
    const dx = to.x - from.x;
    if (dx >= 40) {
        const d = Math.max(40, dx * 0.5);
        return `M ${from.x} ${from.y} C ${from.x + d} ${from.y}, ${to.x - d} ${to.y}, ${to.x} ${to.y}`;
    }
    const r = 14;
    const right = from.x + 30;
    const left = to.x - 30;
    return `M ${from.x} ${from.y} H ${right - r} Q ${right} ${from.y} ${right} ${from.y + r} V ${below - r} Q ${right} ${below} ${right - r} ${below} H ${left + r} Q ${left} ${below} ${left} ${below - r} V ${to.y + r} Q ${left} ${to.y} ${left + r} ${to.y} H ${to.x}`;
}

export function edgeMidpoint(from: Point, to: Point, below: number): Point {
    const dx = to.x - from.x;
    if (dx >= 40) {
        const d = Math.max(40, dx * 0.5);
        return { x: (from.x + 3 * (from.x + d) + 3 * (to.x - d) + to.x) / 8, y: (from.y + to.y) / 2 };
    }
    return { x: (from.x + to.x) / 2, y: below };
}

export function overlaps(blocks: AutomationBlock[], x: number, y: number, type: AutomationBlockType, ignoreId?: string): boolean {
    return blocks.some(block => {
        if (block.id === ignoreId) return false;
        const spot = nodePosition(block);
        return x < spot.x + NODE_WIDTH + GRID
            && x + NODE_WIDTH + GRID > spot.x
            && y < spot.y + nodeHeight(block.type) + GRID
            && y + nodeHeight(type) + GRID > spot.y;
    });
}

/** Free space at or below a preferred spot, so a new node never lands on an old one. */
export function freeSpot(blocks: AutomationBlock[], x: number, y: number, type: AutomationBlockType): Point {
    x = snap(Math.max(0, x));
    y = snap(Math.max(0, y));
    for (const block of blocks.toSorted((a, b) => nodePosition(a).y - nodePosition(b).y)) {
        if (overlaps([block], x, y, type)) y = snap(nodePosition(block).y + nodeHeight(block.type) + GRID * 2);
    }
    return { x, y };
}

/** Snaps to the grid, and onto a neighbour's edge when one is within reach, so hand-placed nodes line up. */
export function settle(blocks: AutomationBlock[], id: string, x: number, y: number): Point {
    let best = { x: snap(x), y: snap(y) };
    for (const block of blocks) {
        if (block.id === id) continue;
        const spot = nodePosition(block);
        if (Math.abs(spot.x - x) < 14) best = { ...best, x: spot.x };
        if (Math.abs(spot.y - y) < 14) best = { ...best, y: spot.y };
    }
    return { x: Math.max(0, best.x), y: Math.max(0, best.y) };
}

/**
 * Lays the whole graph out left to right. Each block sits one column right of everything that
 * feeds it, the Yes / each pass branch goes above, the No / when done branch below, and the
 * error branch below that. Loops back to an earlier block are drawn, not laid out.
 */
export function arrangeBlocks(blocks: AutomationBlock[]): AutomationBlock[] {
    const byId = new Map(blocks.map(block => [block.id, block]));
    const children = (block: AutomationBlock) => [
        ...edgeTargets(block.next),
        ...(block.config.cases ?? []).map(route => route.target),
        ...edgeTargets(block.alternate),
        ...edgeTargets(block.error),
    ].filter((id, index, all) => byId.has(id) && id !== block.id && all.indexOf(id) === index);

    const visited = new Set<string>();
    const stack = new Set<string>();
    const tree = new Map<string, string[]>();
    const forward = new Map<string, string[]>();
    const finished: string[] = [];
    const visit = (id: string) => {
        const block = byId.get(id);
        if (!block) return;
        visited.add(id);
        stack.add(id);
        const own: string[] = [];
        const out: string[] = [];
        for (const child of children(block)) {
            if (stack.has(child)) continue;
            out.push(child);
            if (visited.has(child)) continue;
            own.push(child);
            visit(child);
        }
        tree.set(id, own);
        forward.set(id, out);
        stack.delete(id);
        finished.push(id);
    };

    const roots: string[] = [];
    const entry = graphEntry(blocks);
    if (entry) { roots.push(entry.id); visit(entry.id); }
    for (const block of blocks) if (!visited.has(block.id)) { roots.push(block.id); visit(block.id); }

    const column = new Map<string, number>();
    for (const id of finished.toReversed()) {
        const own = column.get(id) ?? 0;
        column.set(id, own);
        for (const child of forward.get(id) ?? []) column.set(child, Math.max(column.get(child) ?? 0, own + 1));
    }

    const row = new Map<string, number>();
    let cursor = 0;
    const place = (id: string): number => {
        const own = tree.get(id) ?? [];
        const rows = own.map(place);
        const value = rows.length ? (rows[0] + rows[rows.length - 1]) / 2 : cursor++;
        row.set(id, value);
        return value;
    };
    roots.forEach((root, index) => { if (index) cursor += 1; place(root); });

    const columns = new Map<number, string[]>();
    for (const block of blocks) {
        const index = column.get(block.id) ?? 0;
        columns.set(index, [...columns.get(index) ?? [], block.id]);
    }
    const positions = new Map<string, Point>();
    for (const [index, ids] of columns) {
        ids.sort((left, right) => (row.get(left) ?? 0) - (row.get(right) ?? 0));
        let floor = -Infinity;
        for (const id of ids) {
            const y = Math.max((row.get(id) ?? 0) * ROW_STEP, floor);
            positions.set(id, { x: snap(ORIGIN + index * COLUMN_STEP), y: snap(ORIGIN + y) });
            const block = byId.get(id);
            floor = y + (block ? nodeHeight(block.type) : HEADER_HEIGHT) + ROW_GAP;
        }
    }
    return blocks.map(block => ({ ...block, position: positions.get(block.id) ?? nodePosition(block) }));
}
