/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface Element {
    type: unknown;
    props: { children?: unknown; title?: string; "aria-label"?: string; action?: () => void; disabled?: boolean; actions?: Array<{ text: string; disabled?: boolean }>; };
}

function compile(source: string) {
    return transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
}

for (const desktop of [true, false]) {
    test(`VoiceMessages opens its ${desktop ? "desktop" : "web"} recorder from the menu when the named Modal barrel is not loaded`, () => {
        const React = { createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, ...(children.length ? { children } : {}) } }), Fragment: "fragment" };
        const source = createSourceFile("webpack.ts", readFileSync("src/webpack/webpack.ts", "utf8"), ScriptTarget.ES2022, true);
        const finderSource = source.statements.filter(statement => isFunctionDeclaration(statement) && ["findExportedComponentLazy", "findComponentByCodeLazy"].includes(statement.name?.text ?? "")).map(statement => statement.getText(source)).join("\n");
        const lazy = runInNewContext(`${compile(readFileSync("src/utils/lazy.ts", "utf8"))};exports`, { exports: {}, console });
        const lazyReact = runInNewContext(`${compile(readFileSync("src/utils/lazyReact.tsx", "utf8"))};exports`, { exports: {}, React, require: () => lazy });
        const factorySource = `189213(e,t,n){"use strict";n.d(t,{a:()=>c});var i=n(477900);n(582128);var r=n(224640),a=n(696208),s=n(430993),l=n(364840),o=n(20742),d=n(655053);function c(e){let{size:t,title:n,subtitle:c,input:u,preview:_,actions:E,actionBarInput:A,actionBarInputLayout:h="default",listProps:I,notice:f,onScroll:p,scrollerRef:T,children:m,"aria-label":g,...S}=e,N=null!=t?t:null!=u||null!=A||(0,s.y)(m)||null!=I?"md":"sm";return(0,i.jsxs)(r.d,{...S,"aria-label":g??n,size:N,children:[(0,i.jsx)(o.rQ,{title:n,subtitle:c}),(0,i.jsx)(d.i,{message:f?.message,type:f?.type}),(0,i.jsx)(s.c,{controls:u,listProps:I,onScroll:p,scrollerRef:T,children:m}),(0,i.jsx)(l.j,{children:_}),(0,i.jsx)(a.H,{leading:A,leadingLayout:h,actions:E,actionsFullWidth:null==A})]})}}`;
        const modalExports: Record<string, unknown> = {};
        const dependencies: Record<number, unknown> = {
            477900: { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) },
            582128: {}, 224640: { d: "dialog" }, 696208: { H: "footer" },
            430993: { y: () => true, c: "section" }, 364840: { j: "preview" }, 20742: { rQ: "header" }, 655053: { i: "notice" }
        };
        const webpackRequire = Object.assign((id: number) => { assert.ok(id in dependencies); return dependencies[id]; }, {
            d: (target: object, getters: Record<string, () => unknown>) => {
                for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
            }
        });
        runInNewContext(`({${factorySource}})[189213]`)({}, modalExports, webpackRequire);
        const registry: unknown[] = [modalExports, modalExports.a];
        const filters = {
            byProps: (...keys: string[]) => (value: unknown) => typeof value === "object" && value !== null && keys.every(key => key in value),
            componentByCode: (...codes: string[]) => (value: unknown) => typeof value === "function" && codes.every(code => value.toString().includes(code)),
            byCode: () => () => false
        };
        const finders = runInNewContext(`${compile(finderSource)};exports`, {
            exports: {}, IS_REPORTER: false, LazyComponent: lazyReact.LazyComponent, filters,
            find: (filter: (value: unknown) => boolean) => registry.find(filter), handleModuleNotFound: () => assert.fail("The dialog component was not found.")
        });
        let opened: unknown;
        let nativeCalls = 0;
        let requests = 0;
        const modalApi = { openModal: (render: (props: object) => unknown) => { opened = render({ onClose() {}, transitionState: 1 }); } };
        const webpack = { ...finders, filters, findByCodeLazy: () => undefined, mapMangledModuleLazy: () => modalApi };
        const modalSource = process.env.AUDIT_VOICE_MODAL_SOURCE ?? "src/webpack/common/modals.ts";
        const modals = runInNewContext(`${compile(readFileSync(modalSource, "utf8"))};exports`, { exports: {}, require: () => webpack });
        const common = {
            React, ...modals, Button: "button", Forms: { FormTitle: "h5" }, Menu: { MenuItem: "menuitem" },
            useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useEffect: (effect: () => unknown) => effect(),
            CloudUploader: class { constructor() { requests++; } }, RestAPI: { post() { requests++; } }
        };
        const modules: Record<string, unknown> = {
            "@webpack/common": common, "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
            "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
            "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => () => "voice" },
            "@utils/react": { useAwaiter: (_factory: unknown, options: { fallbackValue: unknown }) => [options.fallbackValue, null, true] },
            "@utils/Logger": { Logger: class {} }, "./waveform": { DEFAULT_WAVEFORM: "AAAA" }
        };
        const globals = { React, IS_DISCORD_DESKTOP: desktop, exports: {},
            require: (name: string) => modules[name] ?? {},
            VencordNative: { pluginHelpers: { VoiceMessages: {} } },
            DiscordNative: { nativeModules: { requireModule() { nativeCalls++; throw Error("Opening must not access the microphone."); } } },
            navigator: { mediaDevices: { getUserMedia() { nativeCalls++; throw Error("Opening must not access the microphone."); } } },
            AudioContext: class { constructor() { nativeCalls++; throw Error("Opening must not decode audio."); } }
        };
        const load = (path: string) => runInNewContext(`${compile(readFileSync(path, "utf8"))};exports`, { ...globals, exports: {} });
        modules[".."] = { settings: { store: {} }, cl: () => "voice" };
        modules["./components/DesktopRecorder"] = load("src/plugins/voiceMessages/components/DesktopRecorder.tsx");
        modules["./components/WebRecorder"] = load("src/plugins/voiceMessages/components/WebRecorder.tsx");
        modules["./components/VoicePreview"] = load("src/plugins/voiceMessages/components/VoicePreview.tsx");
        const plugin = load("src/plugins/voiceMessages/index.tsx").default;
        const menu: Element[] = [];
        plugin.contextMenus["channel-attach"](menu, { channel: { id: "channel" } });
        assert.equal(menu.length, 1);
        menu[0].props.action?.();
        const hosts: Element[] = [];
        function render(node: unknown): void {
            if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
            if (Array.isArray(node)) { node.forEach(render); return; }
            assert.equal(typeof node, "object");
            const element = node as Element;
            if (typeof element.type === "function") { render(element.type(element.props)); return; }
            assert.equal(typeof element.type, "string", `Invalid React element type: ${String(element.type)}`);
            hosts.push(element);
            render(element.props.children);
        }
        render(opened);
        const dialog = hosts.find(host => host.type === "dialog");
        assert.ok(dialog, "The recorder must render a dialog, not only leave Discord's backdrop open.");
        assert.equal(dialog.props["aria-label"], "Record Voice Message");
        assert.equal(hosts.find(host => host.type === "header")?.props.title, "Record Voice Message");
        const actions = hosts.find(host => host.type === "footer")?.props.actions;
        assert.equal(actions?.[0].text, "Send");
        assert.equal(actions?.[0].disabled, true);
        assert.ok(hosts.some(host => host.type === "button"));
        assert.ok(hosts.some(host => host.type === "h5"));
        assert.equal(nativeCalls, 0);
        assert.equal(requests, 0);
    });
}
