/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { PlusIcon, RobotIcon } from "@components/Icons";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, showToast, TextInput, Toasts } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { BLOCK_ICONS, blockDefinition, CATEGORY_LABELS, paletteBlocks } from "./blocks";
import { Canvas, type CanvasDrag, type CanvasView, clampZoom, graphBounds, GRID, NODE_WIDTH, nodeHeight } from "./Canvas";
import { Connections } from "./Connections";
import { duplicateBlocks, editorReducer, removeBlocks } from "./editorState";
import { cancelAutomation, discardAutomationDraft, getAutomationSnapshot, runAutomation, saveAutomationDraft, testAutomation, upsertAutomation } from "./engine";
import { AutomationInspector, BlockInspector } from "./Inspector";
import {
    addEdgeTarget,
    type Automation,
    AUTOMATION_BLOCK_CATEGORIES,
    type AutomationBlock,
    type AutomationBlockType,
    type AutomationPort,
    cloneAutomation,
    cloneBlock,
    createAutomationBlock,
    isAutomation,
    layoutGraph,
    migrateToGraph,
} from "./model";
import { WorkflowRunHistory } from "./RunHistory";
import { StepView } from "./StepView";
import { validateWorkflow } from "./workflow";

function snap(value: number): number {
    return Math.round(value / GRID) * GRID;
}

function BlockPalette({ onAdd, onDragStart }: { onAdd(type: AutomationBlockType): void; onDragStart(source: CanvasDrag, event: ReactPointerEvent<HTMLElement>): void; }) {
    const [query, setQuery] = React.useState("");
    const normalized = query.trim().toLowerCase();
    const blocks = paletteBlocks().filter(block => !normalized || `${block.label} ${block.description}`.toLowerCase().includes(normalized));

    return <aside className="vc-ab-palette">
        <div className="vc-ab-palette-head">
            <Heading tag="h2">Blocks</Heading>
            <TextInput aria-label="Search blocks" value={query} placeholder="Search blocks" onChange={setQuery} />
        </div>
        <div className="vc-ab-palette-list">
            {AUTOMATION_BLOCK_CATEGORIES.map(category => {
                const categoryBlocks = blocks.filter(block => block.category === category);
                if (!categoryBlocks.length) return null;
                const Icon = BLOCK_ICONS[category];
                return <details className={`vc-ab-category ${category}`} key={category} open={category === "messages" || Boolean(normalized)}>
                    <summary>
                        <span className="vc-ab-category-icon"><Icon width={13} height={13} /></span>
                        <span className="vc-ab-category-name">{CATEGORY_LABELS[category]}</span>
                        <span className="vc-ab-category-count">{categoryBlocks.length}</span>
                    </summary>
                    <div className="vc-ab-category-blocks">
                        {categoryBlocks.map(item => <div
                            key={item.type}
                            role="button"
                            tabIndex={0}
                            className={`vc-ab-palette-block ${item.category}`}
                            title="Click to add, or drag onto the canvas"
                            onPointerDown={event => onDragStart({ kind: "new", type: item.type }, event)}
                            onClick={() => onAdd(item.type)}
                            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onAdd(item.type); } }}
                        >
                            <span className="vc-ab-palette-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                            <PlusIcon width={13} height={13} />
                        </div>)}
                    </div>
                </details>;
            })}
            {blocks.length === 0 && <span className="vc-ab-palette-empty">No blocks match that search.</span>}
        </div>
    </aside>;
}

