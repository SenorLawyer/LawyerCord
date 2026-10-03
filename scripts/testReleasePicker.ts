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

import type { ReleaseUpdate } from "../src/shared/updateRelease";

interface Node {
    type: string;
    props: Record<string, unknown>;
    children: unknown[];
}

const stable: ReleaseUpdate = { tag: "v3.0.1.0", name: "Stable", channel: "stable", version: "3.0.1.0", currentVersion: "4.0.1.0", publishedAt: "2026-09-01", commit: "stable", relation: "rollback", changes: [] };
const nightly: ReleaseUpdate = { ...stable, tag: "nightly-20261001-1000-abcdef", channel: "nightly", version: "4.1.0.0", relation: "upgrade" };

function fixture(initial = stable) {
    let cursor = 0;
    const slots: unknown[] = [];
    const effects: (() => void)[] = [];
    let cleanup: (() => void) | undefined;
    const installed: string[] = [];
    const checked: (string | undefined)[] = [];
    const busy: boolean[] = [];
    let modal: Node | undefined;
    let rejectCheck: unknown = false;
    let releaseCheck: (() => void) | undefined;
    let holdCheck = false;
    let unmounted = false;
    let tree: Node;
    const api = {
        selectedRelease: initial,
        restartRequired: false,
        isUpdating: false,
        getUpdateState() { return Number(api.isUpdating) | Number(api.restartRequired) << 1; },
        subscribeUpdateState() { return () => {}; },
        waitForPendingUpdate() { return undefined; },
        UpdateLogger: { error() {} },
        async checkForUpdates(tag?: string) {
            checked.push(tag);
            if (holdCheck) await new Promise<void>(resolve => { releaseCheck = resolve; });
            if (rejectCheck) throw rejectCheck === true ? new Error("GitHub unavailable.") : rejectCheck;
            api.selectedRelease = tag === nightly.tag ? nightly : initial;
            return api.selectedRelease.relation === "upgrade";
        },
        async getReleaseCatalog(page: number) { return { releases: page === 1 ? [stable, nightly] : [], hasMore: page === 1 }; },
        async update(tag: string) { installed.push(tag); api.restartRequired = true; return true; }
    };
    const React = {
        createElement: (type: string, props: Node["props"], ...children: unknown[]) => ({ type, props: props ?? {}, children }),
        useState: (value: unknown) => {
            const index = cursor++;
            if (index >= slots.length) slots[index] = value;
            return [slots[index], (next: unknown) => { slots[index] = next; }];
        },
        useRef: (value: unknown) => {
            const index = cursor++;
            if (index >= slots.length) slots[index] = { current: value };
            return slots[index];
        },
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
        useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
            const index = cursor++;
            const previous = slots[index] as unknown[] | undefined;
            if (!previous || deps.some((value, i) => value !== previous[i])) effects.push(() => { const result = fn(); if (result) cleanup = result; });
            slots[index] = deps;
        }
    };
    const mocks: Record<string, unknown> = {
        "@utils/updater": api,
        "@utils/native": { relaunch() {} },
        "@utils/margins": { Margins: {} },
        "@webpack/common": { React, SearchableSelect: "select", ConfirmModal: "modal", openModal: (render: (props: object) => Node) => { modal = render({}); } }
    };
    for (const name of ["Button", "Card", "Flex", "Link", "Paragraph"]) mocks[`@components/${name}`] = { [name]: name };
    const { outputText } = transpileModule(readFileSync("src/components/settings/tabs/updater/Releases.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { Releases } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, Error, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    function nodes(node: unknown): Node[] {
        if (Array.isArray(node)) return node.flatMap(nodes);
        if (!node || typeof node !== "object" || !("children" in node)) return [];
        const item = node as Node;
        return [item, ...item.children.flatMap(nodes)];
    }
    function text(node: unknown): string {
        if (Array.isArray(node)) return node.map(text).join("");
        if (typeof node === "string") return node;
        if (node && typeof node === "object" && "children" in node) return text((node as Node).children);
        return "";
    }
    return {
        api, installed, checked, busy,
        render() { cursor = 0; tree = Releases({ channel: "stable", repo: "https://github.com/owner/repo", repoPending: false, onBusyChange: (value: boolean) => busy.push(value) }); return tree; },
        async mount() { this.render(); effects.splice(0).forEach(effect => effect()); await this.flush(); },
        async flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); this.render(); if (!unmounted) effects.splice(0).forEach(effect => effect()); },
        unmount() { unmounted = true; cleanup?.(); },
        select() { const node = nodes(tree).find(node => node.type === "select"); assert.ok(node); return node; },
        buttons() { return nodes(tree).filter(node => node.type === "Button"); },
        button(label: string) { const button = this.buttons().find(node => text(node).includes(label)); assert.ok(button, label); return button; },
        text() { return text(tree); },
        click(label: string) { return (this.button(label).props.onClick as () => Promise<void>)(); },
        confirm() { assert.ok(modal); return (modal.props.onConfirm as () => Promise<void>)(); },
        hasModal() { return !!modal; },
        modalText() { return text(modal); },
        fail(value: unknown) { rejectCheck = value; },
        hold() { holdCheck = true; },
        release() { releaseCheck?.(); }
    };
}

