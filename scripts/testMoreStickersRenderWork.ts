/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Sticker { id: string; stickerPackId: string; title: string; image: string; }
interface Element { type: string | ((props: Record<string, unknown>) => Element); props: Record<string, unknown>; children: Element[]; }

function fixture() {
    const file = "src/equicordplugins/moreStickers/components/picker.tsx";
    const source = process.env.PICKER_BASELINE ? execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }) : readFileSync(file, "utf8");
    let index = 0;
    let rows = 0;
    let titleReads = 0;
    let consumers = 0;
    let images = 0;
    let recents: Sticker[] | undefined = [];
    const slots: { value: unknown; deps?: unknown[]; }[] = [];
    const React = {
        useState(initial: unknown) {
            const slot = slots[index++] ??= { value: typeof initial === "function" ? initial() : initial };
            return [slot.value, (value: unknown) => { slot.value = typeof value === "function" ? value(slot.value) : value; }];
        },
        useRef(current: unknown) { return (slots[index++] ??= { value: { current } }).value; },
        useMemo(make: () => unknown, deps: unknown[]) {
            const slot = slots[index++] ??= { value: undefined };
            if (!slot.deps || deps.some((value, i) => value !== slot.deps?.[i])) {
                slot.value = make(); slot.deps = [...deps];
            }
            return slot.value;
        },
        useCallback(callback: unknown, deps: unknown[]) { return this.useMemo(() => callback, deps); },
        useEffect() {},
        createContext: (value: unknown) => ({ value, Provider: "provider" }),
        useContext: (context: { value: unknown; }) => { consumers++; return context.value; },
        createElement(type: Element["type"], props: Record<string, unknown>, ...children: Element[]) {
            if (typeof type === "function" && type.name === "PickerContentRow") rows++;
            if (type === "img") images++;
            return { type, props: props ?? {}, children: children.flat() };
        }
    };
    const modules: Record<string, unknown> = {
        "@equicordplugins/moreStickers/types": {},
        "@equicordplugins/moreStickers/upload": {},
        "@equicordplugins/moreStickers/utils": { clPicker: (value: string) => value },
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@utils/react": { useAwaiter: () => [recents] },
        "@webpack": { findComponentByCodeLazy: () => "virtual-list" },
        "@webpack/common": { React }, "./categories": {}, "./icons": {},
        "./misc": { RECENT_STICKERS_ID: "recent", RECENT_STICKERS_TITLE: "Recent" }
    };
    const code = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.React } }).outputText;
    const api = runInNewContext(`${code};({...exports, indicator: typeof SelectionIndicator === "function" ? SelectionIndicator : undefined})`, { exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    const packs = Array.from({ length: 30 }, (_, p) => ({ id: `p${p}`, title: `Pack ${p}`, logo: { image: "fixture" }, stickers: Array.from({ length: 100 }, (_, s) => ({
        id: `${p}-${s}`, stickerPackId: `p${p}`, get title() { titleReads++; return `Sticker ${s}`; }, image: "fixture"
    })) }));
    const props = { stickerPacks: packs, query: "sticker", channelId: "channel", selectedStickerPackId: null as string | null, closePopout() {}, setSelectedStickerPackId() {} };
    function render(): Element { index = 0; return api.PickerContent(props); }
    interface ListProps extends Record<string, unknown> {
        rowCountBySection: number[];
        renderRow(index: number, location: { sectionIndex: number; sectionRowIndex: number; }): Element;
        renderSectionHeader(index: number): Element;
        listPadding: number[];
    }
    function findList(tree: Element): ListProps | undefined {
        if (tree.type === "virtual-list") return tree.props as ListProps;
        for (const child of tree.children ?? []) {
            if (!child || typeof child !== "object") continue;
            const result = findList(child);
            if (result) return result;
        }
        return undefined;
    }
    function list(tree: Element): ListProps {
        const result = findList(tree);
        assert.ok(result);
        return result;
    }
    function rowElements(tree: Element): Element[] {
        const props = list(tree);
        const result: Element[] = [];
        let index = 0;
        props.rowCountBySection.forEach((count, sectionIndex) => {
            for (let row = 0; row < count; row++, index++) if (result.length < 4) result.push(props.renderRow(index, { sectionIndex, sectionRowIndex: row }));
        });
        return result;
    }
    return { props, render, list, rowElements, indicator: api.indicator, counts: () => ({ rows, titleReads, consumers, images }), reset: () => { rows = titleReads = consumers = images = 0; }, recents: (value: Sticker[] | undefined) => { recents = value; } };

}

test("sticker hover retains native list callbacks and skips filtering unchanged packs", () => {
    const f = fixture();
    const tree = f.render();
    const first = f.list(tree);
    const mounted = f.rowElements(tree);
    assert.equal(mounted.length, 4);
    assert.equal(first.rowCountBySection.reduce((a, b) => a + b, 0), 1020);
    const hover = (mounted[0].props.grid1 as { onHover(sticker: Sticker): void; }).onHover;
    f.reset();
    for (let i = 0; i < 100; i++) {
        hover(f.props.stickerPacks[i % 30].stickers[(i + 1) % 100]);
        const current = f.list(f.render());
        assert.equal(current.renderRow, first.renderRow);
        assert.equal(current.renderSectionHeader, first.renderSectionHeader);
        assert.equal(current.rowCountBySection, first.rowCountBySection);
        assert.equal(current.listPadding, first.listPadding);
    }
    assert.equal(f.counts().rows, 0);
    assert.ok(f.counts().titleReads <= 200);
});

test("selection context preserves the hovered sticker with only mounted cell consumers", () => {
    const f = fixture();
    const rows = f.rowElements(f.render());
    const grid = rows[0].props.grid1 as { selection: { value?: string; }; onHover(sticker: Sticker): void; };
    const stickers = f.props.stickerPacks[0].stickers.slice(0, 12);
    f.reset();
    for (let i = 0; i < 100; i++) {
        const sticker = stickers[i % 12];
        grid.onHover(sticker);
        const tree = f.render();
        grid.selection.value = tree.props.value as string;
        let selected = 0;
        for (const item of stickers) {
            const indicator = f.indicator({ selection: grid.selection, stickerId: item.id });
            if (indicator.props.className.endsWith(" inspected")) {
                assert.equal(item.id, sticker.id);
                selected++;
            }
        }
        assert.equal(selected, 1);
    }
    assert.equal(f.counts().consumers, 1200);
    assert.equal(f.counts().images, 200);
    assert.equal(f.counts().rows, 0);
    assert.equal(f.render().props.value, stickers[99 % 12].id);
});

test("virtual sticker rows invalidate query, packs, recents and sends while collapse survives navigation", () => {
    const f = fixture();
    let tree = f.render();
    let list = f.list(tree);
    assert.equal(f.rowElements(tree)[0].props.key, "p0:0-0");
    f.props.selectedStickerPackId = "p2";
    assert.equal(f.list(f.render()).renderRow, list.renderRow);
    f.props.query = "absent";
    assert.equal(f.rowElements(f.render()).length, 0);
    f.props.query = "sticker";
    f.props.stickerPacks = f.props.stickerPacks.map((pack, index) => index ? pack : { ...pack, stickers: [pack.stickers[0]] });
    assert.equal(f.list(f.render()).rowCountBySection.reduce((a, b) => a + b, 0), 987);
    f.recents([f.props.stickerPacks[0].stickers[0]]);
    tree = f.render();
    list = f.list(tree);
    assert.equal(list.rowCountBySection.reduce((a, b) => a + b, 0), 988);
    f.props.channelId = "new-channel";
    assert.notEqual(f.list(f.render()).renderRow, list.renderRow);
    assert.equal(f.rowElements(f.render())[0].props.channelId, "new-channel");
    list = f.list(f.render());
    f.props.closePopout = () => {};
    assert.notEqual(f.list(f.render()).renderRow, list.renderRow);
    list = f.list(f.render());
    (list.renderSectionHeader(1).props.onToggle as () => void)();
    assert.equal(f.list(f.render()).rowCountBySection[1], 0);
    f.props.selectedStickerPackId = "p20";
    f.render();
    f.props.selectedStickerPackId = "p0";
    assert.equal(f.list(f.render()).renderSectionHeader(1).props.isExpanded, false);
    f.recents(undefined);
    assert.equal(f.list(f.render()).rowCountBySection[0], 0);
});
