/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { PlusIcon, RobotIcon } from "@components/Icons";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, showToast, TextInput, Toasts } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { BLOCK_ICONS, blockDefinition, CATEGORY_LABELS, paletteBlocks } from "./blocks";
import { Canvas, type CanvasDrag, type CanvasView, clampZoom, type Insertion } from "./Canvas";
import { duplicateBlocks, editorReducer, removeBlocks } from "./editorState";
import { cancelAutomation, discardAutomationDraft, getAutomationSnapshot, runAutomation, saveAutomationDraft, subscribeAutomationState, testAutomation, upsertAutomation } from "./engine";
import { AutomationInspector, BlockInspector } from "./Inspector";
import { arrangeBlocks, freeSpot, graphBounds, GRID, HEADER_HEIGHT, NODE_WIDTH, nodeHeight, outputAnchor, type Point, settle } from "./layout";
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
    LAYOUT_VERSION,
    migrateToGraph,
    portLabel,
} from "./model";
import { StepView } from "./StepView";
import { validateWorkflow, type WorkflowIssue } from "./workflow";

interface PaletteProps {
    insertion: { block: AutomationBlock; port: AutomationPort; } | null;
    onAdd(type: AutomationBlockType): void;
    onDragStart(source: CanvasDrag, event: ReactPointerEvent<HTMLElement>): void;
    onCancelInsert(): void;
}

function BlockPalette({ insertion, onAdd, onDragStart, onCancelInsert }: PaletteProps) {
    const [query, setQuery] = React.useState("");
    const normalized = query.trim().toLowerCase();
    const blocks = paletteBlocks().filter(block => !normalized || `${block.label} ${block.description}`.toLowerCase().includes(normalized));

    return <aside className={`vc-ab-palette${insertion ? " inserting" : ""}`}>
        <div className="vc-ab-palette-head">
            <span className="vc-ab-panel-label">Blocks</span>
            <TextInput aria-label="Search blocks" value={query} placeholder="Search blocks…" onChange={setQuery} />
        </div>
        {insertion && <div className="vc-ab-insert-banner">
            <span>Pick a block to add after <strong>{portLabel(insertion.block.type, insertion.port)}</strong> of <strong>{blockDefinition(insertion.block.type).label}</strong>.</span>
            <Button size="small" variant="secondary" onClick={onCancelInsert}>Cancel</Button>
        </div>}
        <div className="vc-ab-palette-list">
            {AUTOMATION_BLOCK_CATEGORIES.map(category => {
                const categoryBlocks = blocks.filter(block => block.category === category);
                if (!categoryBlocks.length) return null;
                const Icon = BLOCK_ICONS[category];
                return <details className={`vc-ab-category ${category}`} key={category} open={category === "messages" || category === "flow" || Boolean(normalized)}>
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
                            title={insertion ? "Click to add and connect it" : "Click to add, or drag it onto the canvas"}
                            onPointerDown={event => { if (!insertion) onDragStart({ kind: "new", type: item.type }, event); }}
                            onClick={() => onAdd(item.type)}
                            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onAdd(item.type); } }}
                        >
                            <span className="vc-ab-palette-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                            <PlusIcon width={14} height={14} />
                        </div>)}
                    </div>
                </details>;
            })}
            {blocks.length === 0 && <span className="vc-ab-palette-empty">No blocks match that search.</span>}
        </div>
    </aside>;
}

function IssuesPanel({ issues, onSelect }: { issues: WorkflowIssue[]; onSelect(id: string | null): void; }) {
    if (!issues.length) return null;
    const errors = issues.filter(issue => issue.severity === "error").length;
    return <section className="vc-ab-issues" aria-label="Things to check">
        <strong>{errors ? `${errors} thing${errors === 1 ? "" : "s"} to fix before this can run` : "Worth a look"}</strong>
        {issues.map((issue, index) => <button type="button" key={issue.message + index} className={`vc-ab-issue ${issue.severity}`} onClick={() => onSelect(issue.blockId ?? null)}>{issue.message}</button>)}
    </section>;
}

