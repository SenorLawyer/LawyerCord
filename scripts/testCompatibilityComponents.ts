/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (path: string) => readFileSync(path, "utf8");
const noopComponents = (names: string[]) => names.map(name => `export function ${name}(){return null}`).join("\n");

for (const [file, exported, alias] of [["Button", "ButtonCompat", "Button"], ["BaseText", "TextCompat", "Text"], ["FormSwitch", "FormSwitchCompat", "Switch"]]) {
    test(`${alias} remains available when its implementation initializes before the common barrel`, async () => {
        const modules: Record<string, string> = {
            "@components/Button": source("src/components/Button.tsx"),
            "@components/BaseText": source("src/components/BaseText.tsx"),
            "@components/FormSwitch": source("src/components/FormSwitch.tsx"),
            "common-components": source(process.env.AUDIT_COMPATIBILITY_SOURCE ?? "src/webpack/common/components.ts"),
            "@utils/misc": source("src/utils/misc.ts"),
            "@utils/css": source("src/utils/css.ts"),
            "./constants": "export const EQUICORD_HELPERS='', EquicordDevsById={}, GUILD_ID='', KNOWN_ISSUES_CHANNEL_ID='', SUPPORT_CHANNEL_ID='', VencordDevsById={};",
            "@webpack/common": `export * from 'common-components'; export const Modal='modal'; export const lodash={isEqual:(a,b)=>a===b},useStateFromStores=(_stores,select)=>select(); export const ChannelStore={getChannel:()=>({id:'friend',recipients:['peer'],isGroupDM:()=>false})},GuildMemberStore={},IconUtils={},MessageStore={getLastMessage:()=>({timestamp:"2026-10-03T00:00:00Z"}),getMessages:()=>({last:()=>undefined})},UserStore={getUser:()=>({username:'Peer',getAvatarURL:()=>'fixture-avatar'})}; export const React={createElement:(type,props,...children)=>({type,props,children:children.length?children:props?.children??[]}),useState:value=>[value,()=>{}]};`,
            "@webpack": `export const DefaultExtractAndLoadChunksRegex=/x/; export const filters=new Proxy({}, {get:()=>()=>false}); ${["extractAndLoadChunksLazy", "find", "findComponentByCodeLazy", "findCssClassesLazy", "mapMangledCssClasses", "mapMangledModuleLazy", "proxyLazyWebpack", "waitFor", "findByPropsLazy"].map(name => `export const ${name}=()=>({});`).join("\n")}`,
            "./internal": "export const waitForComponent=()=>()=>null;",
            "@utils/lazyReact": "export const LazyComponent=()=>()=>null;",
            "@components/Divider": noopComponents(["Divider"]),
            "@components/Heading": noopComponents(["Heading"]),
            "@components/Paragraph": noopComponents(["Paragraph"]),
            "@components/TooltipContainer": noopComponents(["TooltipContainer"]),
            "@components/TooltipFallback": noopComponents(["TooltipFallback"]),
            "./Icons": noopComponents(["OpenExternalIcon"]),
            "./Link": noopComponents(["Link"]),
            "./Flex": noopComponents(["Flex"]),
            "./Span": noopComponents(["Span"]),
            "./Switch": noopComponents(["Switch"]),
            ".": "export const settings={use:()=>({})};",
            "./Boo": "export const GHOST_SETTINGS=[]; export const getGhostedChannels=()=>['friend'];",
            "ghosted": source("src/equicordplugins/ghosted/GhostedUsersModal.tsx")
        };
        const bundled = await build({
            stdin: { contents: `import {${exported}} from '@components/${file}'; import {${alias}} from '@webpack/common'; import {GhostedUsersModal} from 'ghosted'; export const direct=${exported}; export const compat=${alias}; export const render=()=>GhostedUsersModal({modalProps:{transitionState:1,onClose(){}},onClearGhost(){}});` },
            bundle: true, write: false, format: "cjs", treeShaking: false,
            plugins: [{ name: "cold-common", setup(builder) {
                builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: "fixture" }));
                builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
                    if (args.path.endsWith(".css")) return { contents: "", loader: "js" };
                    assert.ok(args.path in modules, args.path);
                    return { contents: modules[args.path], loader: "tsx" };
                });
            } }]
        });
        const context = { module: { exports: {} as { direct: unknown; compat: unknown; render(): unknown } }, React: { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props, children: children.length ? children : props?.children ?? [] }) } };
        runInNewContext(bundled.outputFiles[0].text, context);
        const result = context.module.exports;
        assert.equal(typeof result.direct, "function");
        assert.doesNotThrow(() => result.render());
        assert.equal(result.compat, result.direct);
        const elements: { type: unknown; props: Record<string, unknown> }[] = [];
        const text: string[] = [];
        function visit(value: unknown) {
            if (typeof value === "string") { text.push(value); return; }
            if (Array.isArray(value)) { value.forEach(visit); return; }
            if (!value || typeof value !== "object" || !("type" in value) || !("props" in value) || !("children" in value)) return;
            assert.notEqual(value.type, undefined);
            const props = value.props as Record<string, unknown>;
            elements.push({ type: value.type, props });
            if (typeof value.type === "function") visit(value.type({ ...props, children: value.children }));
            else visit(value.children);
        }
        visit(result.render());
        assert.ok(elements.some(element => element.props.src === "fixture-avatar"));
        assert.ok(elements.some(element => element.type === "button" && String(element.props.className).includes("vc-btn-small")));
        assert.ok(text.includes("Peer"));
        assert.ok(text.includes("Clear"));
    });
}
