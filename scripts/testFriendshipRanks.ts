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

interface Element {
    type: string;
    props: Record<string, unknown>;
    children: Element[];
}

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, { exports: {}, ...globals, require: (name: string) => {
        if (name.endsWith(".css")) return {};
        assert.ok(name in mocks, name);
        return mocks[name];
    } });
}

function friendship() {
    let modal: Element | undefined;
    const onClose = () => {};
    const now = Date.parse("2026-10-03T00:00:00Z");
    const { default: plugin } = load("src/equicordplugins/friendshipRanks/index.tsx", {
        "@api/Badges": { BadgePosition: { END: 1 } },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@components/Flex": { Flex: "flex" }, "@components/Paragraph": { Paragraph: "paragraph" },
        "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": { Forms: { FormTitle: "heading" }, Modal: "modal", openModal: (render: (props: object) => Element) => { modal = render({ transitionState: 1, onClose }); },
            RelationshipStore: { isFriend: () => true, getSince: () => new Date(now - 86400000).toISOString() } }
    }, { Date: class extends Date { constructor(value: string | number = now) { super(value); } },
        React: { createElement: (type: string, props: object, ...children: Element[]) => ({ type, props, children }) } });
    return { plugin, onClose, modal: () => modal };
}

test("the generated Discord image policy permits every friendship rank asset without broadening network or script access", () => {
    let receive: (details: object, cb: (response: { responseHeaders: Record<string, string[]>; }) => void) => void = () => { throw new Error("CSP handler missing"); };
    const csp = load(process.env.AUDIT_FRIENDSHIP_CSP_SOURCE ?? "src/main/csp/index.ts", {
        "@main/settings": { NativeSettings: { store: { customCspRules: {} } } },
        electron: { session: { defaultSession: { webRequest: { onHeadersReceived: (handler: typeof receive) => { receive = handler; } } } } }
    });
    csp.initCsp();
    const responseHeaders = { "content-security-policy": ["default-src 'self'; img-src 'self' data: https://*.discordapp.net https://*.discordapp.com https://*.discord.com; connect-src 'self'; script-src 'self'"] };
    receive({ responseHeaders, resourceType: "mainFrame" }, result => {
        const directives = Object.fromEntries(result.responseHeaders["content-security-policy"][0].split(";").map(value => {
            const [key, ...sources] = value.trim().split(/\s+/);
            return [key, sources];
        }));
        for (const badge of friendship().plugin.userProfileBadges) {
            const hostname = new URL(badge.iconSrc).hostname;
            assert.ok(directives["img-src"].includes(hostname), `${badge.description} image is blocked by CSP`);
            assert.equal(directives["connect-src"].includes(hostname), false);
            assert.equal(directives["script-src"].includes(hostname), false);
        }
        assert.equal(directives["img-src"].includes("*.equicord.org"), false);
    });
});

test("Sprout badge click forwards a renderable modal with its icon, description and close callback", () => {
    const f = friendship();
    const badges = f.plugin.userProfileBadges.filter((badge: { shouldShow(props: { userId: string }): boolean }) => badge.shouldShow({ userId: "friend" }));
    assert.equal(badges.length, 1);
    const badge = badges[0];
    assert.equal(badge.description, "Sprout");
    const { default: badgeApi } = load("src/plugins/_api/badges/index.tsx", {
        "@api/Badges": { BadgePosition: {} },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@components/settings/tabs": {}, "@utils/constants": { Devs: {} }, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": {}, "~plugins": {}, "./modals": {}
    });
    badgeApi.getBadgeMouseEventHandlers(badge).onClick({});
    const root = f.modal(); assert.ok(root);
    const modal = root.children[0];
    assert.equal(modal.type, "modal");
    assert.equal(modal.props.size, "sm");
    assert.equal(modal.props.onClose, f.onClose);
    assert.equal(modal.props.transitionState, 1);
    const title = modal.props.title as Element;
    assert.equal(title.children[0].children[0].props.src, badge.iconSrc);
    assert.match(JSON.stringify(modal.children), /Your friendship is just starting/);
});