function Builder({ initial, transitionState, onClose }: RenderModalProps & { initial: Automation; }) {
    const [state, dispatch] = React.useReducer(editorReducer, initial, workflow => {
        const blocks = workflow.schemaVersion === 2 ? structuredClone(workflow.blocks) : migrateToGraph(workflow.blocks);
        // Older automations were laid out for smaller nodes, so their saved spots would overlap now.
        const stale = workflow.layoutVersion !== LAYOUT_VERSION || blocks.some(block => !block.position);
        return { workflow: { ...cloneAutomation(workflow), layoutVersion: LAYOUT_VERSION, blocks: stale ? arrangeBlocks(blocks) : blocks }, past: [], future: [] };
    });
    const automation = state.workflow;
    const snapshot = React.useSyncExternalStore(subscribeAutomationState, getAutomationSnapshot);
    const dragGroup = React.useRef<string | undefined>(undefined);
    const setAutomation = (workflow: Automation) => dispatch({ type: "edit", workflow, group: dragGroup.current });
    const [selectedId, selectOne] = React.useState<string | null>(null);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
    const setSelectedId = (id: string | null) => { selectOne(id); setSelectedIds(new Set(id ? [id] : [])); };
    const [mode, setMode] = React.useState<"canvas" | "list">("canvas");
    const [insertion, setInsertion] = React.useState<Insertion | null>(null);
    const [runBusy, setRunBusy] = React.useState(false);
    const [draftStatus, setDraftStatus] = React.useState("No changes yet");
    const saved = React.useRef(initial);
    const draft = React.useRef(automation);
    draft.current = automation;
    React.useEffect(() => () => {
        if (draft.current !== saved.current) void saveAutomationDraft(draft.current).catch(() => showToast("Draft could not be saved.", Toasts.Type.FAILURE));
    }, []);
    const issues = React.useMemo(() => validateWorkflow(automation, [...snapshot.automations.filter(a => a.id !== automation.id), automation]), [automation, snapshot.automations]);
    const isSaved = snapshot.automations.some(item => item.id === automation.id);
    const running = runBusy || snapshot.runs.some(run => run.workflowId === automation.id);
    const startRun = async (test: boolean) => {
        setRunBusy(true);
        try {
            const result = test ? await testAutomation(automation) : await runAutomation(automation.id);
            showToast(result.success ? test ? "Test finished." : "Run finished." : result.error || "The run failed.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
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
    const [pointer, setPointer] = React.useState<Point | null>(null);
    const [ghost, setGhost] = React.useState<Point | null>(null);
    const [dropTarget, setDropTarget] = React.useState<string | null>(null);
    const [view, setView] = React.useState<CanvasView>({ x: 40, y: 40, zoom: 1 });
    const [clipboard, setClipboard] = React.useState<AutomationBlock | null>(null);
    const surfaceRef = React.useRef<HTMLDivElement>(null);
    const clicked = React.useRef(true);
    const latest = React.useRef({ automation, dropTarget, view });
    latest.current = { automation, dropTarget, view };
    const selected = automation.blocks.find(block => block.id === selectedId);
    const insertionSource = insertion ? automation.blocks.find(block => block.id === insertion.id) : undefined;

    /** Canvas coordinates for a point in the viewport, undoing the pan and the zoom. */
    const toCanvas = (clientX: number, clientY: number): Point => {
        const surface = surfaceRef.current;
        const { view } = latest.current;
        if (!surface) return { x: clientX, y: clientY };
        const rect = surface.getBoundingClientRect();
        return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
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
            return { zoom: next, x: px - (px - current.x) * (next / current.zoom), y: py - (py - current.y) * (next / current.zoom) };
        });
    };

    const stepZoom = (zoomIn: boolean) => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        zoomAt(zoomIn ? -160 : 160, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    /** Frames the whole workflow, the fastest way back when you have panned off into space. */
    const fitView = (blocks = latest.current.automation.blocks) => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        const bounds = graphBounds(blocks);
        const margin = 80;
        const zoom = clampZoom(Math.min((rect.width - margin * 2) / bounds.width, (rect.height - margin * 2) / bounds.height, 1));
        setView({ zoom, x: (rect.width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (rect.height - bounds.height * zoom) / 2 - bounds.y * zoom });
    };

    // Fit once the modal exists, and again after its opening animation has settled the size.
    React.useLayoutEffect(() => {
        const frame = requestAnimationFrame(() => fitView());
        const settled = setTimeout(() => fitView(), 400);
        return () => { cancelAnimationFrame(frame); clearTimeout(settled); };
    }, []);

    /** Adds a block. In insert mode it is wired onto the pending port; otherwise it chains after the selection. */
    const addBlock = (type: AutomationBlockType, position?: Point) => {
        const block = createAutomationBlock(type);
        const current = latest.current.automation;
        if (insertion) {
            const source = current.blocks.find(item => item.id === insertion.id);
            if (source) {
                const anchor = outputAnchor(source, insertion.port);
                const preferred = insertion.at ?? { x: anchor.x + 100, y: anchor.y - HEADER_HEIGHT / 2 };
                block.position = freeSpot(current.blocks, preferred.x, preferred.y, type);
                // Anything already on that port now runs after the new block, so it is inserted, not replaced.
                const displaced = source[insertion.port];
                if (displaced !== undefined && insertion.port !== "error") block.next = displaced;
                setAutomation({ ...current, blocks: [...current.blocks.map(item => item.id === source.id ? { ...item, [insertion.port]: block.id } : item), block] });
                setInsertion(null);
                setSelectedId(block.id);
                return;
            }
            setInsertion(null);
        }

        const anchor = current.blocks.find(item => item.id === selectedId);
        const surface = surfaceRef.current?.getBoundingClientRect();
        const preferred = anchor?.position
            ? { x: anchor.position.x + NODE_WIDTH + 100, y: anchor.position.y }
            : toCanvas((surface?.left ?? 0) + 120, (surface?.top ?? 0) + 120);
        block.position = position ?? freeSpot(current.blocks, preferred.x, preferred.y, type);

        // Chain onto the selected block while its next port is free.
        const chainFrom = anchor && anchor.next === undefined && !position && anchor.type !== "stop" && anchor.type !== "fail" ? anchor.id : undefined;
        // A block dropped just right of a free next port snaps onto it.
        const dropOn = position ? current.blocks.find(item => {
            if (item.next !== undefined || item.type === "stop" || item.type === "fail") return false;
            const out = outputAnchor(item, "next");
            return position.x - out.x > -20 && position.x - out.x < 120 && Math.abs(position.y + HEADER_HEIGHT / 2 - out.y) < 60;
        })?.id : undefined;
        const from = chainFrom ?? dropOn;
        setAutomation({
            ...current,
            entryId: current.entryId ?? block.id,
            blocks: [...current.blocks.map(item => item.id === from ? { ...item, next: block.id } : item), block],
        });
        setSelectedId(block.id);
    };

    const addCopy = (source: AutomationBlock, at?: Point) => {
        const origin = at ?? source.position ?? { x: 80, y: 60 };
        const copy: AutomationBlock = { ...cloneBlock(source), id: crypto.randomUUID(), next: undefined, alternate: undefined, error: undefined, position: freeSpot(automation.blocks, origin.x + GRID * 2, origin.y + GRID * 2, source.type) };
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

    const pasteBlock = () => { if (clipboard) addCopy(clipboard); };

    const connect = (fromId: string, port: AutomationPort, targetId: string) => {
        if (fromId === targetId) return;
        const current = latest.current.automation;
        setAutomation({ ...current, blocks: current.blocks.map(block => block.id === fromId ? { ...block, [port]: addEdgeTarget(block[port], targetId) } : block) });
    };

    const moveNode = (id: string, x: number, y: number, final: boolean) => {
        const current = latest.current.automation;
        const spot = final ? settle(current.blocks, id, x, y) : { x: Math.max(0, x), y: Math.max(0, y) };
        setAutomation({ ...current, blocks: current.blocks.map(block => block.id === id ? { ...block, position: spot } : block) });
    };

    const nodeAt = (clientX: number, clientY: number): string | null => {
        const point = toCanvas(clientX, clientY);
        return latest.current.automation.blocks.find(block => {
            const { x, y } = block.position ?? { x: 0, y: 0 };
            return point.x >= x - 10 && point.x <= x + NODE_WIDTH + 10 && point.y >= y - 10 && point.y <= y + nodeHeight(block.type) + 10;
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
        let last = origin;
        clicked.current = true;

        const move = (moveEvent: PointerEvent) => {
            last = { x: moveEvent.clientX, y: moveEvent.clientY };
            if (!active && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 5) return;
            if (!active) { active = true; clicked.current = false; setDrag(source); }

            if (source.kind === "node") {
                const from = toCanvas(origin.x, origin.y);
                const to = toCanvas(moveEvent.clientX, moveEvent.clientY);
                moveNode(source.id, source.nodeX + (to.x - from.x), source.nodeY + (to.y - from.y), false);
                return;
            }
            if (source.kind === "pan") {
                setView(current => ({ ...current, x: source.viewX + (moveEvent.clientX - source.startX), y: source.viewY + (moveEvent.clientY - source.startY) }));
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
            const rect = surfaceRef.current?.getBoundingClientRect();
            const inside = rect !== undefined && upEvent.clientX >= rect.left && upEvent.clientX <= rect.right && upEvent.clientY >= rect.top && upEvent.clientY <= rect.bottom;

            if (active && source.kind === "node") {
                const from = toCanvas(origin.x, origin.y);
                const to = toCanvas(last.x, last.y);
                moveNode(source.id, source.nodeX + (to.x - from.x), source.nodeY + (to.y - from.y), true);
            }
            if (active && source.kind === "edge") {
                const target = latest.current.dropTarget ?? nodeAt(upEvent.clientX, upEvent.clientY);
                if (target) connect(source.id, source.port, target);
                // Let go on empty space, and the next block you pick lands right here, already connected.
                else if (inside) {
                    const spot = toCanvas(upEvent.clientX, upEvent.clientY);
                    setInsertion({ id: source.id, port: source.port, at: { x: spot.x, y: spot.y - HEADER_HEIGHT / 2 } });
                }
            }
            if (active && source.kind === "new" && inside) {
                const spot = toCanvas(upEvent.clientX, upEvent.clientY);
                addBlock(source.type, { x: Math.max(0, Math.round((spot.x - NODE_WIDTH / 2) / GRID) * GRID), y: Math.max(0, Math.round((spot.y - HEADER_HEIGHT / 2) / GRID) * GRID) });
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

    const addFromPalette = (type: AutomationBlockType) => { if (clicked.current) addBlock(type); };

    const tidy = () => {
        const blocks = arrangeBlocks(automation.blocks);
        setAutomation({ ...automation, blocks });
        requestAnimationFrame(() => fitView(blocks));
    };

    const beginInsert = (id: string, port: AutomationPort) => {
        setSelectedId(id);
        setInsertion({ id, port });
        setMode("canvas");
    };

    // Ctrl+C, Ctrl+V, Ctrl+D and Delete, ignored while a text field has focus.
    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
            if (event.key === "Escape") {
                if (insertion) { event.preventDefault(); setInsertion(null); }
                return;
            }
            if ((event.key === "Delete" || event.key === "Backspace") && selectedId) { event.preventDefault(); removeBlock(selectedId); return; }
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
    }, [selectedId, selectedIds, clipboard, automation, insertion]);

    const hasBadJson = automation.blocks.some(block => block.config.jsonDrafts && Object.keys(block.config.jsonDrafts).length > 0);
    const save = async () => {
        if (hasBadJson) return;
        setSaving(true);
        const next = { ...automation, name: automation.name.trim() || "Untitled automation", updatedAt: Date.now() };
        try {
            await upsertAutomation(next);
            showToast("Automation saved.", Toasts.Type.SUCCESS);
            saved.current = automation;
            await discardAutomationDraft(next.id);
            setDraftStatus("Saved");
        } catch (error) {
            showToast(error instanceof Error ? error.message : "The automation could not be saved.", Toasts.Type.FAILURE);
        } finally {
            setSaving(false);
        }
    };

    const stepCount = automation.blocks.length;
    return <Modal
        transitionState={transitionState}
        onClose={onClose}
        size="xxl"
        title={<button type="button" className="vc-ab-title" title="Rename or change when it starts" onClick={() => setSelectedId(null)}>
            <RobotIcon width={20} height={20} />
            <span>{automation.name || "Untitled automation"}</span>
            <small>{stepCount} step{stepCount === 1 ? "" : "s"}</small>
        </button>}
        subtitle={<div className="vc-ab-toolbar">
            <div className="vc-ab-segment" role="tablist" aria-label="View">
                <button type="button" role="tab" aria-selected={mode === "canvas"} className={mode === "canvas" ? "active" : ""} onClick={() => setMode("canvas")}>Canvas</button>
                <button type="button" role="tab" aria-selected={mode === "list"} className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>List</button>
            </div>
            <div className="vc-ab-toolbar-group">
                <Button size="small" variant="secondary" disabled={!state.past.length} title="Undo (Ctrl+Z)" onClick={() => dispatch({ type: "undo" })}>Undo</Button>
                <Button size="small" variant="secondary" disabled={!state.future.length} title="Redo (Ctrl+Y)" onClick={() => dispatch({ type: "redo" })}>Redo</Button>
            </div>
            <span className={`vc-ab-status${running ? " running" : ""}`}>{running ? "Running…" : draftStatus}</span>
        </div>}
        actions={[
            { text: "Save", variant: "primary", onClick: () => void save(), disabled: saving || hasBadJson },
            { text: "Test with sample data", variant: "secondary", onClick: () => void startRun(true), disabled: running || issues.some(issue => issue.severity === "error") },
            { text: "Run for real", variant: "secondary", onClick: () => void startRun(false), disabled: running || !isSaved },
            ...(running ? [{ text: "Stop", variant: "critical-primary", onClick: () => cancelAutomation(automation.id) }] : []),
        ]}
    >
        <div className="vc-ab-workspace">
            <BlockPalette insertion={insertionSource && insertion ? { block: insertionSource, port: insertion.port } : null} onAdd={addFromPalette} onDragStart={startDrag} onCancelInsert={() => setInsertion(null)} />
            {mode === "list"
                ? <StepView automation={automation} selectedId={selectedId} onSelect={setSelectedId} onInsert={beginInsert} />
                : <Canvas
                    automation={automation}
                    selectedId={selectedId}
                    selectedIds={selectedIds}
                    insertion={insertion}
                    onToggleSelection={id => { selectOne(id); setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}
                    setSelectedId={setSelectedId}
                    setAutomation={setAutomation}
                    onDragStart={startDrag}
                    surfaceRef={surfaceRef}
                    drag={drag}
                    pointer={pointer}
                    dropTarget={dropTarget}
                    view={view}
                    onZoomAt={zoomAt}
                    onPan={(dx, dy) => setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }))}
                    onZoomStep={stepZoom}
                    onFit={() => fitView()}
                    onTidy={tidy}
                    onResetZoom={() => setView(current => ({ ...current, zoom: 1 }))}
                />}
            <aside className="vc-ab-inspector">
                <IssuesPanel issues={issues} onSelect={setSelectedId} />
                {selected
                    ? <BlockInspector
                        key={selected.id}
                        block={selected}
                        automation={automation}
                        setAutomation={setAutomation}
                        onSelect={setSelectedId}
                        onInsert={port => beginInsert(selected.id, port)}
                        onDuplicate={() => duplicateBlock(selected.id)}
                        onDelete={() => removeBlock(selected.id)}
                    />
                    : <AutomationInspector automation={automation} setAutomation={setAutomation} />}
            </aside>
        </div>
        {drag?.kind === "new" && ghost && <div className="vc-ab-ghost" style={{ left: ghost.x + 14, top: ghost.y + 14 }}>{blockDefinition(drag.type).label}</div>}
    </Modal>;
}

export function openAutomationBuilder(automation: Automation): void {
    void DataStore.get<Automation>(`LawyerCord_automationDraft_${automation.id}`).then(draft => {
        const initial = draft && isAutomation(draft) ? draft : automation;
        const Wrapped = ErrorBoundary.wrap(Builder, { noop: true });
        openModal(props => <Wrapped {...props} key={initial.id} initial={initial} />);
    });
}