test("latest stable rollback has an explicit target and confirmation even with no commit changes", async () => {
    const f = fixture(); await f.mount();
    assert.match(f.text(), /Target: v3.0.1.0/);
    f.click("Roll back to latest Stable");
    assert.equal(f.hasModal(), true);
    assert.deepEqual(f.installed, []);
    await f.confirm(); await f.flush();
    assert.deepEqual(f.installed, [stable.tag]);
    assert.match(f.text(), /downloaded.*Restart Discord/);
    assert.equal(f.select().props.isDisabled, true);
});

test("stable channel can explicitly select and install a nightly without changing channel", async () => {
    const f = fixture(); await f.mount();
    assert.equal((f.select().props.options as { value: string; }[]).some(option => option.value === nightly.tag), true);
    (f.select().props.onChange as (tag: string) => void)(nightly.tag);
    await f.flush();
    await f.click(`Update to ${nightly.tag}`); await f.flush();
    assert.deepEqual(f.checked, [undefined, nightly.tag]);
    assert.deepEqual(f.installed, [nightly.tag]);
});

test("current release cannot be installed again", async () => {
    const f = fixture({ ...stable, relation: "current" }); await f.mount();
    assert.match(f.text(), /already installed/);
    assert.equal(f.buttons().some(button => String(button.children).includes("Roll back")), false);
});

test("check errors clear stale targets and retry recovers", async () => {
    const f = fixture(); await f.mount(); f.fail(true);
    await f.click("Check for Updates"); await f.flush();
    assert.match(f.text(), /GitHub unavailable/);
    assert.doesNotMatch(f.text(), /Target:/);
    f.fail(false); await f.click("Retry"); await f.flush();
    assert.match(f.text(), /Target: v3.0.1.0/);
});

test("specific releases remain selectable when latest channel resolution fails", async () => {
    const f = fixture(); f.fail(true); await f.mount();
    assert.equal((f.select().props.options as { value: string; }[]).some(option => option.value === nightly.tag), true);
    f.fail(false);
    (f.select().props.onChange as (tag: string) => void)(nightly.tag);
    await f.flush();
    assert.match(f.text(), /Target: nightly/);
});

test("a stale rollback confirmation cannot install after another target is selected", async () => {
    const f = fixture(); await f.mount();
    f.click("Roll back to latest Stable");
    (f.select().props.onChange as (tag: string) => void)(nightly.tag);
    await f.flush(); await f.confirm();
    assert.deepEqual(f.installed, []);
});

test("serialized native errors show the actual failure reason", async () => {
    const f = fixture(); f.fail({ message: "This release has no verified desktop archive." }); await f.mount();
    assert.match(f.text(), /This release has no verified desktop archive/);
});

test("rollback to a Nightly without version metadata includes storage migration warnings in modal children", async () => {
    const f = fixture({ ...nightly, version: undefined, relation: "rollback" }); await f.mount();
    f.click("Roll back to latest Nightly");
    assert.match(f.modalText(), /does not declare its version/);
    assert.match(f.modalText(), /lyrics history/);
    assert.match(f.modalText(), /scheduled messages and voice auto rejoin/);
});

test("ready state displays the actual staged release instead of an earlier local selection", async () => {
    const f = fixture(); await f.mount();
    f.api.selectedRelease = nightly;
    f.api.restartRequired = true;
    await f.flush();
    assert.match(f.text(), new RegExp(`${nightly.tag} is downloaded`));
    assert.doesNotMatch(f.text(), /Target: v3.0.1.0/);
});

test("a competing check cannot substitute another release for an explicit selection", async () => {
    const f = fixture(); await f.mount();
    (f.select().props.onChange as (tag: string) => void)(stable.tag);
    f.api.selectedRelease = nightly;
    await f.flush();
    assert.match(f.text(), /selected release changed during the check/);
    assert.doesNotMatch(f.text(), /Target:/);
    assert.deepEqual(f.installed, []);
});

test("unmounted channel requests cannot publish their target or release a newer busy state", async () => {
    const f = fixture(); await f.mount(); f.hold();
    const pending = f.click("Check for Updates"); await f.flush();
    assert.equal(f.select().props.isDisabled, true);
    f.unmount();
    const updates = f.busy.length;
    f.release(); await pending; await f.flush();
    assert.equal(f.busy.length, updates);
    assert.doesNotMatch(f.text(), /Target:/);
});
