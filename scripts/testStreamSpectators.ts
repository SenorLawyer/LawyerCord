/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

interface Element {
    type: unknown;
    props: Record<string, unknown>;
}

interface Replacement { match: RegExp; replace: string; }
interface StreamPlugin {
    patches: { predicate?: () => boolean; replacement: Replacement; }[];
    WrapperComponent(props: object): Element;
}

function fixture() {
    const source = process.env.AUDIT_SPECTATOR_SOURCE ?? "src/equicordplugins/whosWatching/index.tsx";
    const { outputText } = transpileModule(readFileSync(source, "utf8"), {
        fileName: source, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let viewers: string[] = [];
    const stream = { guildId: "guild" };
    const streamingStore = { getCurrentUserActiveStream: () => stream, getViewerIds: () => viewers };
    const selectors: { stores: unknown[]; select: () => unknown; equal?: (a: unknown, b: unknown) => boolean; }[] = [];
    const settings = { store: { showPanel: true } };
    const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
    const modules: Record<string, unknown> = {
        "./styles.css": {},
        "@api/Settings": { definePluginSettings: () => settings },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (render: (props: object) => unknown) => (props: object) => render(props) } },
        "@components/Flex": { Flex: "flex" }, "@components/Heading": { Heading: "heading", HeadingSecondary: "heading" },
        "@components/Paragraph": { Paragraph: "paragraph" },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/discord": { getIntlMessage: () => "Spectators", openUserProfile() {} },
        "@utils/margins": { Margins: { top8: "top8" } },
        "@utils/misc": { classes: (...values: string[]) => values.join(" "), getUserAvatarUrl: () => "avatar" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => "summary", findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            ApplicationStreamingStore: streamingStore, Clickable: "clickable", Tooltip: "tooltip", UserSummaryItem: "summary",
            UserStore: { getUser: (id: string) => ({ id, username: id }) }, RelationshipStore: { getNickname: () => "" },
            lodash: { isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) },
            useStateFromStores: (stores: unknown[], select: () => unknown, _deps?: unknown[], equal?: (a: unknown, b: unknown) => boolean) => {
                selectors.push({ stores, select, equal }); return select();
            }
        },
        "react/jsx-runtime": { jsx, jsxs: jsx }
    };
    const exports: { default?: StreamPlugin; } = {};
    runInNewContext(outputText, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    assert.ok(exports.default);
    const plugin = exports.default;
    const originalIcon = (props: object) => jsx("original", props as Record<string, unknown>);
    const replacement = plugin.patches[0].replacement;
    const input = "jsx(icons.Stream,{mask:icons.Values.Masks.STATUS_SCREENSHARE,width:32,label:'Share'})";
    const patched = input.replace(canonicalizeMatch(replacement.match), replacement.replace.replaceAll("$self", "plugin"));
    assert.notEqual(patched, input);
    const render = () => runInNewContext(patched, { jsx, icons: { Stream: originalIcon, Values: { Masks: { STATUS_SCREENSHARE: "mask" } } }, plugin }) as Element;
    return { plugin, render, selectors, streamingStore, settings, originalIcon, setViewers: (ids: string[]) => { viewers = ids; } };
}

test("stream icon patch keeps one component type across repeated renders and forwards original props", () => {
    const f = fixture();
    const first = f.render();
    for (let i = 0; i < 100; i++) assert.equal(f.render().type, first.type);
    assert.equal(first.props.OriginalComponent, f.originalIcon);
    assert.equal(first.props.mask, "mask");
    const tooltip = (first.type as (props: object) => Element)(first.props);
    const container = (tooltip.props.children as (props: object) => Element)({});
    const icon = container.props.children as Element;
    assert.equal(icon.type, f.originalIcon);
    assert.equal(icon.props.width, 32);
    assert.equal(icon.props.label, "Share");
    assert.equal("OriginalComponent" in icon.props, false);
});

test("viewer selectors react when the same active stream gains viewers and suppress unchanged arrays", () => {
    const f = fixture(); const icon = f.render();
    (icon.type as (props: object) => Element)(icon.props);
    f.plugin.WrapperComponent({});
    const selectors = f.selectors.filter(selector => Array.isArray(selector.select()));
    assert.equal(selectors.length, 2);
    for (const selector of selectors) {
        assert.ok(selector.stores.includes(f.streamingStore));
        const before = selector.select(); f.setViewers(["viewer"]);
        assert.deepEqual(Array.from(selector.select() as string[]), ["viewer"]);
        assert.ok(selector.equal);
        assert.equal(selector.equal(before, selector.select()), false);
        assert.equal(selector.equal(selector.select(), selector.select()), true);
        f.setViewers([]);
    }
});

test("the screenshare panel patch honors the saved showPanel setting", () => {
    const f = fixture(); const patch = f.plugin.patches[1];
    assert.ok(patch.predicate); assert.equal(patch.predicate(), true);
    f.settings.store.showPanel = false; assert.equal(patch.predicate(), false);
});
