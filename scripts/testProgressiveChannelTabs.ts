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

function loadTabs() {
    const source = readFileSync("src/equicordplugins/channelTabs/util/tabs.tsx", "utf8") + "\nexport { openTabHistory, closedTabs, tabStateCache };";
    return runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText + "\nexports;", {
        exports: {}, setTimeout: () => 1, clearTimeout() {}, require(name: string) {
            if (name === "./constants") return { settings: { store: {} }, logger: { warn() {}, error() {} } };
            if (name === "@utils/css") return { classNameFactory: () => () => "" };
            if (name === "@webpack/common") return { NavigationRouter: { transitionToGuild() {} }, SelectedChannelStore: { getChannelId: () => "" }, SelectedGuildStore: { getGuildId: () => "" } };
            return {};
        }
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
