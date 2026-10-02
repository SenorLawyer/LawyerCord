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

function loadTabs(overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, storage: Record<string, unknown> = {}, common: Record<string, unknown> = {}) {
    const source = readFileSync("src/equicordplugins/channelTabs/util/tabs.tsx", "utf8") + "\nexport { openTabHistory, closedTabs, tabStateCache };";
    return runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText + "\nexports;", {
        exports: {}, setTimeout: () => 1, clearTimeout() {}, require(name: string) {
            if (name === "./constants") return { settings: { store: settings }, logger: { warn() {}, error() {} } };
            if (name === "@utils/css") return { classNameFactory: () => () => "" };
            if (name === "@webpack/common") return { NavigationRouter: { transitionToGuild() {} }, SelectedChannelStore: { getChannelId: () => "" }, SelectedGuildStore: { getGuildId: () => "" }, ...common };
            if (name === "@api/index") return { DataStore: storage };
            if (name === "@api/PluginManager") return { isPluginEnabled: () => false };
            return {};
        }, ...overrides
    });
}

test("Channel tab navigation history does not grow when revisiting existing tabs", () => {
    const tabs = loadTabs();
    tabs.createTab({ channelId: "a", guildId: "g" });
    tabs.createTab({ channelId: "b", guildId: "g" });
    for (let i = 0; i < 5000; i++) tabs.setOpenTab(i % 2);
    assert.equal(tabs.openTabHistory.length, 2);
});

test("Closing a tab returns to tab zero when it was most recently selected", () => {
    const tabs = loadTabs();
    for (const channelId of ["a", "b", "c"]) tabs.createTab({ channelId, guildId: "g" });
    for (const id of [0, 2, 0, 1]) tabs.setOpenTab(id);
    tabs.closeTab(1);
    assert.equal(tabs.isTabSelected(0), true);
});

test("Closed tab history retains only the latest 100 reopen entries", () => {
    const tabs = loadTabs();
    tabs.createTab({ channelId: "a", guildId: "g" });
    tabs.setOpenTab(0);
    for (let i = 1; i <= 1000; i++) {
        tabs.createTab({ channelId: String(i), guildId: "g" });
        tabs.closeTab(i);
    }
    assert.equal(tabs.closedTabs.length, 100);
    tabs.reopenClosedTab();
    assert.equal(tabs.openedTabs.at(-1).channelId, "1000");
});

for (const close of ["closeOtherTabs", "closeTabsToTheLeft", "closeTabsToTheRight"]) {
    test(`Bulk tab close releases cached state and bounds reopen history: ${close}`, () => {
        const tabs = loadTabs();
        for (let i = 0; i < 200; i++) {
            tabs.createTab({ channelId: String(i), guildId: "g" });
            tabs.setOpenTab(i);
            tabs.tabStateCache.set(i, { timestamp: 0 });
        }
        const retainedId = close === "closeTabsToTheLeft" ? 199 : 0;
        tabs[close](retainedId);
        assert.equal(tabs.closedTabs.length, 100);
        assert.equal(tabs.tabStateCache.size, 1);
        assert.equal(tabs.tabStateCache.has(retainedId), true);
        assert.deepEqual(Array.from(tabs.openTabHistory), [retainedId]);
        assert.equal(tabs.isTabSelected(retainedId), true);
    });
}


test("Tab hydration cannot navigate or update after its container unmounts", async () => {
    let release: (value: object) => void = () => {};
    const selected: string[] = [];
    const tabs = loadTabs({}, { onStartup: "remember" }, { get: () => new Promise(resolve => { release = resolve; }) });
    const cleanup = tabs.setUpdaterFunction(() => {});
    const pending = tabs.openStartupTabs({ userId: "account", channelId: "current", guildId: "g" }, (id: string) => selected.push(id));
    await Promise.resolve();
    cleanup();
    release({ account: { openTabs: [{ channelId: "old", guildId: "g" }], openTabIndex: 0 } });
    await pending;
    assert.deepEqual(selected, [""]);
    assert.equal(tabs.openedTabs.length, 0);
});

test("Rapid tab navigation replaces pending scroll restoration and unmount cancels it", () => {
    let sequence = 0;
    const frames = new Map<number, () => void>();
    const timers = new Map<number, () => void>();
    const scroller = { scrollTop: 0 };
    const tabs = loadTabs({
        document: { querySelector: () => scroller },
        requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: () => void) => { timers.set(++sequence, callback); return sequence; },
        clearTimeout: (id: number) => timers.delete(id)
    }, { renderAllTabs: true });
    const cleanup = tabs.setUpdaterFunction(() => {});
    for (const channelId of ["a", "b"]) tabs.createTab({ channelId, guildId: "g" });
    for (let index = 0; index < 100; index++) {
        tabs.tabStateCache.set(index % 2, { scrollPosition: 100, timestamp: Date.now() });
        tabs.moveToTab(index % 2);
    }
    assert.equal(frames.size, 1);
    cleanup();
    assert.equal(frames.size, 0);
    assert.equal(timers.size, 0);
    const cleanupNext = tabs.setUpdaterFunction(() => {});
    tabs.moveToTab(0);
    for (const [id, callback] of frames) { frames.delete(id); callback(); }
    assert.equal(timers.size, 2);
    cleanupNext();
    assert.equal(timers.size, 0);
});


test("Scroll restoration keeps the selected tab position and rejects a later manual channel", () => {
    let frame: (() => void) | undefined;
    let restore: (() => void) | undefined;
    let channel = "before";
    const scroller = { scrollTop: 0 };
    const tabs = loadTabs({
        document: { querySelector: () => scroller },
        requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
        cancelAnimationFrame() { frame = undefined; },
        setTimeout: (callback: () => void, delay: number) => { if (delay === 50) restore = callback; return 1; },
        clearTimeout() {}
    }, { renderAllTabs: true }, {}, { SelectedChannelStore: { getChannelId: () => channel } });
    tabs.createTab({ channelId: "a", guildId: "g" });
    tabs.tabStateCache.set(0, { scrollPosition: 73, timestamp: Date.now() });
    tabs.moveToTab(0);
    channel = "a";
    tabs.handleChannelSwitch({ channelId: "a", guildId: "g" });
    frame?.();
    restore?.();
    assert.equal(scroller.scrollTop, 73);
    channel = "before";
    tabs.moveToTab(0);
    frame?.();
    channel = "manual";
    scroller.scrollTop = 11;
    tabs.handleChannelSwitch({ channelId: "manual", guildId: "g" });
    restore?.();
    assert.equal(scroller.scrollTop, 11);
});
