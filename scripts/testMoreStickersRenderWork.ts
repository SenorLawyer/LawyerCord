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
            const slot = slots[index++] ??= { value: initial };
            return [slot.value, (value: unknown) => { slot.value = value; }];
        },
        useRef(current: unknown) { return (slots[index++] ??= { value: { current } }).value; },
        useMemo(make: () => unknown, deps: unknown[]) {
            const slot = slots[index++] ??= { value: undefined };
            if (!slot.deps || deps.some((value, i) => value !== slot.deps?.[i])) {
                slot.value = make(); slot.deps = [...deps];
            }
            return slot.value;
        },
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
    function rowElements(tree: Element): Element[] {
        if (!tree || typeof tree !== "object") return [];
        return [typeof tree.type === "function" && tree.type.name === "PickerContentRow" ? [tree] : [], ...(tree.children ?? []).map(rowElements)].flat();
    }
    return { props, render, rowElements, indicator: api.indicator, counts: () => ({ rows, titleReads, consumers, images }), reset: () => { rows = titleReads = consumers = images = 0; }, recents: (value: Sticker[] | undefined) => { recents = value; } };
}

test("sticker hover preserves grid elements and skips filtering unchanged packs", () => {
    const f = fixture();
    const first = f.rowElements(f.render());
    assert.equal(first.length, 1020);
    const hover = (first[0].props.grid1 as { onHover(sticker: Sticker): void; }).onHover;
    f.reset();
    for (let i = 0; i < 100; i++) {
        hover(f.props.stickerPacks[i % 30].stickers[(i + 1) % 100]);
        const current = f.rowElements(f.render());
        assert.equal(current[0], first[0]);
        assert.equal(current.at(-1), first.at(-1));
    }
    assert.equal(f.counts().rows, 0);
    assert.ok(f.counts().titleReads <= 200);
    f.recents(undefined);
    const missing = f.rowElements(f.render());
    hover(f.props.stickerPacks[0].stickers[0]);
    assert.equal(f.rowElements(f.render())[0], missing[0]);
});

test("selection context updates only indicator output and retains the last hovered sticker", () => {
    const f = fixture();
    const rows = f.rowElements(f.render());
    const grid = rows[0].props.grid1 as { selection: { value?: string; }; onHover(sticker: Sticker): void; };
    const stickers = f.props.stickerPacks.flatMap(pack => pack.stickers);
    f.reset();
    for (let i = 0; i < 100; i++) {
        const sticker = stickers[i];
        grid.onHover(sticker);
        const tree = f.render();
        grid.selection.value = tree.props.value as string;
        let selected = 0;
        for (const item of stickers) {
            const indicator = f.indicator({ selection: grid.selection, stickerId: item.id });
            assert.equal(indicator.type, "div");
            if (indicator.props.className.endsWith(" inspected")) {
                assert.equal(item.id, sticker.id);
                selected++;
            }
        }
        assert.equal(selected, 1);
    }
    assert.equal(f.counts().consumers, 300_000);
    assert.equal(f.counts().images, 200);
    assert.equal(f.counts().rows, 0);
    assert.equal(f.render().props.value, stickers[99].id);
});

test("sticker grids invalidate query, pack, recent and send inputs while navigation preserves rows", () => {
    const f = fixture();
    let rows = f.rowElements(f.render());
    assert.equal(rows[0].props.key, "0-0");
    f.props.selectedStickerPackId = "p2";
    assert.equal(f.rowElements(f.render())[0], rows[0]);
    f.props.query = "absent";
    assert.equal(f.rowElements(f.render()).length, 0);
    f.props.query = "sticker";
    rows = f.rowElements(f.render());
    f.props.stickerPacks = f.props.stickerPacks.map((pack, index) => index ? pack : { ...pack, stickers: [pack.stickers[0]] });
    assert.equal(f.rowElements(f.render()).length, 987);
    f.recents([f.props.stickerPacks[0].stickers[0]]);
    rows = f.rowElements(f.render());
    assert.equal(rows.length, 988);
    f.props.channelId = "new-channel";
    const changed = f.rowElements(f.render());
    assert.notEqual(changed[0], rows[0]);
    assert.equal(changed[0].props.channelId, "new-channel");
    f.props.closePopout = () => {};
    assert.notEqual(f.rowElements(f.render())[0], changed[0]);
});
