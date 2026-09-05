/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Automation, cloneAutomation, remapBlockConfig, remapEdge, removeEdgeTarget } from "./model";

export interface EditorState {
    workflow: Automation;
    past: Automation[];
    future: Automation[];
    group?: string;
}

export type EditorAction = { type: "edit"; workflow: Automation; group?: string; } | { type: "undo" | "redo" | "finish"; };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
    if (action.type === "finish") return { ...state, group: undefined };
    if (action.type === "undo") {
        const workflow = state.past.at(-1);
        return workflow ? { workflow, past: state.past.slice(0, -1), future: [state.workflow, ...state.future] } : state;
    }
    if (action.type === "redo") {
        const workflow = state.future[0];
        return workflow ? { workflow, past: [...state.past, state.workflow], future: state.future.slice(1) } : state;
    }
    if (action.type !== "edit" || action.workflow === state.workflow) return state;
    return { workflow: action.workflow, past: action.group && action.group === state.group ? state.past : [...state.past, state.workflow].slice(-100), future: [], group: action.group };
}

export function removeBlocks(workflow: Automation, ids: Set<string>): Automation {
    return {
        ...workflow,
        entryId: workflow.entryId && ids.has(workflow.entryId) ? undefined : workflow.entryId,
        blocks: workflow.blocks.filter(block => !ids.has(block.id)).map(block => {
            const copy = { ...block, config: { ...block.config, cases: block.config.cases?.filter(item => !ids.has(item.target)) } };
            for (const id of ids) {
                copy.next = removeEdgeTarget(copy.next, id);
                copy.alternate = removeEdgeTarget(copy.alternate, id);
                copy.error = removeEdgeTarget(copy.error, id);
            }
            return copy;
        }),
    };
}

export function duplicateBlocks(workflow: Automation, selected: Set<string>): { workflow: Automation; ids: Set<string>; } {
    const ids = new Map([...selected].map(id => [id, crypto.randomUUID()]));
    const copies = cloneAutomation(workflow).blocks.filter(block => selected.has(block.id)).map(block => ({
        ...block,
        id: ids.get(block.id) ?? block.id,
        next: remapEdge(block.next, ids),
        alternate: remapEdge(block.alternate, ids),
        error: remapEdge(block.error, ids),
        config: remapBlockConfig(block.config, ids),
        position: { x: (block.position?.x ?? 0) + 40, y: (block.position?.y ?? 0) + 40 },
    }));
    return { workflow: { ...workflow, blocks: [...workflow.blocks, ...copies] }, ids: new Set(ids.values()) };
}