function Builder({ initial, transitionState, onClose, onSaved }: RenderModalProps & { initial: Automation; onSaved?(automation: Automation): void; }) {
    const [state, dispatch] = React.useReducer(editorReducer, initial, workflow => ({
        workflow: { ...cloneAutomation(workflow), blocks: layoutGraph(workflow.schemaVersion === 2 ? structuredClone(workflow.blocks) : migrateToGraph(workflow.blocks)) }, past: [], future: [],
    }));
    const automation = state.workflow;
    const dragGroup = React.useRef<string | undefined>(undefined);
    const setAutomation = (workflow: Automation) => dispatch({ type: "edit", workflow, group: dragGroup.current });
    const [selectedId, selectOne] = React.useState<string | null>(null);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
    const setSelectedId = (id: string | null) => { selectOne(id); setSelectedIds(new Set(id ? [id] : [])); };
    const [mode, setMode] = React.useState<"graph" | "steps">("graph");
    const [insertion, setInsertion] = React.useState<{ id: string; port: AutomationPort; } | null>(null);
    const [runBusy, setRunBusy] = React.useState(false);
    const [draftStatus, setDraftStatus] = React.useState("Draft");
    const saved = React.useRef(initial);
    const draft = React.useRef(automation);
    draft.current = automation;
    React.useEffect(() => () => {
        if (draft.current !== saved.current) void saveAutomationDraft(draft.current).catch(() => showToast("Draft could not be saved.", Toasts.Type.FAILURE));
    }, []);
    const issues = React.useMemo(() => validateWorkflow(automation, [...getAutomationSnapshot().automations.filter(a => a.id !== automation.id), automation]), [automation]);
    const startRun = async (test: boolean) => {
        setRunBusy(true);
        try {
            const result = test ? await testAutomation(automation) : await runAutomation(automation.id);
            showToast(result.success ? test ? "Test completed." : "Run completed." : result.error || "Run failed.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
        } finally { setRunBusy(false); }
    };
    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (automation === saved.current) return;
            void saveAutomationDraft(automation).then(() => setDraftStatus("Draft saved"), () => setDraftStatus("Draft could not be saved"));
        }, 500);
        return () => clearTimeout(timer);
    }, [automation]);

    const [saving, setSaving] = React.useState(false);
    const [drag, setDrag] = React.useState<CanvasDrag | null>(null);
    const [pointer, setPointer] = React.useState<{ x: number; y: number; } | null>(null);
    const [ghost, setGhost] = React.useState<{ x: number; y: number; } | null>(null);
    const [dropTarget, setDropTarget] = React.useState<string | null>(null);
    const [view, setView] = React.useState<CanvasView>({ x: 40, y: 40, zoom: 1 });
    const [clipboard, setClipboard] = React.useState<AutomationBlock | null>(null);
    const surfaceRef = React.useRef<HTMLDivElement>(null);
    const clicked = React.useRef(true);
    const latest = React.useRef({ automation, dropTarget });
    latest.current = { automation, dropTarget };
    const selected = automation.blocks.find(block => block.id === selectedId);

    /** Canvas coordinates for a point in the viewport, undoing the pan and the zoom. */
    const toCanvas = (clientX: number, clientY: number) => {
        const surface = surfaceRef.current;
        if (!surface) return { x: clientX, y: clientY };
        const rect = surface.getBoundingClientRect();
        return {
            x: (clientX - rect.left - view.x) / view.zoom,
            y: (clientY - rect.top - view.y) / view.zoom,
        };
    };

    /** Zooms around a screen point, so whatever sits under the pointer stays under it. */
    const zoomAt = (delta: number, clientX: number, clientY: number) => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        setView(current => {
            const next = clampZoom(current.zoom * Math.exp(-delta * 0.0015));
            if (next === current.zoom) return current;
            const px = clientX - rect.left;
            const py = clientY - rect.top;
            return {
                zoom: next,
                x: px - (px - current.x) * (next / current.zoom),
                y: py - (py - current.y) * (next / current.zoom),
            };
        });
    };

    /** Steps the zoom from the middle of the canvas, for the toolbar buttons. */
    const stepZoom = (zoomIn: boolean) => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        zoomAt(zoomIn ? -120 : 120, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    /** Frames the whole workflow, the fastest way back when you have panned off into space. */
    const fitView = () => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        const bounds = graphBounds(automation.blocks);
        const margin = 60;
        const zoom = clampZoom(Math.min(
            (rect.width - margin * 2) / bounds.width,
            (rect.height - margin * 2) / bounds.height,
            1.2,
        ));
        setView({
            zoom,
            x: (rect.width - bounds.width * zoom) / 2 - bounds.x * zoom,
            y: (rect.height - bounds.height * zoom) / 2 - bounds.y * zoom,
        });
    };

    React.useLayoutEffect(() => {
        const frame = requestAnimationFrame(fitView);
        return () => cancelAnimationFrame(frame);
    }, []);

    /** True when a node box starting here would overlap one that already exists. */
    const overlaps = (x: number, y: number, type: AutomationBlockType) => automation.blocks.some(block => {
        const spot = block.position ?? { x: 0, y: 0 };
        return x < spot.x + NODE_WIDTH + GRID
            && x + NODE_WIDTH + GRID > spot.x
            && y < spot.y + nodeHeight(block.type) + GRID
            && y + nodeHeight(type) + GRID > spot.y;
    });

    /** Free space at or below a preferred spot, so a new node never lands on an old one. */
    const freeSpot = (x: number, y: number, type: AutomationBlockType) => {
        let top = y;
        for (let attempt = 0; attempt < 40 && overlaps(x, top, type); attempt++) top += nodeHeight(type) + GRID * 2;
        return { x: snap(x), y: snap(top) };
    };

    const addBlock = (type: AutomationBlockType, position?: { x: number; y: number; }) => {
        const block = createAutomationBlock(type);
        const surface = surfaceRef.current;
        const anchor = automation.blocks.find(current => current.id === selectedId);
        const preferred = anchor?.position
            // Place it after whatever is selected, so clicking builds a chain left to right.
            ? { x: anchor.position.x + NODE_WIDTH + GRID * 4, y: anchor.position.y }
            // Nothing selected: drop it near the top-left of whatever is currently on screen.
            : toCanvas((surface?.getBoundingClientRect().left ?? 0) + 90, (surface?.getBoundingClientRect().top ?? 0) + 80);
        block.position = position ? { x: snap(position.x), y: snap(position.y) } : freeSpot(preferred.x, preferred.y, type);

        // Chain onto the selected block while its next port is free.
        const blocks = automation.blocks.map(current => current.id === selectedId && current.next === undefined && current.type !== "stop" && current.type !== "fail"
            ? { ...current, next: block.id }
            : current);
        if (insertion) {
            const origin = blocks.find(item => item.id === insertion.id);
            block.next = origin?.[insertion.port];
            setAutomation({ ...automation, blocks: [...blocks.map(item => item.id === insertion.id ? { ...item, [insertion.port]: block.id } : item), block] });
            setInsertion(null);
        } else setAutomation({ ...automation, entryId: automation.entryId ?? block.id, blocks: [...blocks, block] });
        setSelectedId(block.id);
    };

    /** Drops a copy of a block on the canvas, keeping its settings but none of its wiring. */
    const addCopy = (source: AutomationBlock, at?: { x: number; y: number; }) => {
        const origin = at ?? source.position ?? { x: 80, y: 60 };
        const copy: AutomationBlock = {
            ...cloneBlock(source),
            id: crypto.randomUUID(),
            next: undefined,
            alternate: undefined,
            position: freeSpot(origin.x + GRID * 2, origin.y + GRID * 2, source.type),
        };
        setAutomation({ ...automation, blocks: [...automation.blocks, copy] });
        setSelectedId(copy.id);
    };

    const removeBlock = (id: string) => {
        setAutomation(removeBlocks(automation, selectedIds.has(id) ? selectedIds : new Set([id])));
        setSelectedId(null);
    };

    const duplicateBlock = (id: string) => {
        const result = duplicateBlocks(automation, selectedIds.has(id) ? selectedIds : new Set([id]));
        setAutomation(result.workflow);
        setSelectedIds(result.ids);
        selectOne([...result.ids][0] ?? null);
    };

    const copyBlock = (id: string) => {
        const source = automation.blocks.find(block => block.id === id);
        if (!source) return;
        setClipboard(cloneBlock(source));
        showToast(`Copied ${blockDefinition(source.type).label}.`, Toasts.Type.SUCCESS);
    };

    const pasteBlock = (at?: { x: number; y: number; }) => {
        if (clipboard) addCopy(clipboard, at);
    };

    const connect = (fromId: string, port: "next" | "alternate" | "error", targetId: string) => {
        if (fromId === targetId) return;
        const current = latest.current.automation;
        setAutomation({
            ...current,
            // Adds to the port rather than replacing it, so one block can feed several.
            blocks: current.blocks.map(block => block.id === fromId ? { ...block, [port]: addEdgeTarget(block[port], targetId) } : block),
        });
    };

    const moveNode = (id: string, x: number, y: number) => {
        const current = latest.current.automation;
        setAutomation({
            ...current,
            blocks: current.blocks.map(block => block.id === id ? { ...block, position: { x: snap(Math.max(0, x)), y: snap(Math.max(0, y)) } } : block),
        });
    };

    const nodeAt = (clientX: number, clientY: number): string | null => {
        const point = toCanvas(clientX, clientY);
        return latest.current.automation.blocks.find(block => {
            const { x, y } = block.position ?? { x: 0, y: 0 };
            return point.x >= x && point.x <= x + NODE_WIDTH && point.y >= y && point.y <= y + nodeHeight(block.type);
        })?.id ?? null;
    };
    const dragCleanup = React.useRef<(() => void) | undefined>(undefined);
    React.useEffect(() => () => dragCleanup.current?.(), []);

    const startDrag = (source: CanvasDrag, event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        dragCleanup.current?.();
        dragGroup.current = crypto.randomUUID();
        const element = event.currentTarget;
        const origin = { x: event.clientX, y: event.clientY };
        let active = false;
        clicked.current = true;

        const move = (moveEvent: PointerEvent) => {
            if (!active && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 5) return;
            if (!active) {
                active = true;
                clicked.current = false;
                setDrag(source);
            }

            if (source.kind === "node") {
                // Measure the drag in canvas space so it tracks the pointer at any zoom.
                const from = toCanvas(origin.x, origin.y);
                const to = toCanvas(moveEvent.clientX, moveEvent.clientY);
                moveNode(source.id, source.nodeX + (to.x - from.x), source.nodeY + (to.y - from.y));
                return;
            }
            if (source.kind === "pan") {
                setView(current => ({
                    ...current,
                    x: source.viewX + (moveEvent.clientX - source.startX),
                    y: source.viewY + (moveEvent.clientY - source.startY),
                }));
                return;
            }

            setGhost({ x: moveEvent.clientX, y: moveEvent.clientY });
            setPointer(toCanvas(moveEvent.clientX, moveEvent.clientY));
            if (source.kind === "edge") setDropTarget(nodeAt(moveEvent.clientX, moveEvent.clientY));
        };

        const finish = (upEvent: PointerEvent) => {
            element.removeEventListener("pointermove", move);
            element.removeEventListener("pointerup", finish);
            element.removeEventListener("pointercancel", finish);
            if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

            if (active && source.kind === "edge") {
                const target = latest.current.dropTarget ?? nodeAt(upEvent.clientX, upEvent.clientY);
                if (target) connect(source.id, source.port, target);
            }
            if (active && source.kind === "new") {
                const rect = surfaceRef.current?.getBoundingClientRect();
                const inside = rect !== undefined
                    && upEvent.clientX >= rect.left && upEvent.clientX <= rect.right
                    && upEvent.clientY >= rect.top && upEvent.clientY <= rect.bottom;
                if (inside) {
                    const spot = toCanvas(upEvent.clientX, upEvent.clientY);
                    addBlock(source.type, { x: snap(Math.max(0, spot.x - 110)), y: snap(Math.max(0, spot.y - 22)) });
                }
            }

            dragGroup.current = undefined;
            dispatch({ type: "finish" });
            dragCleanup.current = undefined;
            setDrag(null);
            setPointer(null);
            setGhost(null);
            setDropTarget(null);
        };

        dragCleanup.current = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish); element.removeEventListener("pointercancel", finish); };
        element.setPointerCapture(event.pointerId);
        element.addEventListener("pointermove", move);
        element.addEventListener("pointerup", finish);
        element.addEventListener("pointercancel", finish);
    };

    const addFromPalette = (type: AutomationBlockType) => {
        if (clicked.current) addBlock(type);
    };

    const tidy = () => setAutomation({
        ...automation,
        blocks: layoutGraph(automation.blocks.map(block => ({ ...block, position: undefined }))),
    });

    // Ctrl+C, Ctrl+V, Ctrl+D and Delete, ignored while a text field has focus.
    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;

            if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
                event.preventDefault();
                removeBlock(selectedId);
                return;
            }
            if (!event.ctrlKey && !event.metaKey) return;

            const key = event.key.toLowerCase();
            if (key === "z") { event.preventDefault(); dispatch({ type: event.shiftKey ? "redo" : "undo" }); return; }
            if (key === "y") { event.preventDefault(); dispatch({ type: "redo" }); return; }
            if (key === "a") { event.preventDefault(); setSelectedIds(new Set(automation.blocks.map(block => block.id))); return; }
            if (key === "c" && selectedId) { event.preventDefault(); copyBlock(selectedId); }
            else if (key === "d" && selectedId) { event.preventDefault(); duplicateBlock(selectedId); }
            else if (key === "v" && clipboard) { event.preventDefault(); pasteBlock(); }
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selectedId, selectedIds, clipboard, automation]);

    const save = async (run: boolean) => {
        if (automation.blocks.some(block => block.config.jsonDrafts && Object.keys(block.config.jsonDrafts).length)) return;
        setSaving(true);
        const next = { ...automation, name: automation.name.trim() || "Untitled automation", updatedAt: Date.now() };
        try {
            await upsertAutomation(next);
            if (run) {
                const result = await runAutomation(next.id);
                showToast(result.success ? "Automation completed." : result.error || "Automation failed.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
            } else showToast("Automation saved.", Toasts.Type.SUCCESS);
            saved.current = automation;
            await discardAutomationDraft(next.id);
            setDraftStatus("Saved");
            onSaved?.(next);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "Automation could not be saved.", Toasts.Type.FAILURE);
        } finally {
            setSaving(false);
        }
    };

    return <Modal
        transitionState={transitionState}
        onClose={onClose}
        size="xxl"
        title={<div className="vc-ab-title"><RobotIcon width={20} height={20} /><span>{automation.name || "Untitled automation"}</span><small>{automation.blocks.length} block{automation.blocks.length === 1 ? "" : "s"}</small></div>}
        subtitle={<div className="vc-ab-subhead">
            <Button size="small" variant={mode === "graph" ? "primary" : "secondary"} onClick={() => setMode("graph")}>Graph</Button>
            <Button size="small" variant={mode === "steps" ? "primary" : "secondary"} onClick={() => setMode("steps")}>Steps</Button>
            <Button size="small" variant="secondary" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>Undo</Button>
            <Button size="small" variant="secondary" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>Redo</Button>
            <span className="vc-ab-draft-status">{insertion ? "Choose a block to insert" : draftStatus}</span>
            <button type="button" className="vc-ab-tidy" onClick={tidy}>Auto-arrange</button>
            <button type="button" className="vc-ab-tidy" onClick={fitView}>Fit to view</button>
            <button type="button" className="vc-ab-tidy" disabled={!selected} onClick={() => selected && duplicateBlock(selected.id)}>Duplicate</button>
            <button type="button" className="vc-ab-tidy" disabled={!selected} onClick={() => selected && copyBlock(selected.id)}>Copy</button>
            <button type="button" className="vc-ab-tidy" disabled={!clipboard} onClick={() => pasteBlock()}>Paste</button>
            <div className="vc-ab-zoom">
                <button type="button" className="vc-ab-zoom-step" aria-label="Zoom out" onClick={() => stepZoom(false)}>&minus;</button>
                <button type="button" className="vc-ab-zoom-step vc-ab-zoom-level" title="Reset to 100%" onClick={() => setView(current => ({ ...current, zoom: 1 }))}>{Math.round(view.zoom * 100)}%</button>
                <button type="button" className="vc-ab-zoom-step" aria-label="Zoom in" onClick={() => stepZoom(true)}>+</button>
            </div>
        </div>}
        actions={[
            { text: "Save", variant: "primary", onClick: () => void save(false), disabled: saving || automation.blocks.some(block => block.config.jsonDrafts && Object.keys(block.config.jsonDrafts).length > 0) },
            { text: "Test", variant: "secondary", onClick: () => void startRun(true), disabled: runBusy || issues.some(issue => issue.severity === "error") },
            { text: "Run saved workflow", variant: "secondary", onClick: () => void startRun(false), disabled: runBusy || !getAutomationSnapshot().automations.some(item => item.id === automation.id) },
            { text: "Cancel run", variant: "secondary", onClick: () => cancelAutomation(automation.id) },
        ]}
    >
        <div className="vc-ab-workspace">
            <BlockPalette onAdd={addFromPalette} onDragStart={startDrag} />
            {mode === "steps" ? <StepView automation={automation} selectedId={selectedId} onSelect={setSelectedId} onInsert={(id, port) => { setSelectedId(id); setInsertion({ id, port }); }} /> : <Canvas
                automation={automation}
                selectedId={selectedId}
                selectedIds={selectedIds}
                onToggleSelection={id => { selectOne(id); setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}
                setSelectedId={setSelectedId}
                setAutomation={setAutomation}
                onNodeDragStart={startDrag}
                surfaceRef={surfaceRef}
                drag={drag}
                pointer={pointer}
                dropTarget={dropTarget}
                view={view}
                onZoomAt={zoomAt}
            />}
            <aside className="vc-ab-inspector">
                <WorkflowRunHistory workflowId={automation.id} />
                {issues.length > 0 && <section className="vc-ab-validation" aria-label="Workflow checks">{issues.map((issue, index) => <Button key={issue.message + index} size="small" variant="secondary" onClick={() => setSelectedId(issue.blockId ?? null)}>{issue.severity === "error" ? "Fix: " : "Check: "}{issue.message}</Button>)}</section>}
                {selected && <Connections automation={automation} block={selected} onChange={setAutomation} onInsert={port => setInsertion({ id: selected.id, port })} />}
                {selected
                    ? <BlockInspector key={selected.id} block={selected} automation={automation} setAutomation={setAutomation} />
                    : <AutomationInspector automation={automation} setAutomation={setAutomation} />}
            </aside>
        </div>
        {drag?.kind === "new" && ghost && <div className="vc-ab-ghost" style={{ left: ghost.x + 14, top: ghost.y + 14 }}>{blockDefinition(drag.type).label}</div>}
    </Modal>;
}

export function openAutomationBuilder(automation: Automation, onSaved?: (automation: Automation) => void): void {
    void DataStore.get<Automation>(`LawyerCord_automationDraft_${automation.id}`).then(draft => {
        const initial = draft && isAutomation(draft) ? draft : automation;
        const Wrapped = ErrorBoundary.wrap(Builder, { noop: true });
        openModal(props => <Wrapped {...props} key={initial.id} initial={initial} onSaved={onSaved} />);
    });
}
