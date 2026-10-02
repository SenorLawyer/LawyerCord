/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const modalFactory = "189213(e,t,n){\"use strict\";n.d(t,{a:()=>c});var i=n(477900);n(582128);var r=n(224640),a=n(696208),s=n(430993),l=n(364840),o=n(20742),d=n(655053);function c(e){let{size:t,title:n,subtitle:c,input:u,preview:_,actions:E,actionBarInput:A,actionBarInputLayout:h=\"default\",listProps:I,notice:f,onScroll:p,scrollerRef:T,children:m,\"aria-label\":g,...S}=e,N=null!=t?t:null!=u||null!=A||(0,s.y)(m)||null!=I?\"md\":\"sm\";return(0,i.jsxs)(r.d,{...S,\"aria-label\":g??n,size:N,children:[(0,i.jsx)(o.rQ,{title:n,subtitle:c}),(0,i.jsx)(d.i,{message:f?.message,type:f?.type}),(0,i.jsx)(s.c,{controls:u,listProps:I,onScroll:p,scrollerRef:T,children:m}),(0,i.jsx)(l.j,{children:_}),(0,i.jsx)(a.H,{leading:A,leadingLayout:h,actions:E,actionsFullWidth:null==A})]})}}";
const confirmFactory = "732159(e,t,n){\"use strict\";n.d(t,{u:()=>o});var i=n(477900),r=n(582128),a=n(460890),s=n(189213),l=n(696208);function o(e){let{confirmText:t,cancelText:n,checkboxProps:o,onConfirm:d,onCancel:c,onCloseCallback:u,variant:_=\"critical\",children:E,...A}=e,{i18n:h}=(0,a.G9)(),I=h.CANCEL,f=h.INLINE_NOTICE_GENERIC_ERROR,[p,T]=r.useState(!1),m=r.useRef(u);r.useLayoutEffect(()=>{m.current=u}),r.useLayoutEffect(()=>()=>{m.current?.()},[]);let[g,S]=r.useState(void 0);function N(e){S(e)}return(0,i.jsx)(s.a,{actions:[{text:n??I,variant:\"secondary\",onClick:()=>{c?.(),A.onClose()}},{text:t,variant:\"critical\"===_?\"critical-primary\":_,onClick:async()=>{S(void 0),T(!0);try{await d?.(N),A.onClose()}catch(e){throw T(!1),S(e=>e??f),e}},disabled:p,loading:p}],actionBarInput:null!=o?(0,i.jsx)(l.e,{...o}):void 0,role:\"alertdialog\",notice:null!=g?{message:g,type:\"critical\"}:void 0,...A,children:E})}}";

for (const name of ["Modal", "ConfirmModal"]) {
    test(`${name} resolves the current Discord implementation before named barrels load`, () => {
        const webpack = readFileSync("src/webpack/webpack.ts", "utf8");
        const parsed = createSourceFile("webpack.ts", webpack, ScriptTarget.Latest, true);
        const fragments = parsed.statements.filter(statement =>
            isFunctionDeclaration(statement) && ["findExportedComponentLazy", "findComponentByCodeLazy"].includes(statement.name?.text ?? "") ||
            isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ["filters", "find"].includes(declaration.name.getText(parsed)))
        ).map(statement => statement.getText(parsed)).join("\n");
        const compile = (source: string) => transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        const jsx = (type: unknown, props: unknown) => ({ type, props });
        const dependencies: Record<number, unknown> = {
            477900: { jsx, jsxs: jsx },
            582128: { useState: (value: unknown) => [value, () => undefined], useRef: (value: unknown) => ({ current: value }), useLayoutEffect: () => undefined },
            224640: { d: "dialog" }, 696208: { H: "actions", e: "checkbox" },
            430993: { c: "content", y: () => true }, 364840: { j: "preview" },
            20742: { rQ: "header" }, 655053: { i: "notice" },
            460890: { G9: () => ({ i18n: { CANCEL: "Cancel", INLINE_NOTICE_GENERIC_ERROR: "Error" } }) }
        };
        const requireDiscord = Object.assign((id: number) => dependencies[id], {
            d: (target: object, getters: Record<string, () => unknown>) => {
                for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
            }
        });
        const modalExports = {};
        runInNewContext(`({${modalFactory}})[189213]`)({}, modalExports, requireDiscord);
        dependencies[189213] = modalExports;
        const confirmExports = {};
        runInNewContext(`({${confirmFactory}})[732159]`)({}, confirmExports, requireDiscord);
        const api = runInNewContext(`${compile(fragments)};exports`, {
            exports: {}, IS_REPORTER: false, IS_ANTI_CRASH_TEST: false,
            cache: { 189213: { loaded: true, exports: modalExports }, 732159: { loaded: true, exports: confirmExports } },
            traceFunction: (_name: string, fn: unknown) => fn,
            canonicalizeMatch: (value: unknown) => value,
            stringMatches: (value: string, codes: string[]) => codes.every(code => value.includes(code)),
            LazyComponent: (factory: () => unknown) => factory,
            handleModuleNotFound: () => undefined
        });
        const common = runInNewContext(`${compile(readFileSync("src/webpack/common/modals.ts", "utf8"))};exports`, {
            exports: {}, require: () => ({ ...api, findByCodeLazy: () => undefined, mapMangledModuleLazy: () => ({}) })
        });
        const component = common[name]();
        assert.equal(typeof component, "function");
        const props = { title: "Plugin settings", subtitle: "Description", transitionState: 1, onClose: () => undefined, children: "Settings", confirmText: "Confirm" };
        const element = component(props);
        assert.equal(element.props.transitionState, 1);
        assert.equal(element.props.onClose, props.onClose);
        if (name === "Modal") {
            assert.equal(element.type, "dialog");
            assert.equal(element.props.children[0].props.title, props.title);
            assert.equal(element.props.children[2].props.children, "Settings");
        } else {
            assert.equal(element.props.actions[1].text, "Confirm");
            assert.equal(element.props.children, "Settings");
        }
    });
}
