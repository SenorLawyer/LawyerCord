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

import { proxyLazy } from "../src/utils/lazy";

test("opening a plugin modal renders its loading authors without mutating Discord's user store", () => {
    let dispatches = 0;
    class UserRecord { constructor(public data: object) {} }
    const React = { createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, children } }), Fragment: "fragment" };
    const common = { React, Modal: "modal", ConfirmModal: "confirm", useMemo: (factory: () => unknown) => factory(), useRef: () => ({ current: 0 }), useState: () => [[], () => undefined], useEffect() {},
        UserStore: { getCurrentUser: () => new UserRecord({}) }, FluxDispatcher: { dispatch: () => dispatches++ }, UserSummaryItem: "authors" };
    let opened: { type: unknown; props: { title?: string; onConfirm?: () => void; onCancel?: () => void; }; } | undefined;
    const modules: Record<string, unknown> = {
        "@api/Commands": { generateId: () => "-1" }, "@api/Settings": { useSettings: () => ({ plugins: { Test: { enabled: true } } }) },
        "@api/PluginManager": { hasAnyVisibleSettings: () => false },
        "@utils/css": { classNameFactory: () => () => "plugin" }, "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class {} }, "@utils/react": { useForceUpdater: () => () => undefined },
        "@utils/misc": { classes: () => "" }, "@utils/margins": { Margins: {} }, "@utils/types": { OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => "lazy-component" },
        "@webpack/common": { ...common, openModal: (render: (props: object) => typeof opened) => { opened = render({ transitionState: 1, onClose() {} }); } },
        "~plugins": { PluginMeta: { Test: { folderName: "src/plugins/test", userPlugin: true } } }, "./components": { OptionComponentMap: {} }
    };
    const source = readFileSync(process.env.AUDIT_PLUGIN_MODAL_SOURCE ?? "src/components/settings/tabs/plugins/PluginModal.tsx", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } });
    const exports = runInNewContext(`${outputText};exports`, { exports: {}, require: (name: string) => modules[name] ?? {}, React });
    exports.default({ plugin: { name: "Test", description: "Test.", authors: [] }, onRestartNeeded() {}, onClose() {}, transitionState: 1 });
    assert.equal(dispatches, 0, "rendering a loading placeholder must not dispatch USER_UPDATE");
    exports.openWarningModal(null, undefined, false, 110, () => undefined);
    assert.equal(opened?.type, "confirm", "reset and disable confirmations must use the resolved common component");
    assert.equal(opened?.props.title, "Disable Plugins");
    assert.equal(opened?.props.onCancel, undefined, "the common confirmation already closes on cancel");
});
