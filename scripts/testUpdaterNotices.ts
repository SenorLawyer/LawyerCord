/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Notice {
    title: string;
    action?: string;
    click?: () => void;
}

function fixture(relation: "current" | "upgrade" | "rollback" | "switch", staged = false, fail = false) {
    const notices: Notice[] = [];
    const toasts: string[] = [];
    const trayStates: boolean[] = [];
    let checkTray: (() => Promise<void>) | undefined;
    let restarts = 0;
    let settingsOpened = 0;
    let installs = 0;
    const state = {
        restartRequired: staged,
        selectedRelease: { relation },
        async checkForUpdates() {
            if (fail) throw new Error("Offline");
            return !state.restartRequired && relation === "upgrade";
        },
        async update() { installs++; state.restartRequired = true; context.restartRequired = true; return true; }
    };
    const context = {
        ...state,
        IS_UPDATER_DISABLED: false, IS_WEB: false, IS_DISCORD_DESKTOP: true,
        getIsOutdated: false, notifiedForUpdatesThisSession: false,
        Settings: { autoUpdate: true, autoUpdateNotification: true },
        VencordNative: { tray: {
            setUpdateState: (value: boolean) => trayStates.push(value),
            onCheckUpdates: (fn: () => Promise<void>) => { checkTray = fn; }, onRepair() {}
        } },
        UpdaterTab: "updater",
        openSettingsTabModal: () => { settingsOpened++; },
        showNotice: (title: string, action: string, click: () => void) => notices.push({ title, action, click }),
        popNotice() {}, relaunch: () => { restarts++; }, UpdateLogger: { error() {} }
    };
    const file = createSourceFile("Vencord.ts", readFileSync("src/Vencord.ts", "utf8"), ScriptTarget.Latest, true);
    const functions = file.statements.filter(node => isFunctionDeclaration(node) && ["runUpdateCheck", "initTrayIpc"].includes(node.name?.text ?? ""));
    assert.equal(functions.length, 2);
    const source = transpileModule(functions.map(node => node.getText(file)).join("\n"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const core = runInNewContext(`${source}\n({ runUpdateCheck, initTrayIpc });`, context) as { runUpdateCheck(): Promise<void>; initTrayIpc(): void };
    core.initTrayIpc();
    const modules: Record<string, unknown> = {
        "@api/Notifications": { showNotification: (notice: { title: string; onClick(): void }) => notices.push({ title: notice.title, click: notice.onClick }) },
        "@api/Settings": { Settings: {} }, "@shared/vencordUserAgent": {}, "@utils/clipboard": {},
        "@utils/native": { relaunch: context.relaunch }, "@utils/updater": state,
        "@webpack/common": { SettingsRouter: { openUserSettings: () => { settingsOpened++; } }, Toasts: { Type: { MESSAGE: "message" }, Position: { BOTTOM: "bottom" }, genId: () => "id", show: (toast: { message: string }) => toasts.push(toast.message) } },
        "~git-remote": "fixture/repo", "~plugins": {}, "./components/MultipleChoice": {}, "./components/TextInput": {}
    };
    const keyboardSource = transpileModule(readFileSync("src/equicordplugins/keyboardNavigation/commands.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const keyboard = runInNewContext(`${keyboardSource}\nexports;`, { exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } }) as { actions: Array<{ id: string; callback(): Promise<void> }> };
    return {
        notices, toasts, trayStates,
        restarts: () => restarts, settingsOpened: () => settingsOpened, installs: () => installs,
        automatic: () => core.runUpdateCheck(),
        tray: () => { assert.ok(checkTray); return checkTray(); },
        keyboard: () => { const action = keyboard.actions.find(action => action.id === "checkForUpdates"); assert.ok(action); return action.callback(); }
    };
}

for (const surface of ["tray", "keyboard"] as const) {
    test(`${surface} offers restart for a downloaded release`, async () => {
        const f = fixture("upgrade", true);
        await f[surface]();
        assert.equal(f.notices.length, 1);
        assert.match(f.notices[0].title, /downloaded/);
        assert.equal(f.toasts.length, 0);
        f.notices[0].click?.();
        assert.equal(f.restarts(), 1);
        assert.equal(f.installs(), 0);
    });
    for (const relation of ["rollback", "switch", "upgrade"] as const) test(`${surface} opens release selection for ${relation}`, async () => {
        const f = fixture(relation);
        await f[surface]();
        assert.equal(f.notices.length, 1);
        assert.doesNotMatch(f.notices[0].title, /latest|No updates/);
        if (relation !== "upgrade") assert.match(f.notices[0].title, /different release/);
        assert.equal(f.toasts.length, 0);
        f.notices[0].click?.();
        assert.equal(f.settingsOpened(), 1);
        assert.equal(f.installs(), 0);
    });
    test(`${surface} describes current state only within the selected channel`, async () => {
        const f = fixture("current");
        await f[surface]();
        const message = surface === "tray" ? f.notices[0].title : f.toasts[0];
        assert.match(message, /selected channel/);
        assert.doesNotMatch(message, /latest version/);
    });
}

test("automatic completion asks for restart without claiming the running version changed", async () => {
    const f = fixture("upgrade");
    await f.automatic();
    assert.equal(f.installs(), 1);
    assert.match(f.notices[0].title, /ready.*Restart Discord/);
    assert.equal(f.notices[0].action, "Restart");
    f.notices[0].click?.();
    assert.equal(f.restarts(), 1);
});

test("tray failures do not report that the current version is up to date", async () => {
    const f = fixture("current", false, true);
    await f.tray();
    assert.match(f.notices[0].title, /Failed to check/);
    assert.equal(f.installs(), 0);
});
