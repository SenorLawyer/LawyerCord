/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { runInNewContext } from "node:vm";

import * as typescript from "typescript";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";
import { proxyLazy, SYM_LAZY_GET } from "../src/utils/lazy";

test("Streaks badges only display the current account's conversation", () => {
    let currentId: string | undefined = "first";
    const streak = { user_a_id: "first", user_b_id: "target", count: 2 };
    const userStore = { getCurrentUser: () => currentId ? { id: currentId } : undefined };
    let subscriptions = 0;
    const api = loadSource("src/equicordplugins/streaks/index.tsx", {
        "@equicordplugins/_core/concatenatedModules": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": { UserStore: userStore, moment: () => ({ format: () => "2026-09-06" }),
            useStateFromStores: (stores: unknown[], selector: () => unknown) => {
                assert.equal(stores[0], userStore); subscriptions++; return selector();
            } },
        "./settings": { settings: { store: {}, use() {} } }, "./stores/AuthorizationStore": {},
        "./stores/StreaksStore": { useStreaksStore: (selector: (state: object) => unknown) => selector({ streaks: { target: streak } }) },
    }, { React: { createElement: () => ({}) } }, "({ StreakBadge })");
    for (const id of ["first", "second", "target", undefined]) {
        currentId = id;
        assert.equal(api.StreakBadge({ userId: "target" }) !== null, id === "first");
    }
    currentId = "first";
    [streak.user_a_id, streak.user_b_id] = [streak.user_b_id, streak.user_a_id];
    assert.notEqual(api.StreakBadge({ userId: "target" }), null);
    assert.equal(subscriptions, 5);
});

test("Streaks delayed message refresh stops with its account or plugin", async () => {
    for (const change of ["before", "response", "stop-before", "stop-response", "current-cache", "foreign-cache", "none"]) {
        let userId = "first";
        let refreshes = 0;
        let updates = 0;
        let clears = 0;
        const timers = new Map<number, () => Promise<void>>();
        const { default: plugin } = loadSource("src/equicordplugins/streaks/index.tsx", {
            "@equicordplugins/_core/concatenatedModules": {},
            "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/css": { classNameFactory: () => () => "fixture" },
            "@utils/types": { __esModule: true, default: (value: unknown) => value },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) },
                ChannelStore: { getChannel: () => ({ isDM: () => true, recipients: ["target"] }) },
                moment: () => ({ format: () => "2026-09-06" }),
            },
            "./settings": { settings: { store: {} } },
            "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ isAuthorized: () => true }) } },
            "./stores/StreaksStore": { useStreaksStore: { getState: () => ({ streaks: change.endsWith("-cache") ? {
                target: { user_a_id: change === "current-cache" ? "first" : "second", user_b_id: "target",
                    today_date: "2026-09-06", user_a_today: true, user_b_today: true, count: 2 },
            } : {},
                refresh: async () => {
                    refreshes++;
                    if (change === "response") userId = "second";
                    if (change === "stop-response") plugin.stop();
                },
                update: () => { updates++; }, clear: () => { clears++; },
            }) } },
        }, {
            setTimeout: (callback: () => Promise<void>) => { timers.set(1, callback); return 1; },
            clearTimeout: (id: number) => timers.delete(id),
        });
        await plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", message: { author: { id: "target" } }, channelId: "dm" });
        assert.equal(timers.size, change === "current-cache" ? 0 : 1);
        if (change === "before") userId = "second";
        if (change === "stop-before") plugin.stop();
        for (const callback of timers.values()) await callback();
        assert.equal(refreshes, change === "before" || change === "stop-before" || change === "current-cache" ? 0 : 1);
        assert.equal(updates, change === "none" || change === "foreign-cache" ? 1 : 0);
        assert.equal(clears, change.startsWith("stop-") ? 1 : 0);
        if (change === "stop-before") assert.equal(timers.size, 0);
        if (change.endsWith("-cache")) {
            await plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", message: { author: { id: "first" } }, channelId: "dm" });
            assert.equal(updates, change === "current-cache" ? 0 : 2);
        }
    }
});

test("Streaks login only refreshes after successful authorization", async () => {
    let authorized = false;
    let refreshes = 0;
    const api = loadSource("src/equicordplugins/streaks/settings.tsx", {
        "@api/Settings": { definePluginSettings: (value: unknown) => value },
        "@components/Button": { Button: "button" }, "@components/Flex": { Flex: "flex" },
        "@utils/types": { OptionType: {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) }, useStateFromStores: (_stores: unknown, selector: () => unknown) => selector() },
        "./stores/AuthorizationStore": { useAuthorizationStore: () => ({ isAuthorized: () => false, authorize: async () => authorized }) },
        "./stores/StreaksStore": { useStreaksStore: { getState: () => ({ fetch: async () => { refreshes++; } }) } },
    }, { React: { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ props, children }) } });
    const button = api.settings.account.component().children[0];
    await button.props.onClick();
    assert.equal(refreshes, 0);
    authorized = true;
    await button.props.onClick();
    assert.equal(refreshes, 1);
});

test("Streaks authorization cannot attach a token to another account", async () => {
    for (const change of ["before", "response", "non-error", "missing-token", "invalid-token", "empty-token", "cancelled", "duplicate", "none"]) {
        let userId = "first";
        let callback: (response: { location: string; }) => Promise<void> = async () => assert.fail("missing callback");
        let close: () => void = () => assert.fail("missing close callback");
        let state: Record<string, unknown> = {};
        let requests = 0;
        const api = loadSource("src/equicordplugins/streaks/stores/AuthorizationStore.tsx", {
            "@api/DataStore": {}, "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() }, "@utils/Logger": { Logger: class { error() {} } },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) }, zustandPersist: (value: unknown) => value,
                zustandCreate: (init: (set: (value: object) => void, get: () => object) => Record<string, unknown>) => {
                    state = init(value => Object.assign(state, value), () => state); return { getState: () => state };
                },
                openModal: (render: (props: object) => { props: { callback: typeof callback; }; }, options: { onCloseCallback: () => void; }) => {
                    callback = render({}).props.callback; close = options.onCloseCallback;
                },
                showToast() {}, Toasts: { Type: {} },
            }, "../constants": { AUTHORIZE_URL: "https://example.com/auth" }, "./StreaksStore": {},
        }, { URL, React: { createElement: (_type: unknown, props: object) => ({ props }) },
            fetch: async () => { requests++; if (change === "non-error") throw "request failed"; return { ok: true, json: async () => {
                if (change === "response") userId = "second";
                if (change === "missing-token") return {};
                if (change === "invalid-token") return { access_token: {} };
                if (change === "empty-token") return { access_token: " " };
                return { access_token: "first-token" };
            } }; } });
        const auth = api.useAuthorizationStore.getState();
        const pending = auth.authorize();
        if (change === "before") userId = "second";
        if (change === "cancelled") close();
        await Promise.all(Array.from({ length: change === "duplicate" ? 2 : 1 }, () => callback({ location: "https://example.com/auth?code=test" })));
        assert.equal(await pending, change === "none" || change === "duplicate");
        assert.equal(requests, change === "before" || change === "cancelled" ? 0 : 1);
        assert.equal(auth.tokens.second, undefined);
        assert.equal(auth.tokens.first, change === "none" || change === "duplicate" ? "first-token" : undefined);
    }
});

test("Streaks ignores responses for changed accounts or tokens", async () => {
    for (const operation of ["fetch", "update", "refresh"]) {
        for (const change of ["account", "logout", "token", "clear", "none"]) {
            let userId = "first";
            let token: string | null = "token";
            let writes = 0;
            let state: Record<string, unknown> = {};
            const api = loadSource("src/equicordplugins/streaks/stores/StreaksStore.ts", {
                "@api/DataStore": {}, "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() },
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) },
                    zustandCreate: (init: (set: (value: object) => void, get: () => object) => Record<string, unknown>) => {
                        state = init(value => { writes++; Object.assign(state, value); }, () => state);
                        return { getState: () => state };
                    } },
                "../constants": { API_URL: "https://example.com" },
                "./AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => token }) } },
            }, { fetch: async () => ({ ok: true, json: async () => {
                if (change === "account") userId = "second";
                if (change === "logout") token = null;
                if (change === "token") token = "replacement";
                if (change === "clear") api.useStreaksStore.getState().clear();
                const streak = { user_a_id: "first", user_b_id: "target", count: 2 };
                return operation === "fetch" ? [streak] : streak;
            } }) });
            await api.useStreaksStore.getState()[operation]("target");
            assert.equal(writes, change === "none" || change === "clear" ? 1 : 0, `${operation}: ${change}`);
            if (change === "clear") assert.deepEqual(Object.keys(api.useStreaksStore.getState().streaks), []);
        }
    }
});

test("Streaks reads authorization from the current account without initialization", () => {
    let userId = "first";
    let clears = 0;
    let state: Record<string, unknown> = {};
    const api = loadSource("src/equicordplugins/streaks/stores/AuthorizationStore.tsx", {
        "@api/DataStore": {}, "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() }, "@utils/Logger": {},
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            zustandPersist: (value: unknown) => value,
            zustandCreate: (init: (set: (value: object) => void, get: () => object) => Record<string, unknown>) => {
                state = init(value => Object.assign(state, value), () => state);
                return { getState: () => state };
            },
        }, "../constants": {}, "./StreaksStore": { useStreaksStore: { getState: () => ({ clear: () => { clears++; } }) } },
    });
    const auth = api.useAuthorizationStore.getState();
    auth.setToken("first-token");
    assert.equal(auth.getToken(), "first-token");
    userId = "second";
    assert.equal(auth.getToken(), null);
    assert.equal(auth.isAuthorized(), false);
    auth.setToken("second-token");
    userId = "first";
    assert.equal(auth.getToken(), "first-token");
    auth.remove("second");
    assert.equal(auth.getToken(), "first-token");
    assert.equal(clears, 0);
    auth.remove("first");
    assert.equal(auth.isAuthorized(), false);
    assert.equal(clears, 1);
});

test("ReviewDB OAuth errors tolerate malformed response bodies", async () => {
    let callback: (response: { location: string; }) => Promise<void> = async () => assert.fail("missing callback");
    let payload: unknown;
    const messages: string[] = [];
    const api = loadSource("src/plugins/reviewDB/auth.tsx", {
        "@api/DataStore": {}, "@utils/Logger": { Logger: class { error() { assert.fail("error response escaped handling"); } } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "first" }) }, OAuth2AuthorizeModal: "OAuth",
            openModal: (render: (props: object) => { props: { callback: typeof callback; }; }) => { callback = render({}).props.callback; },
            showToast: (message: string) => messages.push(message), Toasts: { Type: {} },
        },
    }, {
        URL, React: { createElement: (_type: unknown, props: object) => ({ props }) },
        fetch: async () => ({ ok: false, json: async () => { if (payload === undefined) throw new Error("Not JSON"); return payload; } }),
    });
    api.authorize();
    for (payload of [undefined, null, {}, { message: {} }, { message: 5 }, { message: " " }, { message: "Please retry." }]) {
        await callback({ location: "https://manti.vendicated.dev/api/reviewdb/auth?code=test" });
    }
    assert.deepEqual(messages, [...Array(6).fill("Failed to authorize with ReviewDB."), "Please retry."]);
});

test("ReviewDB request errors display only nonempty string messages", async () => {
    for (const payload of [null, {}, { message: {} }, { message: 42 }, { message: "" }, { message: "  " }, { message: "Please retry later." }]) {
        const messages: string[] = [];
        const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) }, Toasts: { Type: {} } },
            "./auth": { getToken: async () => "token" }, "./entities": {}, "./settings": {},
            "./utils": { showToast: (message: string) => messages.push(message) },
        }, { fetch: async () => ({ ok: false, status: 503, json: async () => payload }) });
        assert.equal(await api.getCurrentUserInfo(), null);
        assert.deepEqual(messages, [payload?.message === "Please retry later." ? "Please retry later." : "ReviewDB: Request failed with status 503"]);
    }
});

test("ReviewDB submissions cannot send or clear under a changed account", async () => {
    const source = readFileSync("src/plugins/reviewDB/components/ReviewsView.tsx", "utf8");
    const match = source.match(/async res => \{([\s\S]*?)\n\s*\}\n\s*\}\n\s*\/>/);
    assert.ok(match);
    for (const switchAt of ["before", "response", "editor", "unmount", "never"]) {
        let userId = switchAt === "before" ? "second" : "first";
        let sends = 0;
        let clears = 0;
        let reloads = 0;
        const editorRef: { current: { ref: { current: { getSlateEditor(): object; } | null; }; }; } = { current: { ref: { current: { getSlateEditor: () => ({}) } } } };
        const submit = runInNewContext(`(async res => {${match[1]}})`, {
            accountId: "first", UserStore: { getCurrentUser: () => ({ id: userId }) },
            discordId: "target", repliesTo: undefined,
            addReview: async () => {
                sends++;
                if (switchAt === "response") userId = "second";
                if (switchAt === "editor") editorRef.current.ref.current = { getSlateEditor: () => ({}) };
                if (switchAt === "unmount") editorRef.current.ref.current = null;
                return {};
            },
            refetch: () => { reloads++; }, editorRef,
            Transforms: { delete: () => { clears++; } }, Editor: { start() {}, end() {} },
        });
        const result = await submit({ value: "review" });
        assert.equal(sends, switchAt === "before" ? 0 : 1);
        assert.equal(clears, switchAt === "never" ? 1 : 0);
        assert.equal(reloads, switchAt === "never" ? 1 : 0);
        assert.equal(result.shouldRefocus, switchAt === "never");
    }
});

test("ReviewDB modal state is keyed to the current account", async () => {
    let userId = "first";
    let factory: (() => Promise<(props: object) => { props: { key: string; discordId: string; }; }>) | undefined;
    const store = { getCurrentUser: () => ({ id: userId }) };
    const api = loadSource("src/plugins/reviewDB/components/ReviewModal.tsx", {
        "@components/BaseText": {}, "@plugins/reviewDB/auth": {}, "@plugins/reviewDB/reviewDbApi": {},
        "@plugins/reviewDB/utils": {}, "@utils/react": {},
        "@webpack": { DefaultExtractAndLoadChunksRegex: /chunk/, extractAndLoadChunksLazy: () => async () => {}, findComponentByCodeLazy: () => ({}) },
        "@webpack/common": { UserStore: store, openModalLazy: (value: typeof factory) => { factory = value; },
            useStateFromStores: (stores: unknown[], select: () => unknown) => { assert.equal(stores[0], store); return select(); } },
        "./ReviewComponent": {}, "./ReviewsView": {},
    }, { React: { createElement: (_type: unknown, props: object) => ({ props }) } });
    api.openReviewsModal("target", "Target", 0);
    assert.ok(factory);
    const render = await factory();
    const first = render({});
    userId = "second";
    const second = render({});
    assert.equal(first.props.key, "first");
    assert.equal(second.props.key, "second");
    assert.equal(second.props.discordId, "target");
});

test("ReviewDB reload dependencies include the profile and current account", () => {
    let userId = "first";
    let retained: { discordId: string; currentUserId: string; data: { reviews: unknown[]; }; } | null = null;
    const dependencies: unknown[][] = [];
    const store = { getCurrentUser: () => ({ id: userId }) };
    const { default: ReviewsView } = loadSource("src/plugins/reviewDB/components/ReviewsView.tsx", {
        "@components/Paragraph": {}, "@plugins/reviewDB/auth": {}, "@plugins/reviewDB/entities": {},
        "@plugins/reviewDB/reviewDbApi": {}, "@plugins/reviewDB/settings": {}, "@plugins/reviewDB/utils": {},
        "@utils/react": {
            useForceUpdater: () => [0, () => {}],
            useAwaiter: (_factory: unknown, options: { deps: unknown[]; }) => { dependencies.push(Array.from(options.deps)); return [retained]; },
        },
        "@webpack": { findByPropsLazy: () => ({}), findComponentByCodeLazy: () => ({}), findByCodeLazy: () => ({}) },
        "@webpack/common": { React: { createElement: () => ({}) }, UserStore: store, useStateFromStores: (stores: unknown[], select: () => unknown) => {
            assert.equal(stores[0], store); return select();
        } }, "./ReviewComponent": {},
    });
    ReviewsView({ discordId: "profile-one", onFetchReviews() {} });
    ReviewsView({ discordId: "profile-two", onFetchReviews() {} });
    userId = "second";
    ReviewsView({ discordId: "profile-two", onFetchReviews() {} });
    assert.notDeepEqual(dependencies[0], dependencies[1]);
    assert.notDeepEqual(dependencies[1], dependencies[2]);
    assert.ok(dependencies[2].includes("profile-two") && dependencies[2].includes("second"));
    retained = { discordId: "profile-one", currentUserId: "second", data: { reviews: [] } };
    assert.equal(ReviewsView({ discordId: "profile-two", onFetchReviews() {} }), null);
    retained.discordId = "profile-two";
    retained.currentUserId = "first";
    assert.equal(ReviewsView({ discordId: "profile-two", onFetchReviews() {} }), null);
    retained.currentUserId = "second";
    assert.notEqual(ReviewsView({ discordId: "profile-two", onFetchReviews() {} }), null);
});

test("ReviewDB vote callbacks ignore stale accounts and results", async () => {
    const source = readFileSync("src/plugins/reviewDB/components/ReviewComponent.tsx", "utf8");
    const start = source.indexOf("    async function submitVote(");
    const end = source.indexOf("\n    return (", start);
    assert.ok(start >= 0 && end > start);
    const code = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    for (const localVote of [null, true]) {
        for (const switchAt of ["before", "response", "never"]) {
            let userId = switchAt === "before" ? "second" : "first";
            let requests = 0;
            let changes = 0;
            const send = async () => { requests++; if (switchAt === "response") userId = "second"; return true; };
            const submit = runInNewContext(`${code}; submitVote`, {
                accountId: "first", UserStore: { getCurrentUser: () => ({ id: userId }) },
                isVoting: false, localVote, Auth: {}, review: { id: 1, sender: { discordID: "target" } },
                voteReview: send, deleteReviewVote: send, setIsVoting() {},
                setLocalVote: () => { changes++; }, setScore: () => { changes++; },
            });
            await submit(true);
            assert.equal(requests, switchAt === "before" ? 0 : 1);
            assert.equal(changes, switchAt === "never" ? 2 : 0);
        }
    }
});

test("ReviewDB confirmations reject account changes before and during token lookup", async () => {
    const source = readFileSync("src/plugins/reviewDB/components/ReviewComponent.tsx", "utf8");
    const callbacks = Array.from(source.matchAll(/onConfirm=\{async \(\) => \{([\s\S]*?)\n\s*\}\}/g));
    assert.equal(callbacks.length, 3);
    for (const [, body] of callbacks) {
        for (const switchAt of ["before", "token", "never"]) {
            let userId = switchAt === "before" ? "second" : "first";
            let requests = 0;
            let lookups = 0;
            const confirm = runInNewContext(`(async () => {${body}})`, {
                accountId: "first", UserStore: { getCurrentUser: () => ({ id: userId }) },
                getToken: async () => { lookups++; if (switchAt === "token") userId = "second"; return "token"; },
                review: { id: 1, sender: { discordID: "target" } }, refetch() {},
                showToast: () => assert.fail("unexpected login toast"),
                deleteReview: async () => { requests++; return {}; },
                reportReview: async () => { requests++; }, blockUser: async () => { requests++; },
            });
            await confirm();
            assert.equal(lookups, switchAt === "before" ? 0 : 1);
            assert.equal(requests, switchAt === "never" ? 1 : 0);
        }
    }
});

test("ReviewDB input leaves Discord's shared input configuration unchanged", () => {
    const inputType = Object.freeze({ id: "reply", disableAutoFocus: false, draftType: 7 });
    const React = { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ props, children }) };
    const { ReviewsInputComponent } = loadSource("src/plugins/reviewDB/components/ReviewsView.tsx", {
        "@components/Paragraph": {}, "@plugins/reviewDB/auth": { Auth: { token: "token" } },
        "@plugins/reviewDB/entities": {}, "@plugins/reviewDB/reviewDbApi": {}, "@plugins/reviewDB/settings": {},
        "@plugins/reviewDB/utils": { cl: (value: string) => value }, "@utils/react": {},
        "@webpack": {
            findByPropsLazy: (prop: string) => prop === "FORM" ? { USER_PROFILE_REPLY: inputType } : {},
            findComponentByCodeLazy: () => "Input", findByCodeLazy: () => () => ({}),
        },
        "@webpack/common": { React, UserStore: { getCurrentUser: () => ({ id: "first" }) }, useRef: () => ({ current: null }) }, "./ReviewComponent": {},
    });
    const tree = ReviewsInputComponent({ discordId: "target", name: "Target", refetch() {} });
    const type = tree.children[0].children[0].props.type;
    assert.notEqual(type, inputType);
    assert.equal(type.disableAutoFocus, true);
    assert.equal(type.id, "reply");
    assert.equal(type.draftType, 7);
    assert.equal(inputType.disableAutoFocus, false);
});

test("ReviewDB block persistence cannot report success to another account", async () => {
    let userId = "first";
    let toasts = 0;
    const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, Toasts: { Type: {} } },
        "./auth": { getToken: async () => "token", updateAuth: async () => { userId = "second"; } },
        "./entities": {}, "./settings": {}, "./utils": { showToast: () => { toasts++; } },
    }, { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.equal(await api.blockUser("target"), false);
    assert.equal(toasts, 0);
});

test("ReviewDB concurrent blocks preserve both stored changes", async () => {
    const accounts = { first: { token: "token", user: { blockedUsers: [] as string[] } } };
    const writes: (() => void)[] = [];
    const common = { UserStore: { getCurrentUser: () => ({ id: "first" }) }, Toasts: { Type: {} } };
    const auth = loadSource("src/plugins/reviewDB/auth.tsx", {
        "@webpack/common": common, "@utils/Logger": {},
        "@api/DataStore": {
            get: async () => accounts,
            update: (_key: string, update: (value: typeof accounts) => unknown) => new Promise(resolve => writes.push(() => resolve(update(accounts)))),
        },
    });
    await auth.initAuth();
    const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
        "@webpack/common": common, "./auth": auth, "./entities": {}, "./settings": {}, "./utils": { showToast() {} },
    }, { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    const first = api.blockUser("one");
    const second = api.blockUser("two");
    await setImmediate();
    assert.equal(writes.length, 2);
    for (const write of writes) write();
    await Promise.all([first, second]);
    assert.deepEqual(Array.from(accounts.first.user.blockedUsers), ["one", "two"]);
});

test("ReviewDB distinguishes failed block loads from empty lists", async () => {
    for (const success of [false, true]) {
        const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) }, Toasts: { Type: {} } },
            "./auth": { getToken: async () => "token" }, "./entities": {}, "./settings": {}, "./utils": { showToast() {} },
        }, { fetch: async () => ({ ok: success, status: 500, json: async () => [] }) });
        const blocks = await api.fetchBlocks();
        if (success) assert.deepEqual(Array.from(blocks), []);
        else assert.equal(blocks, null);
        const { BlockedUsersList } = loadSource("src/plugins/reviewDB/components/BlockedUserModal.tsx", {
            "@components/Paragraph": {}, "@plugins/reviewDB/auth": {}, "@plugins/reviewDB/reviewDbApi": {},
            "@plugins/reviewDB/utils": {}, "@utils/Logger": {}, "@utils/react": { useAwaiter: () => [blocks, undefined, false] },
            "@webpack/common": { useState: () => [false, () => {}] },
        }, { React: { createElement: (_type: unknown, _props: object, ...children: unknown[]) => ({ children }) } }, "({ BlockedUsersList })");
        assert.equal(BlockedUsersList().children[0], success ? "No blocked users." : "Failed to fetch blocked users.");
    }
});

test("ReviewDB only removes blocked rows after successful unblocking", async () => {
    for (const success of [false, true]) {
        const gone: boolean[] = [];
        const busy: boolean[] = [];
        const { BlockedUser } = loadSource("src/plugins/reviewDB/components/BlockedUserModal.tsx", {
            "@components/Paragraph": {}, "@plugins/reviewDB/auth": {},
            "@plugins/reviewDB/reviewDbApi": { unblockUser: async () => success },
            "@plugins/reviewDB/utils": { cl: (value: string) => value },
            "@utils/Logger": {}, "@utils/react": {},
            "@webpack/common": { useState: () => [false, (value: boolean) => gone.push(value)] },
        }, { React: { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ props, children }) } }, "({ BlockedUser })");
        const row = BlockedUser({ user: { discordID: "target" }, isBusy: false, setIsBusy: (value: boolean) => busy.push(value) });
        await row.children[2].props.onClick();
        assert.deepEqual(gone, success ? [true] : []);
        assert.deepEqual(busy, [true, false]);
    }
});

test("ReviewDB block operations return failure and await successful persistence", async () => {
    for (const success of [false, true]) {
        const events: string[] = [];
        const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "first" }) }, Toasts: { Type: {} } },
            "./auth": { getToken: async () => "token", Auth: { user: { blockedUsers: ["target"] } }, updateAuth: async () => { await setImmediate(); events.push("stored"); } },
            "./entities": {}, "./settings": {}, "./utils": { showToast: () => events.push("toast") },
        }, { fetch: async () => ({ ok: success, status: 500, json: async () => ({}) }) });
        assert.equal(await api.unblockUser("target"), success);
        assert.deepEqual(events, success ? ["stored", "toast"] : ["toast"]);
    }
});

test("ReviewDB startup work stops with the plugin or account", async () => {
    for (const stopAt of ["init", "timer", "request", "account-init", "account-timer", "account-request", "never"]) {
        let userId = "first";
        let appeal: (() => Promise<void>) | undefined;
        const opened: string[] = [];
        const auth = { token: "original-token" };
        let resolveInit: () => void = () => {};
        let resolveRequest: (user: object) => void = () => {};
        let timer: (() => Promise<void>) | undefined;
        let requests = 0;
        let writes = 0;
        const { default: plugin } = loadSource("src/plugins/reviewDB/index.tsx", {
            "@components/Icons": {}, "@components/Paragraph": {}, "@components/Span": {},
            "@utils/constants": { Devs: {} }, "@utils/misc": {}, "@utils/react": {},
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) }, Parser: { parse: () => "notification" },
                openModal: (render: (props: object) => { props: { onCancel: typeof appeal; }; }) => { appeal = render({}).props.onCancel; },
            },
            "./auth": { Auth: auth, initAuth: () => new Promise<void>(resolve => { resolveInit = resolve; }), updateAuth: () => { writes++; } },
            "./components/ReviewModal": {}, "./entities": { NotificationType: { Ban: 1 } },
            "./reviewDbApi": { readNotification() {}, getCurrentUserInfo: () => { requests++; return new Promise(resolve => { resolveRequest = resolve; }); } },
            "./settings": { settings: { store: {} } }, "./utils": {},
        }, {
            URLSearchParams, React: { createElement: (_type: unknown, props: object) => ({ props }) },
            VencordNative: { native: { openExternal: async (url: string) => { opened.push(url); } } },
            setTimeout: (callback: typeof timer) => { timer = callback; return 1; },
            clearTimeout: () => { timer = undefined; },
        });
        const start = plugin.start();
        if (stopAt === "init") plugin.stop();
        if (stopAt === "account-init") userId = "second";
        resolveInit();
        await start;
        if (stopAt === "timer") plugin.stop();
        if (stopAt === "init" || stopAt === "timer" || stopAt === "account-init") {
            assert.equal(timer, undefined);
            assert.equal(requests, 0);
            continue;
        }
        assert.ok(timer);
        if (stopAt === "account-timer") userId = "second";
        const pending = timer();
        if (stopAt === "request") plugin.stop();
        if (stopAt === "account-request") userId = "second";
        resolveRequest({ lastReviewID: 0, notification: { id: 1, type: 1, content: "notification" } });
        await pending;
        assert.equal(writes, stopAt === "never" ? 1 : 0);
        if (stopAt === "never") {
            assert.ok(appeal);
            auth.token = "changed-token";
            await appeal();
            assert.equal(new URL(opened[0]).searchParams.get("token"), "original-token");
            userId = "second";
            await appeal();
            assert.equal(opened.length, 1);
            userId = "first";
            plugin.stop();
            await appeal();
            assert.equal(opened.length, 1);
        }
    }
});

test("ReviewDB token preflights cannot authorize or send under a changed account", async () => {
    for (const operation of ["getReviewVotes", "addReview", "voteReview", "deleteReviewVote"]) {
        for (const token of [undefined, "first-token"]) {
            let userId = "first";
            let requests = 0;
            let prompts = 0;
            const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, Toasts: { Type: {} } },
                "./auth": {
                    getToken: async () => { userId = "second"; return token; },
                    authorize: () => { prompts++; },
                },
                "./entities": {}, "./settings": {}, "./utils": { showToast: () => { prompts++; } },
            }, { fetch: async () => { requests++; return { ok: true, json: async () => ({}) }; } });
            await api[operation](operation === "addReview" ? { userid: "target" } : "target", true);
            assert.equal(requests, 0, operation);
            assert.equal(prompts, 0, operation);
        }
    }
});

test("ReviewDB discards requests and responses after account changes", async () => {
    for (const switchAt of ["token", "response", "error", "never"]) {
        let userId = "first";
        let requests = 0;
        let toasts = 0;
        const api = loadSource("src/plugins/reviewDB/reviewDbApi.ts", {
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, Toasts: { Type: {} } },
            "./auth": { getToken: async () => {
                if (switchAt === "token") userId = "second";
                return "first-token";
            } },
            "./entities": {}, "./settings": {}, "./utils": { showToast: () => { toasts++; } },
        }, {
            fetch: async (_url: string, options: RequestInit) => {
                requests++;
                assert.equal(new Headers(options.headers).get("Authorization"), "first-token");
                if (switchAt === "error") {
                    userId = "second";
                    throw new Error("Network failed");
                }
                return { ok: true, json: async () => {
                    if (switchAt === "response") userId = "second";
                    return { discordID: "first" };
                } };
            },
        });
        const result = await api.getCurrentUserInfo();
        assert.equal(requests, switchAt === "token" ? 0 : 1);
        assert.equal(toasts, 0);
        if (switchAt === "never") assert.equal(result.discordID, "first");
        else assert.equal(result, null);
    }
});

test("ReviewDB validates the OAuth destination and token before persistence", async () => {
    let authorizeResponse: (response: { location: string; }) => Promise<void> = async () => assert.fail("missing OAuth callback");
    let responseData: unknown = { token: "valid-token" };
    const requests: { url: URL; options: RequestInit; }[] = [];
    let writes = 0;
    let successes = 0;
    const api = loadSource("src/plugins/reviewDB/auth.tsx", {
        "@api/DataStore": { update: async () => { writes++; } },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "first" }) }, OAuth2AuthorizeModal: "OAuth",
            openModal: (render: (props: object) => { props: { callback: typeof authorizeResponse; }; }) => { authorizeResponse = render({}).props.callback; },
            showToast: () => { successes++; }, Toasts: { Type: {} },
        },
    }, {
        URL, React: { createElement: (_type: unknown, props: object) => ({ props }) },
        fetch: async (url: URL, options: RequestInit) => {
            requests.push({ url, options });
            return { ok: true, json: async () => responseData };
        },
    });
    api.authorize();
    for (const location of ["https://example.com/api/reviewdb/auth", "http://manti.vendicated.dev/api/reviewdb/auth", "https://manti.vendicated.dev/api/reviewdb/auth/other", "https://user:password@manti.vendicated.dev/api/reviewdb/auth", "javascript:alert(1)"]) {
        await authorizeResponse({ location });
    }
    assert.equal(requests.length, 0);
    const location = "https://manti.vendicated.dev/api/reviewdb/auth?code=test&clientMod=other";
    for (const invalid of [null, {}, { token: 1 }, { token: "" }, { token: "   " }, "token"]) {
        responseData = invalid;
        await authorizeResponse({ location });
    }
    assert.equal(writes, 0);
    assert.equal(successes, 0);
    responseData = { token: "valid-token" };
    await authorizeResponse({ location });
    assert.equal(writes, 1);
    assert.equal(successes, 1);
    assert.equal(requests[0].options.redirect, "error");
    assert.deepEqual(requests[0].url.searchParams.getAll("clientMod"), ["vencord"]);
});

test("ReviewDB authorization stays with its initiating account and awaits storage", async () => {
    for (const switchAt of ["before", "fetch", "json", "storage", "never"]) {
        let userId = "first";
        let onAuthorize: (response: { location: string; }) => Promise<void> = async () => assert.fail("missing OAuth callback");
        const accounts: Record<string, { token?: string; }> = {};
        const events: string[] = [];
        const api = loadSource("src/plugins/reviewDB/auth.tsx", {
            "@api/DataStore": { update: async (_key: string, update: (value: typeof accounts) => unknown) => {
                if (switchAt === "storage") userId = "second";
                await setImmediate();
                update(accounts);
                events.push("stored");
            } },
            "@utils/Logger": { Logger: class { error(error: unknown) { throw error; } } },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) },
                OAuth2AuthorizeModal: "OAuth",
                openModal: (render: (props: object) => { props: { callback: typeof onAuthorize; }; }) => { onAuthorize = render({}).props.callback; },
                showToast: () => events.push("toast"), Toasts: { Type: {} },
            },
        }, {
            React: { createElement: (_type: unknown, props: object) => ({ props }) }, URL,
            fetch: async () => {
                events.push("fetch");
                if (switchAt === "fetch") userId = "second";
                return { ok: true, json: async () => {
                    if (switchAt === "json") userId = "second";
                    return { token: "first-token" };
                } };
            },
        });
        api.authorize(() => events.push("callback"));
        if (switchAt === "before") userId = "second";
        await onAuthorize({ location: "https://manti.vendicated.dev/api/reviewdb/auth?code=test" });
        assert.equal(accounts.second, undefined);
        if (switchAt === "never") {
            assert.equal(accounts.first.token, "first-token");
            assert.deepEqual(events, ["fetch", "stored", "toast", "callback"]);
        } else {
            assert.equal(events.includes("toast"), false);
            assert.equal(events.includes("callback"), false);
            assert.equal(accounts.first?.token, switchAt === "storage" ? "first-token" : undefined);
        }
    }
});

test("ReviewDB storage operations retain their initiating account", async () => {
    let userId: string | undefined = "first";
    const accounts: Record<string, { token?: string; }> = { first: { token: "first-token" }, second: { token: "second-token" } };
    const reads: (() => void)[] = [];
    const writes: (() => void)[] = [];
    const api = loadSource("src/plugins/reviewDB/auth.tsx", {
        "@api/DataStore": {
            get: () => new Promise(resolve => reads.push(() => resolve(accounts))),
            update: (_key: string, update: (value: typeof accounts) => unknown) => new Promise(resolve => writes.push(() => resolve(update(accounts)))),
        },
        "@utils/Logger": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined } },
    });
    const read = api.getAuth();
    const write = api.updateAuth({ token: "updated-first" });
    userId = "second";
    reads.shift()?.();
    assert.equal((await read).token, "first-token");
    writes.shift()?.();
    await write;
    assert.equal(accounts.first.token, "updated-first");
    assert.equal(accounts.second.token, "second-token");
    assert.equal(api.Auth.token, undefined);
    const secondInit = api.initAuth();
    userId = "first";
    const firstInit = api.initAuth();
    reads.pop()?.();
    await firstInit;
    reads.shift()?.();
    await secondInit;
    assert.equal(api.Auth.token, "updated-first");
    userId = undefined;
    await api.initAuth();
    await api.updateAuth({ token: "logged-out" });
    assert.equal(api.Auth.token, undefined);
    assert.equal(writes.length, 0);
});

test("FakeNitro checks emoji and sticker access in the destination guild", async () => {
    let preSend: (channel: string, message: { content: string; }, options: { stickerIds: string[]; }) => Promise<unknown> = async () => {};
    const { default: plugin } = loadSource("src/plugins/fakeNitro/index.tsx", {
        "@api/MessageEvents": { addMessagePreSendListener: (fn: typeof preSend) => { preSend = fn; }, addMessagePreEditListener() {} },
        "@api/Settings": { definePluginSettings: () => ({ store: { enableStickerBypass: true, enableEmojiBypass: false } }) },
        "@components/Paragraph": {}, "@utils/apng": {}, "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentGuild: () => ({ id: "selected" }) }, "@utils/Logger": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@vencord/discord-types/enums": { StickerFormatType: {} }, "gifenc": {},
        "@webpack": { findByPropsLazy: () => ({}), proxyLazyWebpack: () => ({}), findByCodeLazy: () => () => false },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ guild_id: "destination" }) },
            OverridePremiumTypeStore: { getState: () => ({ premiumTypeActual: 0 }) },
            StickersStore: { getStickerById: () => ({ id: "sticker", guild_id: "destination", available: true }) },
        },
    });
    assert.equal(plugin.canUseEmote({ guildId: "destination", animated: false }, "channel"), true);
    assert.equal(plugin.canUseEmote({ guildId: "selected", animated: false }, "channel"), false);
    plugin.start();
    const message = { content: "original" };
    const options = { stickerIds: ["sticker"] };
    await preSend("channel", message, options);
    assert.equal(message.content, "original");
    assert.deepEqual(options.stickerIds, ["sticker"]);
});

test("name formatting preserves Discord user objects", () => {
    const { getProcessedNames } = loadSource("src/plugins/showMeYourName/index.tsx", {
        "@api/ContextMenu": {}, "@api/index": {}, "@api/PluginManager": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) }, "@components/Button": {},
        "@components/ErrorBoundary": {}, "@components/Heading": {}, "@plugins/ircColors": {}, "@plugins/mentionAvatars": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/index": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findStoreLazy: () => ({}), findByCodeLazy: () => () => {} },
        "@webpack/common": { StreamerModeStore: { enabled: false }, RelationshipStore: { getNickname: () => null } },
    }, {}, "({ getProcessedNames })");
    const author = Object.freeze({ id: "bot", bot: true, username: "Bot", globalName: "Display", discriminator: "1234" });
    const names = getProcessedNames(author, false, true, false, false, false);
    assert.equal(names.username, "Bot#1234");
    assert.equal(names.display, "Bot");
    assert.equal(author.globalName, "Display");
    assert.equal(getProcessedNames(author, false, false, false, false, false).display, "Display");
});

test("bulk webpack searches resolve multiple filters from the same module", () => {
    const { findBulk, _initWebpack } = loadSource("src/webpack/webpack.ts", {
        "@debug/Tracer": { traceFunction: (_name: string, fn: unknown) => fn }, "@utils/lazy": {},
        "@utils/lazyReact": {}, "@utils/Logger": { Logger: class { warn() {} } },
        "@utils/patches": {}, "@utils/text": {},
    }, { IS_DEV: false, IS_ANTI_CRASH_TEST: false });
    for (const moduleExports of [{ a: 1, b: 2 }, { first: { a: 1 }, second: { b: 2 } }, { a: 1, second: { b: 2 } }]) {
        _initWebpack({ c: { fixture: { loaded: true, exports: moduleExports } } });
        const result = findBulk((value: { a?: number; }) => value.a === 1, (value: { b?: number; }) => value.b === 2);
        assert.equal(result.length, 2);
        assert.equal(result[0]?.a, 1);
        assert.equal(result[1]?.b, 2);
    }
});

test("webpack replacement failures preserve successful factories and diagnostics", () => {
    for (const group of [false, true]) {
        for (const failure of ["syntax", "no effect"]) {
            const { patchFactory, patches, SYM_PATCHED_SOURCE, SYM_PATCHED_BY } = loadSource("src/webpack/patchWebpack.ts", {
                "@api/Settings": {}, "@debug/reporterData": {},
                "@debug/Tracer": { traceFunctionWithResults: (_name: string, fn: (match: RegExp, replace: string) => string) => (match: RegExp, replace: string) => [fn(match, replace), 0] },
                "@utils/lazy": { makeLazy: () => () => 1 },
                "@utils/Logger": { Logger: class { warn() {} error() {} debug() {} errorCustomFmt() {} static makeTitle() { return [""]; } } },
                "@utils/misc": {}, "./webpack": {}, "diff": { diffWordsWithSpace: () => [] },
            }, { IS_DEV: true, IS_REPORTER: false, IS_COMPANION_TEST: false }, "({ ...exports, patchFactory })");
            patches.push({ plugin: "First", find: "return", replacement: [{ match: /base/, replace: "first" }] });
            patches.push({ plugin: "Second", find: "return", group, replacement: [
                { match: /first/, replace: "second" },
                failure === "syntax" ? { match: /second/, replace: '"(' } : { match: /missing/, replace: "unused" },
            ] });
            const original = function () { return "base"; };
            const result = patchFactory("fixture", original);
            const expected = group ? "first" : "second";
            assert.equal(result(), expected, `factory after ${failure} with group=${group}`);
            assert.deepEqual(Array.from(original[SYM_PATCHED_BY]), group ? ["First"] : ["First", "Second"]);
            assert.equal(runInNewContext(original[SYM_PATCHED_SOURCE])(), expected, "diagnostic source matches the running factory");
        }
    }
});

test("support messages cannot offer executable snippets", () => {
    let trusted = false;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
    const { default: plugin } = loadSource("src/plugins/_core/supportHelper.tsx", {
        "@api/Commands": {}, "@api/PluginManager": {},
        "@api/Settings": { definePluginSettings: () => ({ withPrivateSettings: () => ({ store: {} }) }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/Button": { Button: "button" }, "@components/Card": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Flex": { Flex: "flex" }, "@components/Paragraph": {}, "@components/settings": {},
        "@equicordplugins/equicordHelper/utils": {}, "@plugins/customIdle": {}, "@shared/vencordUserAgent": {},
        "@utils/constants": { Devs: {} }, "@utils/discord": {}, "@utils/Logger": {}, "@utils/margins": {},
        "@utils/misc": { isEquicordSupport: () => trusted, isSupportChannel: () => true, isKnownIssuesCategory: () => true },
        "@utils/native": {}, "@utils/onlyOnce": { onlyOnce: () => () => {} }, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: object) => value }, "@utils/updater": {},
        "@vencord/discord-types/enums": {},
        "@webpack/common": { React, PermissionsBits: {}, PermissionStore: { can: () => true } },
        "~plugins": {}, "./settings": {},
    }, { React, IS_UPDATER_DISABLED: true });
    const props = { channel: { id: "support", parent_id: "issues" }, message: { author: { id: "author" }, content: "```snippet\nthrow new Error('must not execute')```", embeds: [] } };
    assert.equal(plugin.renderMessageAccessory(props), null);
    trusted = true;
    assert.equal(plugin.renderMessageAccessory(props), null);
    props.message.content = "/equicord-debug";
    const diagnostics = plugin.renderMessageAccessory(props);
    const buttons = diagnostics.children[0];
    assert.deepEqual(Array.from(buttons, (button: { children: string[]; }) => button.children[0]), ["Run /equicord-debug", "Run /equicord-plugins"]);
});

test("XSOverlay applies each channel notification setting independently", () => {
    const store = { dmNotifications: false, groupDmNotifications: false, serverNotifications: false };
    const { shouldIgnoreForChannelType } = loadSource("src/plugins/xsOverlay/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, makeRange: () => [], OptionType: {}, ReporterTestable: {} },
        "@webpack": { findByCodeLazy: () => () => true, findLazy: () => ({ DM: 1, GROUP_DM: 3 }) }, "@webpack/common": {},
    }, { VencordNative: { pluginHelpers: { XSOverlay: {} } } }, "({ shouldIgnoreForChannelType })");
    for (let mask = 0; mask < 8; mask++) {
        store.dmNotifications = !!(mask & 1);
        store.groupDmNotifications = !!(mask & 2);
        store.serverNotifications = !!(mask & 4);
        assert.equal(shouldIgnoreForChannelType({ type: 1 }), !store.dmNotifications);
        assert.equal(shouldIgnoreForChannelType({ type: 3 }), !store.groupDmNotifications);
        assert.equal(shouldIgnoreForChannelType({ type: 0 }), !store.serverNotifications);
    }
});

test("NoBlockedMessages preserves notifications for unsuppressed AutoMod messages", () => {
    let suppressed = false;
    const { default: plugin } = loadSource("src/plugins/noBlockedMessages/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { allowAutoModMessages: true, disableNotifications: true } }), migratePluginSetting() {} },
        "@equicordplugins/blockKeywords": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/Logger": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findStoreLazy: () => ({}) }, "@webpack/common": {},
    });
    plugin.isSuppressed = () => ({ suppressed, hide: true });
    plugin.isReplyToSuppressed = () => ({ suppressed: false, hide: false });
    assert.equal(plugin.disableNotification({ type: 24 }), false);
    suppressed = true;
    assert.equal(plugin.disableNotification({ type: 24 }), true);
    assert.equal(plugin.shouldKeepMessage({ type: 24 })[0], true);
});

test("message history diffs keep custom emoji markup atomic", () => {
    const { createWordDiff } = loadSource("src/plugins/messageLogger/diffUtils.ts", {});
    for (const prefix of ["", "a"]) {
        const before = `<${prefix}:old:123>`;
        const after = `<${prefix}:new:456>`;
        const parts = Array.from(createWordDiff(before, after)) as Array<{ type: string; text: string; }>;
        assert.equal(parts.length, 2);
        assert.equal(parts.find(part => part.type === "removed")?.text, before);
        assert.equal(parts.find(part => part.type === "added")?.text, after);
    }
});

test("Unindent preserves code fence placement while removing indentation", () => {
    const { default: plugin } = loadSource("src/plugins/unindent/index.ts", {
        "@utils/constants": { Devs: {} }, "@utils/types": { __esModule: true, default: (value: object) => value },
    });
    for (const [input, expected] of [
        ["```js\n    code```", "```js\ncode```"],
        ["```js\n    code\n```", "```js\ncode\n```"],
        ["```inline```", "```inline```"],
        ["before ```js\n    first\n      second\n``` after", "before ```js\nfirst\n  second\n``` after"],
    ]) {
        const message = { content: input };
        plugin.unindentMsg(message);
        assert.equal(message.content, expected);
    }
});

test("voice metadata closes its audio context after success and decoding failures", async () => {
    let decode: () => Promise<unknown> = async () => ({ getChannelData: () => new Float32Array([0]), sampleRate: 48000, duration: 1 });
    let closes = 0;
    let readMetadata: () => Promise<unknown> = async () => undefined;
    let stateIndex = 0;
    const blob = new Blob(["audio"], { type: "audio/ogg" });
    const { VoiceMessageModal } = loadSource("src/plugins/voiceMessages/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/Card": {}, "@components/Icons": {}, "@components/Link": {}, "@components/Paragraph": {},
        "@plugins/silentMessageToggle": {}, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/margins": {},
        "@utils/react": { useAwaiter: (callback: typeof readMetadata) => { readMetadata = callback; return [{ waveform: "" }, undefined]; } },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} }, "@utils/web": {},
        "@vencord/discord-types/enums": {},
        "@webpack/common": { useState: () => [stateIndex++ === 1 ? blob : undefined, () => {}], useEffect() {}, Forms: {} },
        "./components/DesktopRecorder": {}, "./components/WebRecorder": {}, "./components/VoicePreview": {},
        "./waveform": { DEFAULT_WAVEFORM: "", generateWaveform: () => "waveform" },
    }, { IS_DISCORD_DESKTOP: false, React: { createElement: () => ({}) }, AudioContext: class {
        decodeAudioData() { return decode(); }
        async close() { closes++; }
    } }, "({ VoiceMessageModal })");
    VoiceMessageModal({ modalProps: {} });
    await readMetadata();
    assert.equal(closes, 1);
    decode = async () => { throw new Error("invalid audio"); };
    await assert.rejects(readMetadata(), /invalid audio/);
    assert.equal(closes, 2);
});

test("MusicRichPresence discards stopped, superseded and foreign account updates", async () => {
    const activities: unknown[] = [];
    const requests: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
    let userId = "first";
    const { default: plugin } = loadSource("src/plugins/musicRichPresence/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), migratePluginSetting() {}, migratePluginSettings() {} },
        "@components/Button": {}, "@components/Card": {}, "@components/Heading": {}, "@components/margins": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@vencord/discord-types/enums": {},
        "@webpack/common": { AuthenticationStore: { getId: () => userId }, FluxDispatcher: { dispatch: (event: { activity: unknown; }) => activities.push(event.activity) } },
        "./lastfm": {}, "./listenbrainz": { clearListenBrainzCache() {} },
    }, { setInterval: () => 1, clearInterval() {} });
    plugin.getActivity = () => {
        const request = Promise.withResolvers<unknown>();
        requests.push(request);
        return request.promise;
    };
    plugin.start();
    plugin.stop();
    assert.deepEqual(activities, [null], "stop clears the published activity");
    requests[0].resolve({ name: "stopped" });
    await setImmediate();
    assert.deepEqual(activities, [null]);
    plugin.start();
    const newest = plugin.updatePresence();
    requests[2].resolve({ name: "newest" });
    await newest;
    requests[1].resolve({ name: "older" });
    await setImmediate();
    assert.deepEqual(activities, [null, { name: "newest" }]);
    const foreign = plugin.updatePresence();
    userId = "second";
    requests[3].resolve({ name: "foreign" });
    await foreign;
    assert.deepEqual(activities, [null, { name: "newest" }]);
    const failed = plugin.updatePresence();
    requests[4].reject(new Error("asset unavailable"));
    await failed;
    plugin.stop();
});

test("ImageZoom clears its mounted root when stopped", () => {
    const { default: plugin } = loadSource("src/plugins/imageZoom/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) }, "@shared/debounce": {},
        "@utils/constants": { Devs: {} }, "@utils/Logger": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} }, "@webpack/common": {},
        "./components/Magnifier": {}, "./constants": {}, "./styles.css?managed": {},
    });
    let unmounted = 0;
    let removed = 0;
    plugin.root = { unmount: () => unmounted++ };
    plugin.element = { remove: () => removed++ };
    plugin.currentMagnifierElement = {};
    plugin.stop();
    assert.equal(unmounted, 1);
    assert.equal(removed, 1);
    assert.equal(plugin.root, null);
    assert.equal(plugin.currentMagnifierElement, null);
    assert.equal(plugin.element, null);
    plugin.stop();
    assert.equal(unmounted, 1);
    assert.equal(removed, 1);
});

test("Decor authorization rejects tokens received after switching accounts", async () => {
    let userId = "first";
    let callback: (response: object) => Promise<void> = async () => {};
    const token = Promise.withResolvers<string>();
    const { useAuthorizationStore } = loadSource("src/plugins/decor/lib/stores/AuthorizationStore.tsx", {
        "@api/DataStore": {}, "@plugins/decor/lib/constants": { AUTHORIZE_URL: "https://example.com/authorize", CLIENT_ID: "client" },
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() }, "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; return {}; } },
            UserStore: { getCurrentUser: () => ({ id: userId }) }, showToast() {}, Toasts: { Type: {} },
            openModal: (render: (props: object) => unknown) => render({}), zustandPersist: (fn: unknown) => fn,
            zustandCreate: (fn: (set: (value: object) => void, get: () => object) => object) => {
                let state: object;
                state = fn(value => { Object.assign(state, value); }, () => state);
                return { getState: () => state };
            },
        },
    }, { React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; return {}; } }, URL, fetch: async () => ({ ok: true, text: () => token.promise }) });
    const state = useAuthorizationStore.getState();
    const authorization = state.authorize();
    const rejected = assert.rejects(authorization, /Account changed/);
    const response = callback({ location: "https://example.com/authorize?code=test" });
    await setImmediate();
    userId = "second";
    token.resolve("first-account-token");
    await response;
    await rejected;
    assert.equal(state.token, null);
    assert.deepEqual(Object.keys(state.tokens), []);
});

test("IRC colors preserve existing DM colors when replacement is disabled", () => {
    const store = { lightness: 70, applyColorOnlyToUsersWithoutColor: true, applyColorOnlyInDms: false };
    const { default: plugin } = loadSource("src/plugins/ircColors/index.ts", {
        "@api/Settings": { Settings: { plugins: { CustomUserColors: { enabled: false } } }, definePluginSettings: () => ({ store, use: () => store }) },
        "@equicordplugins/customUserColors": {}, "@intrnl/xxhash64": { hash: () => 10n },
        "@utils/constants": { Devs: {} }, "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { useMemo: (fn: () => unknown) => fn(), UserStore: { getCurrentUser: () => ({ id: "self" }) } },
    });
    const context = { message: { author: { id: "other" } }, author: { colorString: "#123456" }, channel: { isPrivate: () => true } };
    assert.equal(plugin.calculateNameColorForMessageContext(context), "#123456");
    store.applyColorOnlyToUsersWithoutColor = false;
    assert.equal(plugin.calculateNameColorForMessageContext(context), "hsl(190, 100%, 70%)");
});

test("automatic translation cancels failed sends and preserves the original text", async () => {
    let fail = true;
    const { default: plugin } = loadSource("src/plugins/translate/index.tsx", {
        "@api/ContextMenu": {}, "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value }, "@webpack/common": {},
        "./settings": { settings: { store: { autoTranslate: true } } }, "./TranslateIcon": {}, "./TranslationAccessory": {},
        "./utils": { translate: async () => { if (fail) throw new Error("service unavailable"); return { text: "Translated" }; } },
    }, { setTimeout: () => 1, clearTimeout() {} });
    const message = { content: "Original" };
    const result = await plugin.onBeforeMessageSend("channel", message);
    assert.equal(result?.cancel, true);
    assert.equal(message.content, "Original");
    fail = false;
    assert.equal(await plugin.onBeforeMessageSend("channel", message), undefined);
    assert.equal(message.content, "Translated");
});

test("silent typing commands apply both indicator options and preserve omitted values", async () => {
    const store = { hideChatBoxTypingIndicators: false, hideMembersListTypingIndicators: false };
    const replies: string[] = [];
    const { default: plugin } = loadSource("src/plugins/silentTyping/index.tsx", {
        "@api/ChatButtons": {}, "@api/ContextMenu": {}, "@api/PluginManager": {},
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, findOption: (args: Record<string, unknown>, key: string) => args[key], sendBotMessage: (_id: string, message: { content: string; }) => replies.push(message.content) },
        "@api/Settings": { definePluginSettings: () => ({ store }) }, "@components/settings": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} }, "@webpack/common": {},
    });
    const execute = (args: object) => plugin.commands[0].execute(args, { channel: { id: "channel" } });
    await execute({ "chat-bar-indicators": true, "members-list-indicators": true });
    assert.deepEqual(store, { hideChatBoxTypingIndicators: true, hideMembersListTypingIndicators: true });
    assert.equal(replies.at(-1), "Silent typing settings updated.");
    await execute({ "chat-bar-indicators": false });
    assert.deepEqual(store, { hideChatBoxTypingIndicators: false, hideMembersListTypingIndicators: true });
    await execute({ "members-list-indicators": false });
    assert.deepEqual(store, { hideChatBoxTypingIndicators: false, hideMembersListTypingIndicators: false });
});

test("typing summaries name two people and count only the remaining people", () => {
    const React = { Fragment: "fragment", createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
    const { buildSeveralUsers } = loadSource("src/plugins/typingTweaks/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), migratePluginToSettings() {} },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@equicordplugins/customUserColors": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {}, "@utils/guards": {}, "@utils/Logger": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { React }, "./style.css?managed": {},
    });
    for (const total of [4, 5, 8]) {
        const users = Array.from({ length: total }, (_, id) => ({ id: String(id) }));
        const tree = buildSeveralUsers({ users, count: total - 2, guildId: "guild" });
        assert.equal(tree.children[0].length, 2);
        assert.equal(tree.children[2], total - 2);
    }
});

test("missing friendship dates preserve the original status text", () => {
    const { default: plugin } = loadSource("src/plugins/sortFriendRequests/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), migratePluginSettings() {} },
        "@components/BaseText": {}, "@components/Flex": {}, "@components/TooltipContainer": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { RelationshipStore: { getSince: () => undefined } },
    });
    const original = { text: "Incoming friend request" };
    assert.equal(plugin.makeSubtext({ id: "user" }, original), original);
});

test("relationship removal returns notification and storage work to the flux wrapper", async () => {
    let synced = false;
    const { default: plugin } = loadSource("src/plugins/relationshipNotifier/index.ts", {
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "./settings": {},
        "./functions": { onRelationshipRemove: async () => {} },
        "./utils": { syncFriends: async () => { synced = true; throw new Error("storage failed"); } },
    });
    const result = plugin.flux.RELATIONSHIP_REMOVE({});
    assert.equal(synced, true);
    await assert.rejects(result, /storage failed/);
});

test("native app links match literal Steam and VRChat hosts", () => {
    const rules = loadSource("src/plugins/openInApp/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": {},
    }, { VencordNative: { pluginHelpers: {} } }, "UrlReplacementRules");
    assert.equal(rules.steam.shortlinkMatch.test("https://s.team/a"), true);
    assert.equal(rules.steam.shortlinkMatch.test("https://sXteam/a"), false);
    assert.equal(rules.vrcx.match.test("https://vrchat.com/home/user/example"), true);
    assert.equal(rules.vrcx.match.test("https://vrchatXcom/home/user/example"), false);
});

test("reply mention exceptions match whole user and role IDs", () => {
    const store = { userList: "12345, 67890", roleList: "98765\n43210", shouldPingListed: true, inverseShiftReply: false };
    let roles = ["876"];
    const { default: plugin } = loadSource("src/plugins/noReplyMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) }, "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { ChannelStore: { getChannel: () => ({ guild_id: "guild" }) }, GuildMemberStore: { getMember: () => ({ roles }) } },
    });
    const message = { author: { id: "234" }, channel_id: "channel" };
    assert.equal(plugin.shouldMention(message, false), false);
    message.author.id = "67890";
    assert.equal(plugin.shouldMention(message, false), true);
    message.author.id = "other";
    roles = ["43210"];
    assert.equal(plugin.shouldMention(message, false), true);
});

test("new guild defaults use one notification update and preserve server defaults", () => {
    const source = readFileSync("src/plugins/newGuildSettings/index.tsx", "utf8");
    const handler = source.slice(source.indexOf("function applyDefaultSettings("), source.indexOf("export default definePlugin"));
    const code = transpileModule(handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const calls: Array<Record<string, unknown>> = [];
    const store = { messages: 1, guild: true, showAllChannels: false, voiceChannels: false };
    const apply = runInNewContext(code + "\napplyDefaultSettings;", {
        settings: { store }, updateGuildNotificationSettings: (_id: string, values: Record<string, unknown>) => calls.push(values),
    });
    apply("guild");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].muted, true);
    assert.equal(calls[0].message_notifications, 1);
    store.messages = 3;
    apply("guild");
    assert.equal(calls.length, 2);
    assert.equal(Object.hasOwn(calls[1], "message_notifications"), false);
});

test("quick reactions scroll back from the visible offset after the list shrinks", () => {
    const { default: plugin } = loadSource("src/plugins/moreQuickReactions/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { rows: 2, columns: 4, scroll: true } }), migratePluginSettings() {} },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {}, makeRange: () => [] },
    });
    let offset = 20;
    const emojis = Array.from({ length: 12 }, (_, i) => i);
    assert.equal(plugin.applyScroll(emojis, offset)[0], 4);
    plugin.onWheelWrapper(offset, (value: number) => { offset = value; }, emojis.length)({ deltaY: -1, shiftKey: false, stopPropagation() {} });
    assert.equal(offset, 0);
});

test("Spotify embed volume changes use one listener across windows", () => {
    let created: (_event: object, window: object) => void = () => assert.fail("missing window hook");
    let listeners = 0;
    loadSource("src/plugins/fixSpotifyEmbeds.desktop/native.ts", {
        "@main/settings": { RendererSettings: { addChangeListener() { listeners++; } } },
        electron: { app: { on(_event: string, callback: typeof created) { created = callback; } } },
    });
    const window = { webContents: { on() {} } };
    created({}, window);
    created({}, window);
    assert.equal(listeners, 1);
});

test("Dearrow ignores duplicate results and results for replaced embeds", async () => {
    const requests: Array<ReturnType<typeof Promise.withResolvers<object>>> = [];
    const { embedDidMount } = loadSource("src/plugins/dearrow/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { replaceElements: 1, dearrowByDefault: true } }) },
        "@components/ErrorBoundary": {}, "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": {},
    }, { fetch: async () => {
        const request = Promise.withResolvers<object>();
        requests.push(request);
        return { ok: true, json: () => request.promise };
    } }, "({ embedDidMount })");
    const embed = { rawTitle: "Original", provider: { name: "YouTube" }, video: { url: "https://www.youtube.com/embed/abcdefghijk" }, dearrow: undefined as { oldTitle?: string; } | undefined };
    let renders = 0;
    const component = { props: { embed }, forceUpdate() { renders++; } };
    const first = embedDidMount.call(component);
    const duplicate = embedDidMount.call(component);
    const response = { titles: [{ title: "Replacement", votes: 1 }], thumbnails: [] };
    requests[0].resolve(response);
    await first;
    requests[1].resolve(response);
    await duplicate;
    assert.equal(embed.dearrow?.oldTitle, "Original");
    assert.equal(renders, 1);
    const oldEmbed = { ...embed, rawTitle: "Old", dearrow: undefined };
    component.props.embed = oldEmbed;
    const stale = embedDidMount.call(component);
    component.props.embed = embed;
    requests[2].resolve(response);
    await stale;
    assert.equal(oldEmbed.rawTitle, "Old");
    assert.equal(renders, 1);
});

test("custom commands normalize argument names for deduplication and substitution", async () => {
    let command: { execute(args: object, context: object): Promise<void>; } | undefined;
    let content = "";
    const { parseTagArguments, registerTagCommand } = loadSource("src/plugins/customCommands/index.ts", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, registerCommand: (value: typeof command) => { command = value; }, findOption: (args: Record<string, unknown>, name: string, fallback: unknown) => args[name] ?? fallback },
        "@api/Settings": { migratePluginSettings() {} }, "@utils/constants": { Devs: {} },
        "@utils/discord": { sendMessage: (_id: string, message: { content: string; }) => { content = message.content; } },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@webpack/common": { FluxDispatcher: { dispatch() {} }, MessageActions: { getSendMessageOptionsForReply() {} }, PendingReplyStore: { getPendingReply() {} } },
        "./CreateTagModal": {}, "./settings": {},
    });
    const message = "Hello {{User}} / {{USER}} / {{user}}";
    assert.deepEqual(Array.from(parseTagArguments(message), (arg: { name: string; }) => arg.name), ["user"]);
    registerTagCommand({ name: "greet", message });
    assert.ok(command);
    await command.execute({ user: "friend" }, { channel: { id: "channel" } });
    assert.equal(content, "Hello friend / friend / friend");
});

test("ConsoleJanitor reads replaced log-level settings without rebuilding a cache", () => {
    const store = { whitelistedLoggers: "GatewaySocket", allowLevel: { error: true, warn: false } };
    const { default: plugin } = loadSource("src/plugins/consoleJanitor/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/BaseText": {}, "@components/settings/tabs/plugins/components/Common": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, defineDefault: (value: object) => value, OptionType: {}, StartAt: {} },
        "@webpack/common": {},
    });
    plugin.start();
    assert.equal(plugin.shouldLog("other", "error"), true);
    store.allowLevel = { error: false, warn: true };
    assert.equal(plugin.shouldLog("other", "error"), false);
    assert.equal(plugin.shouldLog("other", "warn"), true);
    assert.equal(plugin.shouldLog("GatewaySocket", "error"), true);
});

test("BetterSessions returns its settings-close save to the flux error handler", async () => {
    const savedSessionsCache = new Map();
    const save = Promise.withResolvers<void>();
    const { default: plugin } = loadSource("src/plugins/betterSessions/index.tsx", {
        "@api/Notifications": {}, "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Paragraph": {}, "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findStoreLazy: () => ({ getSessions: () => [{ id_hash: "session" }] }), findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => () => null },
        "@webpack/common": {}, "./components/RenameButton": {},
        "./utils": { savedSessionsCache, saveSessionsToDataStore: () => save.promise },
    });
    const result = plugin.flux.USER_SETTINGS_ACCOUNT_RESET_AND_CLOSE_FORM();
    assert.equal(result, save.promise);
    const rejected = assert.rejects(result, /storage unavailable/);
    save.reject(new Error("storage unavailable"));
    await rejected;
});

test("status preset application validates expiration and reports rejected updates once", async () => {
    const clock = runInNewContext(`(class extends Date {
        constructor(...args) { super(...(args.length ? args : [2026, 2, 29, 0, 30])); }
        static now() { return new this().getTime(); }
    })`);
    const payloads: { expiresAtMs: string; createdAtMs: string; text: string; }[] = [];
    const pending = Promise.withResolvers<void>();
    let updates = 0;
    const toasts: { message: string; type: string; }[] = [];
    const { setStatus } = loadSource("src/equicordplugins/statusPresets/index.tsx", {
        "./style.css": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({ updateSetting: (payload: typeof payloads[number]) => { payloads.push(payload); return ++updates === 1 ? pending.promise : Promise.resolve(); } }) },
        "@components/ErrorBoundary": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/lazy": { proxyLazy: () => ({}) }, "@utils/react": { NoopComponent: () => null },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {}, StartAt: {} },
        "@webpack": { findComponentByCodeLazy: () => () => null, extractAndLoadChunksLazy: () => () => {} },
        "@webpack/common": { Toasts: { show: (toast: { message: string; type: string; }) => toasts.push(toast), Type: { FAILURE: "failure" }, genId: () => "toast" } },
    }, { Date: clock }, "({ setStatus })");
    const applying = setStatus({ text: "Preset", clearAfter: null, emojiInfo: null });
    assert.equal(toasts.length, 0);
    pending.reject(new Error("update failed"));
    await assert.doesNotReject(applying);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "failure");
    assert.equal(toasts[0].message, "Could not apply the status preset.");
    for (const clearAfter of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, "3600"])
        await setStatus({ text: "Preset", clearAfter, emojiInfo: null });
    assert.equal(updates, 1);
    assert.equal(toasts.length, 7);
    assert.equal(payloads[0].expiresAtMs, "0");
    for (const [clearAfter, expected] of [[null, 0], [0, clock.now()], [60_000, clock.now() + 60_000], ["TODAY", new clock(2026, 2, 30).getTime()]] as const) {
        await setStatus({ text: " Preset ", clearAfter, emojiInfo: null });
        const payload = payloads[payloads.length - 1];
        assert.equal(payload.expiresAtMs, String(expected));
        assert.equal(payload.createdAtMs, String(clock.now()));
        assert.equal(payload.text, "Preset");
    }
    assert.equal(updates, 5);
    assert.equal(toasts.length, 7);
});

test("status preset menus subscribe and delete the actual saved key", () => {
    const store = new SettingsStore({ StatusPresets: { savedKey: { text: "display text", emojiInfo: { id: "emoji" } } } }).store;
    let premiumTypeActual = 0;
    let premiumSubscriptions = 0;
    const premiumStore = { getState: () => ({ premiumTypeActual }) };
    const subscriptions: unknown[] = [];
    const { StatusSubMenuComponent } = loadSource("src/equicordplugins/statusPresets/index.tsx", {
        "./style.css": {},
        "@api/Settings": { definePluginSettings: () => ({ store, use: (keys: string[]) => { subscriptions.push(keys); return store; } }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/ErrorBoundary": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/lazy": { proxyLazy: () => ({}) }, "@utils/react": { NoopComponent: () => null },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {}, StartAt: {} },
        "@webpack": { findComponentByCodeLazy: () => () => null, extractAndLoadChunksLazy: () => () => {} },
        "@webpack/common": { Menu: {}, OverridePremiumTypeStore: premiumStore, useStateFromStores: (stores: unknown[], selector: () => unknown) => {
            assert.equal(stores[0], premiumStore);
            premiumSubscriptions++;
            return selector();
        } },
    }, { React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) } }, "({ StatusSubMenuComponent })");
    const menu = StatusSubMenuComponent();
    assert.equal(menu.children[0][0].props.disabled, true);
    premiumTypeActual = 2;
    assert.equal(StatusSubMenuComponent().children[0][0].props.disabled, false);
    menu.children[0][0].children[0].props.action();
    assert.deepEqual(Object.keys(store.StatusPresets), []);
    assert.equal(StatusSubMenuComponent().children[0].length, 0);
    assert.equal(subscriptions.length, 3);
    assert.equal(premiumSubscriptions, 3);
    assert.equal(subscriptions[0], subscriptions[1]);
});

test("status presets save object-property names as ordinary entries", () => {
    const settingsStore = new SettingsStore({ StatusPresets: {} as Record<string, object> });
    const store = settingsStore.store;
    const changes: string[] = [];
    settingsStore.addGlobalChangeListener((_data, path) => changes.push(path));
    const { default: plugin } = loadSource("src/equicordplugins/statusPresets/index.tsx", {
        "./style.css": {},
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/ErrorBoundary": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/lazy": { proxyLazy: () => ({}) }, "@utils/react": { NoopComponent: () => null },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {}, StartAt: {} },
        "@webpack": { findComponentByCodeLazy: () => () => null, extractAndLoadChunksLazy: () => () => {} },
        "@webpack/common": { Toasts: { show() {}, Type: {}, genId: () => "toast" } },
    });
    for (const text of ["existing", "__proto__", "constructor"]) {
        const status = { text, emojiInfo: null, clearAfter: null };
        plugin.renderRememberButton(status).onClick();
        assert.equal(Object.hasOwn(store.StatusPresets, text), true);
        assert.equal(settingsStore.plain.StatusPresets[text], status);
    }
    assert.equal(Object.keys(store.StatusPresets).length, 3);
    const reloaded = new SettingsStore(JSON.parse(JSON.stringify(settingsStore.plain)));
    assert.deepEqual(Object.keys(reloaded.store.StatusPresets), ["existing", "__proto__", "constructor"]);
    assert.equal(reloaded.store.StatusPresets.__proto__.text, "__proto__");
    assert.deepEqual(changes, ["StatusPresets", "StatusPresets", "StatusPresets"]);
});

test("invalid codec responses never partially change the engine", async () => {
    let response = "";
    let writes = 0;
    let errors = 0;
    const { default: plugin } = loadSource("src/equicordplugins/streamingCodecDisabler/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/Logger": { Logger: class { error() { errors++; } } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({
            getCodecCapabilities: (callback: (value: string) => void) => { if (response === "throw") throw new Error("native failure"); callback(response); },
            setAv1Enabled: () => { writes++; },
        }) } },
    });
    plugin.start();
    for (const value of ["throw", "invalid", "null", "{}", '[{"codec":"AV1","encode":true},{"codec":"H264","encode":"false"}]']) {
        response = value;
        await assert.doesNotReject(plugin.updateDisabledCodecs());
    }
    assert.equal(errors, 5);
    assert.equal(writes, 0);
});

test("codec disabling only updates capabilities reported by the current engine", async () => {
    let capabilities = [{ codec: "AV1", encode: true }];
    const calls: unknown[] = [];
    const { default: plugin } = loadSource("src/equicordplugins/streamingCodecDisabler/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { disableAv1Codec: true } }) },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({
            getCodecCapabilities: (callback: (value: string) => void) => callback(JSON.stringify(capabilities)),
            setAv1Enabled: (value: boolean) => calls.push(["AV1", value]),
            setH265Enabled: (value: boolean) => calls.push(["H265", value]),
            setH264Enabled: (value: boolean) => calls.push(["H264", value]),
        }) } },
    });
    plugin.start();
    await plugin.updateDisabledCodecs();
    capabilities = [{ codec: "H264", encode: false }, { codec: "VP8", encode: true }];
    await plugin.updateDisabledCodecs();
    assert.deepEqual(calls, [["AV1", false], ["H264", false]]);
});

test("codec callbacks from stopped runs cannot update the media engine", async () => {
    const callbacks: ((value: string) => void)[] = [];
    const calls: boolean[] = [];
    const { default: plugin } = loadSource("src/equicordplugins/streamingCodecDisabler/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { disableAv1Codec: true } }) },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({
            getCodecCapabilities: (callback: (value: string) => void) => callbacks.push(callback),
            setAv1Enabled: (value: boolean) => calls.push(value),
        }) } },
    });
    plugin.start();
    const old = plugin.updateDisabledCodecs();
    plugin.stop();
    await plugin.updateDisabledCodecs();
    assert.equal(callbacks.length, 1);
    plugin.start();
    const current = plugin.updateDisabledCodecs();
    callbacks[0]('[{"codec":"AV1","encode":true}]');
    await old;
    assert.deepEqual(calls, []);
    callbacks[1]('[{"codec":"AV1","encode":true}]');
    await current;
    assert.deepEqual(calls, [false]);
});

test("TalkInReverse uses one send hook and preserves grapheme clusters", () => {
    const { default: plugin } = loadSource("src/equicordplugins/talkInReverse/index.tsx", {
        "@api/ChatButtons": {},
        "@utils/constants": { EquicordDevs: {} },
        "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@webpack/common": { React: { createElement: (type: unknown, props: unknown) => ({ type, props }) }, zustandCreate: (init: () => { enabled: boolean; }) => {
            let state = init();
            return Object.assign(() => state, { getState: () => state, setState: (next: { enabled: boolean; }) => { state = next; } });
        } },
    });
    const unchanged = { content: "hello" };
    plugin.onBeforeMessageSend("channel", unchanged);
    assert.equal(unchanged.content, "hello");
    const button = plugin.chatBarButton.render({ isMainChat: true });
    const secondButton = plugin.chatBarButton.render({ isMainChat: true });
    button.props.onClick();
    assert.equal(plugin.chatBarButton.render({ isMainChat: true }).props.tooltip, "Disable Reverse Message");
    secondButton.props.onClick();
    assert.equal(plugin.chatBarButton.render({ isMainChat: true }).props.tooltip, "Enable Reverse Message");
    button.props.onClick();
    assert.equal(plugin.chatBarButton.render({ isMainChat: false }), null);
    for (const [content, expected] of [["abc", "cba"], ["a😀b", "b😀a"], ["e\u0301x", "xe\u0301"], ["a👨‍👩‍👧‍👦🇳🇱", "🇳🇱👨‍👩‍👧‍👦a"], ["", ""]]) {
        const message = { content };
        plugin.onBeforeMessageSend("channel", message);
        assert.equal(message.content, expected);
    }
});

test("blocked sticker placeholders subscribe to display preferences", () => {
    let visible = "showGif";
    const subscriptions: unknown[] = [];
    const { default: plugin } = loadSource("src/equicordplugins/stickerBlocker/index.tsx", {
        "@api/ContextMenu": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {}, use: (keys: string[]) => {
            subscriptions.push(keys);
            return Object.fromEntries(keys.map(key => [key, key === visible]));
        } }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} }, "@utils/misc": { classes: () => "" },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": { Button: { Colors: {} }, Menu: {}, React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) } },
    });
    for (const [setting, key] of [["showGif", "gif"], ["showMessage", "message"], ["showButton", "button"]]) {
        visible = setting;
        const rendered = plugin.blockedComponent({ id: "sticker", name: "Sticker" });
        assert.deepEqual(Array.from(rendered.children[0], (element: { props: { key: string; }; }) => element.props.key), [key]);
    }
    assert.equal(subscriptions.length, 3);
    assert.equal(subscriptions[0], subscriptions[2]);
});

test("voice playback keeps a speed selected before first play", () => {
    for (const selected of [false, true]) {
        const preferences: Record<string, unknown> = { defaultVoiceMessageSpeed: 2, defaultAudioSpeed: 1.5 };
        let play: (() => void) | undefined;
        const emitPlay = () => play?.();
        let cleanup: (() => void) | undefined;
        let menu: { children: { children: { props: { label: string; checked: boolean; action(): void; }; }[][]; }[]; } | undefined;
        const media = { tagName: "AUDIO", className: "renamed-discord-class", playbackRate: 1,
            addEventListener: (_event: string, handler: () => void) => { play = handler; },
            removeEventListener: (_event: string, handler: () => void) => { assert.equal(handler, play); play = undefined; },
        };
        const { default: plugin } = loadSource("src/equicordplugins/mediaPlaybackSpeed/index.tsx", {
            "@api/Settings": { definePluginSettings: () => ({ store: preferences }) },
            "@components/Button": { Button: "shared-button" },
            "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
            "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => () => "" },
            "@utils/types": { __esModule: true, default: (value: object) => value, makeRange: () => [1, 2, 3], OptionType: {} },
            "./components/SpeedIcon": {},
            "@webpack/common": {
                React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) }, Menu: {},
                useRef: (current: unknown) => ({ current }), useEffect: (effect: () => () => void) => { cleanup = effect(); },
                ContextMenuApi: { openContextMenu: (_event: unknown, render: () => typeof menu) => { menu = render(); } },
            },
        });
        const view = plugin.renderPlaybackSpeedComponent({ mediaRef: { current: media }, isVoiceMessage: true });
        const button = view.children[0]({});
        assert.equal(button.type, "shared-button");
        assert.equal(button.props["aria-label"], "Playback speed");
        if (selected) {
            button.props.onClick({});
            assert.ok(menu);
            menu.children[0].children[0].find(item => item.props.label === "3x")?.props.action();
            assert.equal(media.playbackRate, 3);
        }
        media.playbackRate = 1;
        emitPlay();
        assert.equal(media.playbackRate, selected ? 3 : 2);
        button.props.onClick({});
        assert.ok(menu);
        assert.deepEqual(menu.children[0].children[0].filter(item => item.props.checked).map(item => item.props.label), [selected ? "3x" : "2x"]);
        cleanup?.();
        assert.equal(play, undefined);
        media.className = "audioElement";
        plugin.renderPlaybackSpeedComponent({ mediaRef: { current: media } });
        assert.equal(media.playbackRate, 1.5);
        assert.equal(play, undefined);
        for (const rate of [NaN, Infinity, -1, 0, 0.1, 4, "2"]) {
            preferences.defaultAudioSpeed = rate;
            preferences.defaultVoiceMessageSpeed = rate;
            plugin.renderPlaybackSpeedComponent({ mediaRef: { current: media } });
            assert.equal(media.playbackRate, 1);
            plugin.renderPlaybackSpeedComponent({ mediaRef: { current: media }, isVoiceMessage: true });
            emitPlay();
            assert.equal(media.playbackRate, 1);
            cleanup?.();
        }
    }
});

test("avatar file reads stop on replacement, typed URLs, and unmount", () => {
    const readers: { result: string; onload?: () => void; onerror?: () => void; aborted: boolean; }[] = [];
    const urls: string[] = [];
    const errors: string[] = [];
    let cleanup: () => void = () => {};
    let stateIndex = 0;
    const { SetAvatarModal } = loadSource("src/equicordplugins/userpfp/AvatarModal.tsx", {
        "@api/DataStore": {}, "@components/Heading": {}, "@components/margins": { Margins: {} },
        "@utils/css": { classNameFactory: () => () => "" }, ".": { data: { avatars: {} } },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useRef: (current: unknown) => ({ current }) },
            useEffect: (effect: () => () => void) => { cleanup = effect(); },
            useState: (value: unknown) => [value, stateIndex++ === 0 ? (url: string) => urls.push(url) : () => {}],
            UserStore: { getUser: () => ({}) }, IconUtils: { getUserAvatarURL: () => "" }, TextInput: "text-input",
            Toasts: { show: ({ message }: { message: string; }) => errors.push(message), Type: { FAILURE: "failure" }, genId: () => "toast" },
        },
    }, { FileReader: class { result = ""; aborted = false; constructor() { readers.push(this); } abort() { this.aborted = true; } readAsDataURL() {} } });
    const tree = SetAvatarModal({ userId: "user", modalProps: {} });
    const fileInput = tree.children[0].children[2].children[1];
    const textInput = tree.children[0].children[1].children[1];
    const select = () => fileInput.props.onChange({ currentTarget: { files: [{ type: "image/png" }], value: "" } });
    select(); select();
    readers[0].result = "old"; readers[0].onload?.();
    assert.equal(readers[0].aborted, true);
    assert.deepEqual(urls, []);
    readers[1].result = "new"; readers[1].onload?.();
    select(); textInput.props.onChange("typed");
    readers[2].result = "stale"; readers[2].onload?.();
    assert.equal(readers[2].aborted, true);
    select(); readers[3].onerror?.();
    assert.deepEqual(errors, ["Could not read the image."]);
    select(); cleanup(); readers[4].onload?.();
    assert.equal(readers[4].aborted, true);
    assert.deepEqual(urls, ["new", "typed"]);
});

test("UserPFP avatar edits commit before publishing and preserve newer stored entries", async () => {
    for (const action of ["Save", "Delete"]) for (const failure of ["none", "write", "invalid"]) {
        const fail = failure !== "none";
        const data = { avatars: { local: "https://fixture.invalid/new.png" }, remoteAvatars: { remote: "https://fixture.invalid/remote.png" } };
        const previous = data.avatars;
        let persisted: Record<string, string> = { local: "old", newer: "other" };
        const toasts: string[] = [];
        const { SetAvatarModal } = loadSource("src/equicordplugins/userpfp/AvatarModal.tsx", {
            "@api/DataStore": { update: async (key: string, updater: (value: object) => Record<string, string>) => {
                assert.equal(key, "avatars");
                const next = updater(failure === "invalid" ? { broken: 42 } : persisted);
                assert.equal(data.avatars, previous);
                if (fail) throw new Error("storage failed");
                persisted = next;
            } },
            "@components/Heading": {}, "@components/margins": { Margins: {} },
            "@utils/css": { classNameFactory: () => () => "" }, ".": { data, KEY_DATASTORE: "avatars", isAvatarMap: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(url => typeof url === "string") },
            "@webpack/common": {
                React: { createElement: (type: unknown, props: unknown) => ({ type, props }), useRef: () => ({ current: null }) },
                useEffect() {}, useState: (value: unknown) => [value, () => {}], UserStore: { getUser: () => ({}) },
                IconUtils: { getUserAvatarURL: () => "original" },
                Toasts: { show: ({ message }: { message: string; }) => toasts.push(message), Type: { FAILURE: "failure" }, genId: () => "toast" },
            },
        });
        let closed = 0;
        const modal = SetAvatarModal({ userId: "local", modalProps: { onClose: () => { closed++; } } });
        await modal.props.actions.find((item: { text: string; }) => item.text === action).onClick();
        assert.deepEqual({ ...persisted }, !fail && action === "Delete" ? { newer: "other" } : { local: fail ? "old" : "https://fixture.invalid/new.png", newer: "other" });
        assert.equal(closed, fail ? 0 : 1);
        assert.deepEqual(toasts, fail ? ["Could not save the avatar."] : []);
        if (fail) assert.equal(data.avatars, previous);
        else assert.equal(data.avatars, persisted);
        assert.equal(Object.hasOwn(persisted, "remote"), false);
    }
});

test("UserPFP ignores stopped loads and rejects malformed remote maps", async () => {
    const invalidResponses: Record<string, unknown> = {
        "invalid-mixed": { avatars: { oldRemote: "remote", broken: 42 } },
        "invalid-null": null, "invalid-array": [], "invalid-missing": {}, "invalid-map-array": { avatars: [] },
    };
    for (const mode of ["local-stop", "remote-stop", "restart", "current", "invalid-local", ...Object.keys(invalidResponses)]) {
        const local = Promise.withResolvers<unknown>();
        const remote = Promise.withResolvers<unknown>();
        const signals: AbortSignal[] = [];
        let reads = 0;
        const errors: unknown[] = [];
        const warnings: string[] = [];
        const { default: plugin, data } = loadSource("src/equicordplugins/userpfp/index.tsx", {
            "@api/DataStore": { get: () => ++reads === 1 ? local.promise : Promise.resolve({ newer: "local" }) },
            "@api/Settings": { definePluginSettings: () => ({ store: { databaseSource: "https://fixture.invalid/data" } }) },
            "@components/Button": {}, "@components/Flex": {}, "@components/Heart": {}, "@components/Icons": {}, "@components/margins": {}, "@components/Notice": {},
            "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
            "@utils/Logger": { Logger: class { error(_message: string, error: unknown) { errors.push(error); } warn(message: string) { warnings.push(message); } } },
            "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack": { extractAndLoadChunksLazy: () => () => {} }, "@webpack/common": {}, "./AvatarModal": {},
        }, { IS_DEV: false, AbortController, URL,
            fetch: async (_url: string, { signal }: { signal: AbortSignal; }) => { signals.push(signal); return { ok: true, json: () => signals.length === 1 ? remote.promise : Promise.resolve({ avatars: { newerRemote: "remote" } }) }; },
        });
        const old = plugin.start();
        if (mode === "local-stop") plugin.stop();
        local.resolve(mode === "invalid-local" ? { original: 42 } : { original: "local" });
        await setImmediate();
        if (mode === "local-stop") {
            await old;
            assert.deepEqual(Object.keys(data.avatars), []);
            assert.equal(signals.length, 0);
            continue;
        }
        if (mode === "remote-stop") plugin.stop();
        if (mode === "restart") await plugin.start();
        remote.resolve(mode in invalidResponses ? invalidResponses[mode] : { avatars: { oldRemote: "remote" } });
        await old;
        assert.deepEqual(Object.keys(data.avatars), mode === "restart" ? ["newer"] : mode === "invalid-local" ? [] : ["original"]);
        assert.deepEqual(Object.keys(data.remoteAvatars), mode === "restart" ? ["newerRemote"] : mode === "current" || mode === "invalid-local" ? ["oldRemote"] : []);
        data.avatars.shared = "https://fixture.invalid/local.png";
        data.remoteAvatars.shared = "https://fixture.invalid/remote.png";
        const avatar = plugin.getAvatarHook(() => "default");
        assert.equal(avatar({ id: "shared" }, true, 128), "https://fixture.invalid/local.png");
        delete data.avatars.shared;
        assert.equal(avatar({ id: "shared" }, true, 128), "https://fixture.invalid/remote.png");
        const guildAvatar = plugin.getAvatarServerHook(() => "default");
        for (const url of ["data:image/png;base64,iVBORw0KGgo=", "https://fixture.invalid/avatar?size=64&signature=a%20b"]) {
            data.avatars.shared = url;
            assert.equal(guildAvatar({ userId: "shared", size: 128, canAnimate: true }), url);
        }
        data.avatars.shared = "https://raw.githubusercontent.com/UserPFP/img-other/main/avatar.gif";
        assert.equal(avatar({ id: "shared" }, false, 128), data.avatars.shared);
        data.avatars.shared = "https://raw.githubusercontent.com/UserPFP/img/main/avatar.gif";
        assert.equal(avatar({ id: "shared" }, false, 128), "https://raw.githubusercontent.com/UserPFP/img/main/avatar.png?animated=false");
        assert.equal(signals[0].aborted, mode === "remote-stop" || mode === "restart");
        assert.equal(errors.length, mode in invalidResponses ? 1 : 0);
        assert.deepEqual(warnings, mode === "invalid-local" ? ["Stored custom avatars are invalid."] : []);
    }
});

test("image URL rewriting preserves unrelated hosts and signed query text", () => {
    const { fixImageUrl } = loadSource("src/plugins/webContextMenus.web/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/clipboard": {}, "@utils/constants": { Devs: {} }, "@utils/web": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { filters: { byCode() {} }, mapMangledModuleLazy: () => ({}) }, "@webpack/common": {},
    }, { IS_VESKTOP: false, IS_EQUIBOP: false, window: {}, URL }, "({ fixImageUrl })");
    for (const url of [
        "https://images.example.test/image?width=40&height=30&quality=80&signature=a%20b",
        "https://cdn.discordapp.com/attachments/1/2/image.png?width=40&signature=a%20b",
        "https://media.discordapp.net.example.test/image?width=40",
    ]) assert.equal(fixImageUrl(url), url);
    assert.equal(fixImageUrl("https://media.discordapp.net/attachments/1/2/image.png?width=40&height=30&size=40&quality=80&format=webp&ex=123&hm=abc"),
        "https://cdn.discordapp.com/attachments/1/2/image.png?ex=123&hm=abc");
});

test("web image copying releases bitmaps and reports conversion, download, and clipboard failures", async () => {
    for (const mode of ["success", "draw", "context", "encode", "clipboard", "http"]) {
        let closed = 0;
        let copied = 0;
        let saved = 0;
        let saveFailure = false;
        const toasts: string[] = [];
        const bitmap = { width: 4, height: 3, close() { closed++; } };
        const canvas = { width: 0, height: 0,
            getContext: () => mode === "context" ? null : ({ drawImage: (image: unknown) => { assert.equal(image, bitmap); if (mode === "draw") throw new Error("draw failed"); } }),
            toBlob: (callback: (data: object | null) => void) => { assert.equal(closed, 1); callback(mode === "encode" ? null : { type: "image/png" }); },
        };
        const { default: plugin } = loadSource("src/plugins/webContextMenus.web/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
            "@utils/clipboard": {}, "@utils/constants": { Devs: {} }, "@utils/web": { saveFile: () => { if (saveFailure) throw new Error("save failed"); saved++; } },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack": { filters: { byCode() {} }, mapMangledModuleLazy: () => ({}) }, "@webpack/common": { showToast: (message: string, type: string) => { assert.equal(type, "failure"); toasts.push(message); }, Toasts: { Type: { FAILURE: "failure" } } },
        }, {
            IS_VESKTOP: false, IS_EQUIBOP: false, window: {}, URL, File: class {},
            fetch: async () => ({ ok: mode !== "http", blob: async () => ({ type: "image/jpeg" }) }),
            createImageBitmap: async () => bitmap, document: { createElement: () => canvas },
            navigator: { clipboard: { write: async () => { copied++; if (mode === "clipboard") throw new Error("clipboard failed"); } } }, ClipboardItem: class {},
        });
        await assert.doesNotReject(plugin.copyImage("https://cdn.discordapp.com/image.jpg"));
        assert.deepEqual(toasts, mode === "success" ? [] : ["Could not copy the image."]);
        assert.equal(closed, mode === "http" ? 0 : 1);
        assert.equal(copied, mode === "success" || mode === "clipboard" ? 1 : 0);
        toasts.length = 0;
        await assert.doesNotReject(plugin.saveImage("https://cdn.discordapp.com/image.jpg"));
        assert.equal(saved, mode === "http" ? 0 : 1);
        assert.deepEqual(toasts, mode === "http" ? ["Could not save the image."] : []);
        toasts.length = 0;
        saveFailure = true;
        await assert.doesNotReject(plugin.saveImage("https://cdn.discordapp.com/image.jpg"));
        assert.deepEqual(toasts, ["Could not save the image."]);
    }
});

test("Steam status sync opens only supported saved status mappings", () => {
    const opened: string[] = [];
    const preferences = { onlineStatus: "online", dndStatus: "none" };
    const { default: plugin } = loadSource("src/equicordplugins/steamStatusSync/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: preferences }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
    }, { open: (url: string) => opened.push(url) });
    for (const value of ["offline", "unknown", "dnd", "online"])
        plugin.flux.USER_SETTINGS_PROTO_UPDATE({ settings: { proto: { status: { status: { value }, showCurrentGame: { value: true } } } } });
    for (const status of ["online", "away", "invisible", "offline", "none", "", "unexpected", "online?extra=value", "../other"]) {
        preferences.onlineStatus = status;
        plugin.flux.USER_SETTINGS_PROTO_UPDATE({ settings: { proto: { status: { status: { value: "online" }, showCurrentGame: { value: true } } } } });
    }
    assert.deepEqual(opened, ["online", "online", "away", "invisible", "offline"].map(status => `steam://friends/status/${status}`));
});

test("GIF alt text excludes URL metadata and handles missing sources", () => {
    const { default: plugin } = loadSource("src/plugins/betterGifAltText/index.ts", {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value },
    });
    for (const [src, expected] of [
        [undefined, "GIF"],
        ["https://example.test/happy-cat123.gif?width=200#preview", "GIF - happy cat"],
        ["https://example.test/happy.GIF", "GIF - happy"],
        ["https://example.test/agif", "GIF - agif"],
        ["https://example.test/hello%20cat.gif", "GIF - hello cat"],
        ["https://example.test/bad%zz.gif", "GIF - bad%zz"],
    ]) {
        assert.equal(plugin.altify({ src }), expected);
    }
    assert.equal(plugin.altify({ alt: "Custom description" }), "Custom description");
});

test("automatic status lifecycle failures are logged without rejecting", async () => {
    for (const mode of ["voice-start", "voice-stop", "game-start", "game-stop"]) {
        let status = "online";
        let fail = false;
        const errors: unknown[] = [];
        const failure = new Error("settings unavailable");
        const file = mode.startsWith("game") ? "src/plugins/autoDndWhilePlaying.discordDesktop/index.ts" : "src/equicordplugins/statusWhileActive.desktop/index.ts";
        const { default: plugin } = loadSource(file, {
            "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd" } }), migratePluginSettings() {} },
            "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: async (value: string) => { if (fail) throw failure; status = value; } }) },
            "@utils/Logger": { Logger: class { error(_message: string, error: unknown) { errors.push(error); } } },
            "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) }, RunningGameStore: { getRunningGames: () => [{}] } },
        });
        if (mode === "game-stop") await plugin.flux.RUNNING_GAMES_CHANGE({ games: [{}] });
        if (mode === "voice-stop") await plugin.start();
        fail = true;
        await assert.doesNotReject(mode.endsWith("start") ? plugin.start() : plugin.stop());
        assert.deepEqual(errors, [failure]);
    }
});

test("automatic statuses retry failed applications and preserve manual choices during activity", async () => {
    for (const voice of [false, true]) {
        for (const initial of ["online", "dnd"]) {
            let status = initial;
            let active = true;
            let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
            const updates: string[] = [];
            const { default: plugin } = loadSource(voice
                ? "src/equicordplugins/statusWhileActive.desktop/index.ts"
                : "src/plugins/autoDndWhilePlaying.discordDesktop/index.ts", {
                "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd", excludeInvisible: false } }), migratePluginSettings() {} },
                "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: (value: string) => {
                    updates.push(value);
                    if (pending) return pending.promise;
                    status = value;
                    return Promise.resolve();
                } }) },
                "@utils/Logger": { Logger: class { error() {} } },
                "@utils/constants": { EquicordDevs: {}, Devs: {} },
                "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => ({ id: "owner" }) },
                    VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: active ? "voice" : undefined }) },
                    RunningGameStore: { getRunningGames: () => active ? [{}] : [] }
                }
            });
            const event = () => voice
                ? plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "owner" }] })
                : plugin.flux.RUNNING_GAMES_CHANGE({ games: active ? [{}] : [] });
            if (initial === "online") {
                pending = Promise.withResolvers<void>();
                const result = event();
                await event();
                assert.deepEqual(updates, ["dnd"]);
                const rejected = assert.rejects(result, /update failed/);
                pending.reject(new Error("update failed"));
                await rejected;
                pending = undefined;
            }
            await event();
            const appliedCount = updates.length;
            status = "invisible";
            await event();
            await event();
            assert.equal(status, "invisible");
            assert.equal(updates.length, appliedCount);
            active = false;
            await event();
            assert.equal(status, "invisible");
            active = true;
            await event();
            assert.equal(status, "dnd");
            pending = Promise.withResolvers<void>();
            active = false;
            const rejected = assert.rejects(event(), /restore failed/);
            pending.reject(new Error("restore failed"));
            await rejected;
            pending = undefined;
            await plugin.stop();
            active = true;
            status = "online";
            pending = Promise.withResolvers<void>();
            const oldUpdate = event();
            const oldPending = pending;
            plugin.flux.LOGOUT();
            pending = undefined;
            await event();
            const oldRejected = assert.rejects(oldUpdate, /old update failed/);
            oldPending.reject(new Error("old update failed"));
            await oldRejected;
            status = "invisible";
            const beforeRepeatedEvent = updates.length;
            await event();
            assert.equal(updates.length, beforeRepeatedEvent);
            assert.equal(status, "invisible");
            await plugin.stop();
        }
    }
});

test("StatusWhileActive never restores another account's status", () => {
    for (const change of ["stop", "leave", "logout", "same", "start", "disconnected", "manual-stop", "manual-leave"]) {
        let userId = "first";
        let status = "online";
        let channelId: string | undefined = "voice";
        const updates: string[] = [];
        const { default: plugin } = loadSource("src/equicordplugins/statusWhileActive.desktop/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd" } }) },
            "@utils/Logger": { Logger: class { error() {} } },
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: (value: string) => { status = value; updates.push(value); } }) },
            "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId }) },
            },
        });
        const changeVoice = () => plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId }] });
        if (change === "disconnected") {
            channelId = undefined;
            plugin.start();
            plugin.stop();
            assert.deepEqual(updates, []);
            continue;
        }
        if (change === "start") plugin.start();
        else changeVoice();
        assert.deepEqual(updates, ["dnd"]);
        if (change === "same") {
            status = "idle";
            plugin.flux.VOICE_CHANNEL_STATUS_UPDATE?.({ id: "unrelated", guild_id: "guild", status: "Chatting" });
            assert.equal(status, "idle");
            status = "dnd";
        }
        if (change.startsWith("manual")) {
            status = "invisible";
            if (change === "manual-leave") {
                channelId = undefined;
                changeVoice();
            }
            plugin.stop();
            assert.deepEqual(updates, ["dnd"]);
            assert.equal(status, "invisible");
            continue;
        }
        if (change === "logout") plugin.flux.LOGOUT();
        if (change !== "same" && change !== "start") {
            userId = "second";
            status = "idle";
        }
        if (change === "leave") {
            channelId = undefined;
            changeVoice();
        }
        plugin.stop();
        assert.deepEqual(updates, change === "same" || change === "start" ? ["dnd", "online"] : ["dnd"]);
    }
});

test("AutoDND starts from currently running games and restores on stop", async () => {
    for (const mode of ["playing", "empty", "invisible", "logged-out"]) {
        let status = mode === "invisible" ? "invisible" : "online";
        const updates: string[] = [];
        const { default: plugin } = loadSource("src/plugins/autoDndWhilePlaying.discordDesktop/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd", excludeInvisible: true } }), migratePluginSettings() {} },
            "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: async (value: string) => { status = value; updates.push(value); } }) },
            "@utils/Logger": { Logger: class { error() { assert.fail("Unexpected status failure"); } } },
            "@utils/constants": { Devs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => mode === "logged-out" ? undefined : { id: "account" } },
                RunningGameStore: { getRunningGames: () => mode === "empty" ? [] : [{}] },
            },
        });
        await plugin.start();
        assert.deepEqual(updates, mode === "playing" ? ["dnd"] : []);
        await plugin.stop();
        assert.deepEqual(updates, mode === "playing" ? ["dnd", "online"] : []);
    }
});

test("AutoDND restores each game's saved status only once", () => {
    let userId = "first";
    let status = "online";
    const preferences = { statusToSet: "dnd", excludeInvisible: false };
    const updates: string[] = [];
    const { default: plugin } = loadSource("src/plugins/autoDndWhilePlaying.discordDesktop/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: preferences }), migratePluginSettings() {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: (value: string) => { status = value; updates.push(value); } }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
    });
    const change = plugin.flux.RUNNING_GAMES_CHANGE;
    change({ games: [{}] });
    change({ games: [] });
    assert.deepEqual(updates, ["dnd", "online"]);
    status = "idle";
    change({ games: [] });
    assert.equal(status, "idle");
    change({ games: [{}] });
    change({ games: [] });
    assert.deepEqual(updates, ["dnd", "online", "dnd", "idle"]);
    change({ games: [{}] });
    userId = "second";
    status = "invisible";
    change({ games: [] });
    assert.equal(status, "invisible");
    change({ games: [{}] });
    plugin.flux.LOGOUT();
    status = "online";
    change({ games: [] });
    assert.equal(status, "online");
    for (const action of ["stop", "manual-stop", "manual-exit", "foreign-stop"]) {
        status = "online";
        change({ games: [{}] });
        if (action.startsWith("manual")) status = "idle";
        if (action === "foreign-stop") { userId = "third"; status = "invisible"; }
        if (action === "manual-exit") change({ games: [] });
        plugin.stop();
        assert.equal(status, action === "stop" ? "online" : action === "foreign-stop" ? "invisible" : "idle");
    }
    status = "invisible";
    change({ games: [{}] });
    preferences.excludeInvisible = true;
    change({ games: [] });
    assert.equal(status, "invisible");
    change({ games: [{}] });
    assert.equal(status, "invisible");
    status = "online";
    change({ games: [{}] });
    status = "invisible";
    change({ games: [{}] });
    assert.equal(status, "invisible");
    change({ games: [] });
    assert.equal(status, "invisible");
});

test("Apple Music format substitutions preserve literal metadata", () => {
    const source = readFileSync("src/plugins/appleMusic.desktop/index.tsx", "utf8");
    const handler = source.slice(source.indexOf("function customFormat("), source.indexOf("function getLink("));
    const code = transpileModule(handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const format = runInNewContext(code + "\ncustomFormat;");
    assert.equal(format("{name} / {artist} / {album}", { name: "$& {artist}", artist: "$'", album: "$$" }), "$& {artist} / $' / $$");
    assert.equal(format("{name} {name} {album}", { name: "Song" }), "Song Song ");
});

test("Apple Music preserves empty metadata fields when parsing a track", async () => {
    const source = readFileSync("src/plugins/appleMusic.desktop/native.ts", "utf8");
    const code = transpileModule(source.slice(source.indexOf("export async function fetchTrackData")), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const outputs = ["playing", "12", "42\nSong\n\nArtist\n180\n"];
    const getTrack = runInNewContext(code + "\nexports.fetchTrackData;", {
        exports: {}, exec: async () => {}, applescript: async () => outputs.shift(), fetchRemoteData: async () => null,
    });
    const track = await getTrack();
    assert.equal(track.name, "Song");
    assert.equal(track.album, "");
    assert.equal(track.artist, "Artist");
    assert.equal(track.duration, 180);
});

test("chunk-map inspection removes its prototype hook when webpack throws", () => {
    const source = readFileSync("src/debug/loadLazyChunks.ts", "utf8");
    const handler = source.slice(source.indexOf("function getWebpackChunkMap()"), source.indexOf("export async function loadLazyChunks"));
    const code = transpileModule(handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const inspect = runInNewContext(code + `
        const before = Object.getOwnPropertySymbols(Object.prototype).length;
        let failed = false;
        try { getWebpackChunkMap(); } catch { failed = true; }
        ({ failed, before, after: Object.getOwnPropertySymbols(Object.prototype).length });
    `, { wreq: { u() { throw new Error("lookup failed"); } } });
    assert.equal(inspect.failed, true);
    assert.equal(inspect.after, inspect.before);
});

test("failed changelog checks cannot report a cached repository as current", async () => {
    const source = readFileSync("src/components/settings/tabs/changelog/index.tsx", "utf8");
    const start = source.indexOf("    const fetchChangelog =");
    const handler = source.slice(start, source.indexOf("    React.useEffect(", start));
    const code = transpileModule(handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const errors: unknown[] = [];
    const toasts: Array<{ type: string; }> = [];
    const check = runInNewContext(code + "\nfetchChangelog;", {
        React: { useCallback: (callback: unknown) => callback }, repoPending: false, repoErr: null,
        loadNewPlugins() {}, loadChangelogHistory() {}, setIsLoading() {}, setError: (value: unknown) => errors.push(value),
        VencordNative: { updater: { getUpdates: async () => ({ ok: false, error: { message: "offline" } }) } },
        Vencord: { Settings: { updateChannel: "nightly" } }, gitHash: "current",
        getLastRepositoryCheckHash: async () => "current",
        setRecentlyChecked: () => assert.fail("failed request is not current"),
        UpdateLogger: { error() {} }, Toasts: { show: (toast: { type: string; }) => toasts.push(toast), genId: () => "id", Type: { FAILURE: "failure" }, Position: {} },
    });
    await check();
    assert.equal(errors.at(-1), "offline");
    assert.deepEqual(toasts.map(toast => toast.type), ["failure"]);
});

test("completed updates do not wait for the restart prompt to close", async () => {
    let opened = 0;
    const { Updatable } = loadSource("src/components/settings/tabs/updater/Components.tsx", {
        "@components/Button": {}, "@components/Card": {}, "@components/ErrorCard": {}, "@components/Flex": {},
        "@components/Link": {}, "@components/Paragraph": {}, "@components/Span": {}, "@utils/margins": { Margins: {} },
        "@utils/native": { relaunch() {} }, "@utils/updater": { changes: [{}], update: async () => true },
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ props, children }) },
            useState: (value: unknown) => [value, () => {}], openModal: () => { opened++; },
        },
        "./runWithDispatch": { runWithDispatch: (_dispatch: unknown, action: () => Promise<void>) => action },
    });
    const tree = Updatable({ repo: "", repoPending: false });
    let finished = false;
    const action = tree.children[0].children[1].props.onClick().then(() => { finished = true; });
    await setImmediate();
    assert.equal(opened, 1);
    assert.equal(finished, true, "opening the prompt must not keep the update action pending");
    await action;
});

test("failed local theme deletion preserves settings", async () => {
    const source = readFileSync("src/components/settings/tabs/themes/index.tsx", "utf8");
    const start = source.indexOf("onDelete={async () => {");
    const handler = source.slice(start + "onDelete={".length, source.indexOf("}}", start) + 1);
    const calls: string[] = [];
    let fail = true;
    const remove = runInNewContext("(" + handler + ")", {
        localTheme: { fileName: "theme.css" },
        VencordNative: { themes: { deleteTheme: async () => { calls.push("delete"); if (fail) throw new Error("denied"); } } },
        clearThemeState: () => calls.push("clear"), refreshLocalThemes: async () => { calls.push("refresh"); },
        showToast: () => calls.push("error"), Toasts: { Type: { FAILURE: 1 } },
    });
    await remove();
    assert.deepEqual(calls, ["delete", "error"]);
    calls.length = 0;
    fail = false;
    await remove();
    assert.deepEqual(calls, ["delete", "clear", "refresh"]);
});

test("theme uploads finish after read failures and refresh successful files", async () => {
    const source = readFileSync("src/components/settings/tabs/themes/index.tsx", "utf8");
    const handler = source.slice(source.indexOf("    async function onFileUpload("), source.indexOf("    function addThemeLink("));
    const code = transpileModule(handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const uploaded: string[] = [];
    const messages: string[] = [];
    let refreshes = 0;
    const upload = runInNewContext(code + "\nonFileUpload;", {
        VencordNative: { themes: { uploadTheme: async (name: string) => { uploaded.push(name); } } },
        refreshLocalThemes: async () => { refreshes++; },
        showToast: (message: string) => messages.push(message), Toasts: { Type: { FAILURE: 1 } },
    });
    await upload({ stopPropagation() {}, preventDefault() {}, currentTarget: { files: [
        { name: "good.css", text: async () => "body {}" },
        { name: "broken.css", text: async () => { throw new Error("read failed"); } },
        { name: "ignore.txt", text: () => assert.fail("non-CSS file should not be read") },
    ] } });
    assert.deepEqual(uploaded, ["good.css"]);
    assert.deepEqual(messages, ["Some themes could not be uploaded."]);
    assert.equal(refreshes, 1);
});

test("theme validation belongs to the current URL and cancels obsolete requests", async () => {
    let state: unknown = null;
    let effect: () => (() => void) | undefined = () => assert.fail("effect was not registered");
    const pending: Array<{ signal: AbortSignal; resolve: (response: object) => void; }> = [];
    const { OnlineThemesSection } = loadSource("src/components/settings/tabs/themes/OnlineThemes.tsx", {
        "@components/Button": { Button: "button" }, "@components/FormSwitch": {}, "@components/Heading": {},
        "@components/Link": {}, "@components/Notice": { Notice: {} }, "@components/Paragraph": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/margins": { Margins: {} },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) },
            useState: () => [state, (value: unknown) => { state = value; }],
            useEffect: (callback: typeof effect) => { effect = callback; },
        },
    }, { AbortController, fetch: (_url: string, options: { signal: AbortSignal; }) => new Promise(resolve => pending.push({ signal: options.signal, resolve })) });
    const render = (link: string) => OnlineThemesSection({ currentThemeLink: link, enableOnlineThemes: true });
    const addButton = (tree: { children: Array<{ children?: Array<{ type: string; props: { disabled: boolean; }; }>; }>; }) => tree.children.flatMap(child => child?.children ?? []).find(child => child.type === "button");
    const valid = { ok: true, headers: { get: () => "text/css" }, body: { cancel: async () => {} } };
    render("https://example.com/first.css");
    const cleanup = effect();
    cleanup?.();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, true);
    effect();
    pending[0].resolve(valid);
    await setImmediate();
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, true);
    pending[1].resolve(valid);
    await setImmediate();
    assert.equal(addButton(render("https://example.com/second.css"))?.props.disabled, false);
    assert.equal(addButton(render("https://example.com/third.css"))?.props.disabled, true);
});

test("number settings accept decimals without changing the displayed value", () => {
    const states: unknown[] = [];
    const saved: unknown[] = [];
    const { NumberSetting } = loadSource("src/components/settings/tabs/plugins/components/NumberSetting.tsx", {
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ ...props, children }) },
            useState(initial: unknown) {
                const index = states.push(initial) - 1;
                return [initial, (value: unknown) => { states[index] = value; }];
            },
        },
        "./Common": { resolveError: () => null },
    });
    const tree = NumberSetting({ setting: { type: 1, default: 0 }, pluginSettings: {}, definedSettings: {}, id: "number", onChange: (value: unknown) => saved.push(value) });
    for (const value of ["1.5", "-0.25", "1e3", "9007199254740992"]) {
        tree.children[0].onChange(value);
        assert.equal(saved.at(-1), Number(value));
        assert.equal(states[0], value);
    }
});

test("plugin reset restores selected defaults without changing definitions", () => {
    const source = readFileSync("src/components/settings/tabs/plugins/PluginModal.tsx", "utf8");
    const resetSource = source.slice(source.indexOf("function resetSettings("), source.indexOf("export function openWarningModal("));
    const code = transpileModule(resetSource, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const reset = runInNewContext(code + "\nresetSettings;", {
        OptionType: { SELECT: 1, STRING: 2 },
        Toasts: { show() {}, genId: () => "test", Type: { SUCCESS: 1 }, Position: { TOP: 1 } },
    });
    const def = Object.freeze({
        choice: Object.freeze({ type: 1, options: [{ value: "first" }, { value: "default", default: true }] }),
        text: Object.freeze({ type: 2, default: "original" }),
    });
    const store = { choice: "first", text: "changed", enabled: true };
    reset({ name: "Fixture", settings: { def, store } });
    assert.equal(store.choice, "default");
    assert.equal(store.text, "original");
    assert.equal(store.enabled, true);
});

test("editable text begins each edit with the current parent value", () => {
    const states: unknown[] = [];
    let cursor = 0;
    const { EditableText } = loadSource("src/components/settings/EditableText.tsx", {
        "@components/BaseText": {},
        "@webpack/common": {
            React: { createElement: (_type: unknown, props: object) => props },
            useEffect() {}, useRef: () => ({ current: null }),
            useState(initial: unknown) {
                const index = cursor++;
                if (index >= states.length) states.push(initial);
                return [states[index], (value: unknown) => { states[index] = value; }];
            },
        },
    });
    const render = (value: string) => { cursor = 0; return EditableText({ value, onChange() {} }); };
    render("original");
    render("updated elsewhere").onClick();
    assert.equal(render("updated elsewhere").value, "updated elsewhere");
});

test("disabled links remove navigation and click activation", () => {
    const { Link } = loadSource("src/components/Link.tsx", {
        "@utils/misc": { classes: () => "" },
    }, { React: { createElement: (_type: unknown, props: object) => props } });
    const onClick = () => {};
    const props = { href: "https://example.com", onClick, tabIndex: 0 };
    const disabled = Link({ ...props, disabled: true });
    assert.equal(disabled.href, undefined);
    assert.equal(disabled.onClick, undefined);
    assert.equal(disabled.tabIndex, -1);
    assert.equal(disabled["aria-disabled"], true);
    const enabled = Link(props);
    assert.equal(enabled.href, props.href);
    assert.equal(enabled.onClick, onClick);
    assert.equal(enabled.tabIndex, 0);
});

test("compatibility text does not mutate caller-owned styles", () => {
    const { TextCompat } = loadSource("src/components/BaseText.tsx", {
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/misc": { classes: () => "" },
    }, { React: { createElement: (_component: unknown, props: object) => props } });
    const style = Object.freeze({ color: "red", margin: 4 });
    const result = TextCompat({ color: "text-muted", style, children: "Text" });
    assert.equal(style.color, "red");
    assert.equal(result.style.margin, 4);
    assert.equal(result.style.color, "var(--text-muted, var(--text-default))");
    assert.notEqual(result.style, style);
});

test("stopped emoji whitelist startup cannot restore stale entries", async () => {
    let finish: (value: object[]) => void = () => {};
    const { default: plugin } = loadSource("src/equicordplugins/whitelistedEmojis/index.tsx", {
        "@api/index": { DataStore: { get: () => new Promise(resolve => { finish = resolve; }) } },
        "@api/Settings": { definePluginSettings: () => ({ store: { defaultEmojis: true, serverEmojis: true } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@utils/web": {}, "@webpack/common": {},
    });
    const emoji = { type: "emoji", id: "1", name: "test" };
    const first = plugin.start();
    plugin.stop();
    finish([emoji]);
    await first;
    assert.equal(plugin.filterEmojis([emoji]).length, 0);
    const second = plugin.start();
    finish([emoji]);
    await second;
    assert.equal(plugin.filterEmojis([emoji]).length, 1);
    assert.deepEqual(Object.keys(plugin.contextMenus).sort(), ["expression-picker", "guild-context"]);
});

test("webpack tar archives contain only the supplied byte view", () => {
    const { default: TarFile } = loadSource("src/equicordplugins/webpackTarball/tar.ts", {});
    const tar = new TarFile();
    const backing = Uint8Array.from([99, 1, 2, 3, 88]);
    tar.addFile("first.bin", backing.subarray(1, 4));
    tar.addFile("second.bin", Uint8Array.from([4, 5]));
    const archive = Buffer.concat(tar.buffers.map((value: ArrayBuffer) => Buffer.from(value)));
    assert.deepEqual(Array.from(archive.subarray(512, 515)), [1, 2, 3]);
    assert.equal(archive.subarray(1024, 1034).toString(), "second.bin");
    assert.equal(archive.length, 2048);
});

test("message pronoun visibility subscribes to self settings and account changes", () => {
    let showSelf = true;
    let currentId = "me";
    const userStore = { getCurrentUser: () => ({ id: currentId }) };
    const api = loadSource("src/plugins/userMessagesPronouns/PronounsChatComponent.tsx", {
        "@api/UserSettings": { getUserSettingLazy: () => ({ useSetting: () => true }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/discord": {}, "@utils/misc": {}, "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": { UserStore: userStore, useStateFromStores: (stores: unknown[], read: () => unknown) => { assert.equal(stores[0], userStore); return read(); } },
        "./settings": { settings: { store: { showSelf: true }, use: (keys: string[]) => { assert.equal(keys[0], "showSelf"); return { showSelf }; } } }, "./utils": {}
    }, { React: { createElement: () => ({}) } });
    for (const render of [api.PronounsChatComponentWrapper, api.CompactPronounsChatComponentWrapper]) {
        const message = { author: { id: "me" }, type: 0 };
        showSelf = true; currentId = "me";
        assert.notEqual(render({ message }), null);
        showSelf = false;
        assert.equal(render({ message }), null);
        currentId = "other";
        assert.notEqual(render({ message }), null);
        assert.equal(render({ message: { ...message, author: { id: "bot", bot: true } } }), null);
    }
});

test("message pronouns use the message channel instead of the browsed channel", () => {
    let format = "original";
    const subscriptions: string[][] = [];
    const profileStore = { getUserProfile: () => ({ pronouns: "Global" }), getGuildMemberProfile: (_id: string, guild: string) => ({ pronouns: guild === "message-guild" ? "Message" : "Wrong" }) };
    const channelStore = { getChannel: (id: string) => id === "message-channel" ? { getGuildId: () => "message-guild" } : undefined };
    const api = loadSource("src/plugins/userMessagesPronouns/utils.ts", {
        "@utils/discord": { getCurrentChannel: () => ({ getGuildId: () => "browsed-guild" }) },
        "@webpack/common": { UserProfileStore: profileStore, ChannelStore: channelStore, useStateFromStores: (_stores: unknown[], read: () => unknown) => read() },
        "./settings": { PronounsFormat: { Lowercase: "lowercase" }, settings: { store: {}, use: (keys: string[]) => { subscriptions.push(keys); return { pronounsFormat: format }; } } }
    });
    assert.equal(api.useFormattedPronouns("user", "message-channel"), "Message");
    assert.equal(api.useFormattedPronouns("user", "dm"), "Global");
    format = "lowercase";
    assert.equal(api.useFormattedPronouns("user", "message-channel"), "message");
    assert.equal(subscriptions.length, 3);
    assert.equal(subscriptions[0], subscriptions[1]);
    assert.equal(subscriptions[0][0], "pronounsFormat");
});

test("voice rejoin requires the saved owner and current account to match", async () => {
    for (const mode of ["ownerless", "foreign", "switch", "unknown-session"]) {
        let currentId = "me";
        let reconnect: () => Promise<void> = async () => assert.fail("Missing reconnect");
        const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
            "@utils/misc": {},
            "@api/DataStore": { getMany: async () => {
                if (mode === "switch") currentId = "other";
                return [{ userId: mode === "ownerless" ? undefined : mode === "foreign" ? "other" : "me", channelId: "voice", guildId: "guild", timestamp: 1000 }, mode === "unknown-session" ? undefined : true];
            } },
            "@api/Settings": { definePluginSettings: () => ({ store: { rejoinDelay: 2 } }) },
            "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: currentId }) }, ChannelStore: { getChannel: () => assert.fail("Must not look up an unowned reconnect") } }
        }, { setTimeout: (callback: typeof reconnect) => { reconnect = callback; return 1; }, clearTimeout() {} });
        api.default.flux.CONNECTION_OPEN();
        await reconnect();
        api.default.stop();
    }
});

test("voice rejoin rejects malformed saved channels before looking them up", async () => {
    for (const saved of [{ channelId: 5, guildId: null, timestamp: 1000 }, { channelId: "voice", guildId: {}, timestamp: 1000 }, { channelId: "voice", guildId: null }, { channelId: "voice", guildId: null, timestamp: NaN }, { channelId: "voice", guildId: null, timestamp: -1 }]) {
        let reconnect: () => Promise<void> = async () => assert.fail("Missing reconnect");
        const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
            "@utils/misc": {},
            "@api/DataStore": { get: async () => true, getMany: async () => [{ userId: "me", ...saved }, true] },
            "@api/Settings": { definePluginSettings: () => ({ store: { rejoinDelay: 2 } }) },
            "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) }, ChannelStore: { getChannel: () => assert.fail("Malformed saved channel reached lookup") } }
        }, { setTimeout: (callback: typeof reconnect) => { reconnect = callback; return 1; }, clearTimeout() {} });
        await api.default.flux.CONNECTION_OPEN();
        await reconnect();
        api.default.stop();
    }
});

test("voice rejoin waits for voice state confirmation before persisting success", async () => {
    let reconnect: () => Promise<void> = async () => assert.fail("Missing reconnect");
    let dispatched = 0;
    let active = true;
    const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": {},
        "@api/DataStore": { get: async (key: string) => key === "VCLastVoiceChannelSession" ? true : { userId: "me", channelId: "previous", guildId: "guild", timestamp: 1000 }, getMany: async () => [{ userId: "me", channelId: "previous", guildId: "guild", timestamp: 1000 }, active], set: () => assert.fail("A requested join is not confirmation") },
        "@api/Settings": { definePluginSettings: () => ({ store: { rejoinDelay: 2, rejoinTimeout: 30, preventReconnectIfCallEnded: "none" } }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false }) },
            UserStore: { getCurrentUser: () => ({ id: "me" }) },
            VoiceStateStore: { getVoiceStateForUser: () => undefined },
            FluxDispatcher: { dispatch: (event: { type: string; channelId: string; }) => { assert.equal(event.type, "VOICE_CHANNEL_SELECT"); assert.equal(event.channelId, "previous"); dispatched++; } }
        }
    }, { Date: { now: () => 2000 }, setTimeout: (callback: typeof reconnect) => { reconnect = callback; return 1; }, clearTimeout() {} });
    await api.default.flux.CONNECTION_OPEN();
    await reconnect();
    assert.equal(dispatched, 1);
    await api.default.flux.CONNECTION_OPEN();
    active = false;
    await reconnect();
    assert.equal(dispatched, 1);
    api.default.stop();
});

test("voice rejoin stops channel polling after cancellation", async () => {
    let wake: () => void = () => assert.fail("Missing wait");
    let reads = 0;
    const wait = () => new Promise<void>(resolve => { wake = resolve; });
    const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": { sleep: wait },
        "@api/DataStore": {}, "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack/common": { ChannelStore: { getChannel: () => { reads++; return undefined; } } }
    }, { setTimeout: (callback: () => void) => { wake = callback; return 1; } }, "({ waitForChannel, cancelReconnectAttempt })");
    const pending = api.waitForChannel("missing", 0);
    assert.equal(reads, 1);
    api.cancelReconnectAttempt();
    wake();
    await Promise.resolve();
    assert.equal(reads, 1);
    assert.equal(await pending, undefined);
    assert.equal(await api.waitForChannel("missing", 0), undefined);
    assert.equal(reads, 1);
});

test("voice rejoin ignores cache updates from saves completed after logout", async () => {
    for (const active of [true, false]) {
        let finish: () => void = () => assert.fail("Missing write");
        let writes = 0;
        const write = () => { writes++; return writes === 1 ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve(); };
        const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": {},
            "@api/DataStore": { set: write, setMany: write },
            "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
            "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class {} },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
            "@webpack/common": {}
        }, {}, "({ plugin: exports.default, persistActiveState, persistInactiveState })");
        const save = () => active ? api.persistActiveState({ channelId: "voice" }) : api.persistInactiveState();
        const pending = save();
        api.plugin.flux.LOGOUT();
        finish();
        await pending;
        await save();
        assert.equal(writes, 2);
    }
});

test("voice rejoin saves the channel and session flag in one transaction", async () => {
    let writes = 0;
    const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": {},
        "@api/DataStore": { set: () => assert.fail("Separate writes can partially commit"), setMany: async (entries: [string, unknown][]) => {
            writes++;
            assert.equal(entries[0][0], "VCLastVoiceChannel");
            assert.equal(JSON.stringify(entries[0][1]), JSON.stringify({ userId: "me", guildId: "guild", channelId: "voice", timestamp: 1000 }));
            assert.equal(entries[1][0], "VCLastVoiceChannelSession");
            assert.equal(entries[1][1], true);
            if (writes === 1) throw new Error("Aborted");
        } },
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack/common": {}
    }, { Date: { now: () => 1000 } }, "({ persistActiveState })");
    const state = { userId: "me", channelId: "voice", guildId: "guild" };
    await assert.rejects(api.persistActiveState(state), /Aborted/);
    await api.persistActiveState(state);
    await api.persistActiveState(state);
    assert.equal(writes, 2);
});

test("voice rejoin cancels pending attempts when the current user changes voice state", async () => {
    for (const channelId of ["chosen", undefined, "logout"]) {
        let reconnect: () => Promise<void> = async () => assert.fail("Missing reconnect");
        let cleared = 0;
        let reads = 0;
        const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": {},
            "@api/DataStore": { get: async () => { reads++; return true; }, set: async () => {}, setMany: async () => {} },
            "@api/Settings": { definePluginSettings: () => ({ store: { rejoinDelay: 2 } }) },
            "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) } }
        }, { setTimeout: (callback: typeof reconnect) => { reconnect = callback; return 1; }, clearTimeout: () => { cleared++; } });
        await api.default.flux.CONNECTION_OPEN();
        api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", channelId: "unrelated" }] });
        assert.equal(cleared, 0);
        if (channelId === "logout") api.default.flux.LOGOUT?.();
        else api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "me", channelId }] });
        assert.equal(cleared, 1);
        await reconnect();
        assert.equal(reads, 0);
        api.default.stop();
    }
});

test("voice rejoin leaves an existing voice connection active", async () => {
    let available = true;
    let reconnect: () => Promise<void> = async () => assert.fail("Missing reconnect");
    const api = loadSource("src/equicordplugins/voiceRejoin/index.tsx", {
        "@utils/misc": { sleep: async () => {} },
        "@api/DataStore": { get: async (key: string) => key === "VCLastVoiceChannelSession" ? true : { userId: "me", channelId: "previous", guildId: "guild", timestamp: 1000 }, getMany: async () => [{ userId: "me", channelId: "previous", guildId: "guild", timestamp: 1000 }, true], set: () => assert.fail("Must not mark an active connection inactive") },
        "@api/Settings": { definePluginSettings: () => ({ store: { rejoinDelay: 2, rejoinTimeout: 30, preventReconnectIfCallEnded: "none" } }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack/common": {
            ChannelStore: { getChannel: () => available ? ({ isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false }) : undefined },
            UserStore: { getCurrentUser: () => ({ id: "me" }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "current" }) },
            FluxDispatcher: { dispatch: () => assert.fail("Must not replace the active connection") }
        }
    }, { Date: { now: () => 2000 }, setTimeout: (callback: typeof reconnect) => { reconnect = callback; return 1; }, clearTimeout() {} });
    await api.default.flux.CONNECTION_OPEN();
    await reconnect();
    available = false;
    await api.default.flux.CONNECTION_OPEN();
    await reconnect();
    api.default.stop();
});

test("voice statistics replace clean cached totals when storage changes", async () => {
    let saved: Record<string, number> | undefined = { friend: 20, removed: 9 };
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": { get: async () => saved }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": { UserStore: { getCurrentUser: () => undefined } }
    }, {}, "({ plugin: exports.default, totalsByUser })");
    await api.plugin.start();
    api.plugin.stop();
    saved = { friend: 30 };
    await api.plugin.start();
    assert.equal(api.totalsByUser.get("friend"), 30);
    assert.equal(api.totalsByUser.has("removed"), false);
    api.plugin.stop();
    saved = undefined;
    await api.plugin.start();
    assert.equal(api.totalsByUser.size, 0);
    api.plugin.stop();
});

test("voice statistics preserve unsaved totals when restarted after a failed write", async () => {
    let fail = true;
    let stored = { friend: 20 };
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": { get: async () => stored, set: async (_key: string, value: typeof stored) => { if (fail) throw new Error("Failed"); stored = value; } },
        "@components/BaseText": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": { UserStore: { getCurrentUser: () => undefined } }
    }, { Date: { now: () => 41000 } }, "({ plugin: exports.default, sessionStarts, totalsByUser, flushActiveSessions, persistTotals })");
    await api.plugin.start();
    api.sessionStarts.set("friend", 1000);
    api.flushActiveSessions();
    await api.persistTotals();
    api.plugin.stop();
    await api.plugin.start();
    assert.equal(api.totalsByUser.get("friend"), 60);
    fail = false;
    await api.persistTotals();
    assert.equal(stored.friend, 60);
    api.plugin.stop();
});

test("voice statistics reject malformed saved totals without starting or overwriting them", async () => {
    for (const saved of [null, [], "bad", 5, { friend: "5" }, { friend: -1 }, { friend: NaN }, { friend: Infinity }, { friend: 1.5 }]) {
        let errors = 0;
        const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
            "@utils/Logger": { Logger: class { error() { errors++; } } },
            "@api/DataStore": { get: async () => saved, set: () => assert.fail("Must preserve malformed data") }, "@components/BaseText": {},
            "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
            "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
            "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
            "@webpack/common": { UserStore: { getCurrentUser: () => assert.fail("Must not start tracking") } }
        }, {}, "({ plugin: exports.default, totalsByUser })");
        await api.plugin.start();
        assert.equal(api.totalsByUser.size, 0);
        assert.equal(errors, 1);
        api.plugin.stop();
    }
});

test("voice statistics retain failed saves for the next persistence attempt", async () => {
    let attempts = 0;
    let errors = 0;
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() { errors++; } } },
        "@api/DataStore": { set: async () => { if (++attempts === 1) throw new Error("Write failed"); } }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": {}
    }, { Date: { now: () => 2000 } }, "({ sessionStarts, flushActiveSessions, persistTotals })");
    api.sessionStarts.set("friend", 1000);
    api.flushActiveSessions();
    await assert.doesNotReject(api.persistTotals());
    assert.equal(errors, 1);
    await api.persistTotals();
    await api.persistTotals();
    assert.equal(attempts, 2);
});

test("voice statistics wait for stored totals before starting tracking", async () => {
    let finish: (value: object) => void = () => assert.fail("Missing read");
    let channelId = "first";
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": { get: () => new Promise(resolve => { finish = resolve; }) }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "me" }) },
            SelectedChannelStore: { getVoiceChannelId: () => channelId },
            VoiceStateStore: { getVoiceStatesForChannel: () => ({ friend: { userId: "friend" } }) }
        }
    }, { setInterval: () => 1, clearInterval() {} }, "({ plugin: exports.default, sessionStarts, totalsByUser })");
    const starting = api.plugin.start();
    api.plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "me", channelId }] });
    assert.equal(api.sessionStarts.size, 0);
    channelId = "latest";
    finish({ friend: 40 });
    await starting;
    assert.equal(api.sessionStarts.has("friend"), true);
    assert.equal(api.totalsByUser.get("friend"), 40);
    api.plugin.stop();
});

test("voice statistics discard stored totals from a stopped generation", async () => {
    const reads: ((value: object) => void)[] = [];
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": { get: () => new Promise(resolve => reads.push(resolve)) }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": { UserStore: { getCurrentUser: () => undefined } }
    }, {}, "({ plugin: exports.default, totalsByUser })");
    const first = api.plugin.start();
    api.plugin.stop();
    const second = api.plugin.start();
    reads[1]({ friend: 20 });
    await second;
    reads[0]({ friend: 10, stale: 99 });
    await first;
    assert.equal(api.totalsByUser.get("friend"), 20);
    assert.equal(api.totalsByUser.has("stale"), false);
    api.plugin.stop();
});

test("voice statistics keep sessions intact when tracking the same channel twice", () => {
    let now = 1000;
    let saves = 0;
    const api = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": { set: async () => { saves++; } }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": { VoiceStateStore: { getVoiceStatesForChannel: () => ({ friend: { userId: "friend" } }) } }
    }, { Date: { now: () => now }, setInterval: () => 1, clearInterval() {} }, "({ startTrackingChannel, stopTrackingChannel, sessionStarts, getLiveSeconds })");
    api.startTrackingChannel("voice", "me");
    now = 2600;
    api.startTrackingChannel("voice", "me");
    assert.equal(api.sessionStarts.get("friend"), 1000);
    assert.equal(saves, 0);
    now = 3100;
    assert.equal(api.getLiveSeconds("friend"), 2);
    api.stopTrackingChannel();
});

test("voice statistics retain fractional seconds across periodic saves", () => {
    let now = 1000;
    const { sessionStarts, totalsByUser, flushActiveSessions, getLiveSeconds } = loadSource("src/equicordplugins/voiceStats/index.tsx", {
        "@utils/Logger": { Logger: class { error() {} } },
        "@api/DataStore": {}, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => ({}) },
        "@webpack/common": {},
    }, { Date: { now: () => now } }, "({ sessionStarts, totalsByUser, flushActiveSessions, getLiveSeconds })");
    sessionStarts.set("friend", now);
    for (now of [31_400, 61_800, 92_200]) flushActiveSessions();
    assert.equal(totalsByUser.get("friend"), 91);
    assert.equal(sessionStarts.get("friend"), 92_000);
    now = 93_000;
    assert.equal(getLiveSeconds("friend"), 92);
});

test("transcription worker cancellation aborts model downloads and startup failures settle", async () => {
    let instance: { onmessage?: (event: object) => Promise<void>; onerror?: () => void; } = {};
    let signal: AbortSignal | undefined;
    let writes = 0;
    let terminations = 0;
    let revocations = 0;
    const errors: Error[] = [];
    const { TranscriptionWorker } = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/utils.ts", {
        "@api/index": { DataStore: { get: async () => undefined, set: async () => { writes++; } } },
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": { lodash: { isArrayBuffer: () => false } },
    }, {
        Blob, AbortController,
        URL: class extends URL {
            static createObjectURL() { return "blob:worker"; }
            static revokeObjectURL() { revocations++; }
        },
        Worker: class {
            constructor() { instance = this; }
            onmessage?: (event: object) => Promise<void>;
            onerror?: () => void;
            terminate() { terminations++; }
            postMessage() {}
        },
        fetch: async (_url: string, options: RequestInit) => {
            signal = options.signal ?? undefined;
            return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
        },
    });
    const worker = new TranscriptionWorker(() => {}, () => {}, (error: Error) => errors.push(error), () => {});
    const pending = instance.onmessage?.({ data: { type: "fetch_request", id: "model", url: "https://huggingface.co/model" } });
    await setImmediate();
    assert.equal(signal?.aborted, false);
    worker.terminate();
    await pending;
    assert.equal(signal?.aborted, true);
    assert.equal(writes, 0);
    assert.equal(errors.length, 0);
    worker.terminate();
    assert.equal(terminations, 1);
    assert.equal(revocations, 1);
    new TranscriptionWorker(() => {}, () => {}, (error: Error) => errors.push(error), () => {});
    instance.onerror?.();
    instance.onerror?.();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /worker failed/);
    assert.equal(terminations, 2);
    assert.equal(revocations, 2);
});

test("voice transcription downloads reject untrusted URLs and bound streamed audio", async () => {
    const validation = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/audioValidation.ts", {});
    const audio = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]);
    let calls = 0;
    let cancelled = 0;
    let released = 0;
    let chunks = [audio];
    let length: string | null = null;
    let ok = true;
    let failure = false;
    const { fetchAudio } = loadSource("src/equicordplugins/voiceMessageTranscriber.desktop/native.ts", {
        "./audioValidation": validation,
    }, {
        URL, Buffer, AbortSignal,
        fetch: async (_url: URL, options: RequestInit) => {
            calls++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            if (failure) throw new Error("secret signed URL or local path");
            return {
                ok, headers: { get: () => length },
                body: {
                    cancel: async () => { cancelled++; },
                    getReader: () => ({
                        read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
                        cancel: async () => { cancelled++; },
                        releaseLock: () => { released++; },
                    }),
                },
            };
        },
    });
    for (const url of [null, 123, "bad", "https://evil.test/a", "http://cdn.discordapp.com/a", "https://user@cdn.discordapp.com/a", "https://cdn.discordapp.com:444/a", "https://cdn.discordapp.com/" + "x".repeat(8192)])
        await assert.rejects(fetchAudio({}, url), /Blocked an untrusted/);
    assert.equal(calls, 0);
    const url = "https://cdn.discordapp.com/attachments/a.ogg";
    assert.deepEqual(Buffer.from(await fetchAudio({}, url)), Buffer.from(audio));
    assert.equal(released, 1);
    chunks = [new Uint8Array(25 * 1024 * 1024), audio];
    await assert.rejects(fetchAudio({}, url), /under 25 MB/);
    assert.equal(cancelled, 1);
    assert.equal(released, 2);
    length = String(25 * 1024 * 1024 + 1);
    await assert.rejects(fetchAudio({}, url), /under 25 MB/);
    assert.equal(cancelled, 2);
    length = null;
    ok = false;
    await assert.rejects(fetchAudio({}, url), /Could not download/);
    assert.equal(cancelled, 3);
    ok = true;
    chunks = [new TextEncoder().encode("<html>no audio</html>")];
    await assert.rejects(fetchAudio({}, url), /Could not download/);
    failure = true;
    await assert.rejects(fetchAudio({}, url), (error: Error) => {
        assert.equal(error.message.includes("secret"), false);
        return true;
    });
});

test("voice activity lookups cannot log into a stopped or different session", async () => {
    for (const change of ["none", "stop", "account", "channel"]) {
        let account = "first";
        let channel = "voice";
        let lookups = 0;
        const entries: object[] = [];
        let finish: (value: { name: string; }) => void = () => {};
        const actions = { get fetchApplication() {
            lookups++;
            return () => new Promise(resolve => { finish = resolve; });
        } };
        const { default: plugin } = loadSource("src/equicordplugins/voiceChannelLog/index.tsx", {
            "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
            "@vencord/discord-types/enums": { ChannelType: {} },
            "@webpack": { findByPropsLazy: () => actions },
            "@webpack/common": { ApplicationStore: { getApplication: () => undefined }, UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getVoiceChannelId: () => channel } },
            "./components/LogsButton": {}, "./components/VoiceChannelLogModal": {},
            "./logs": { addLogEntry: (entry: object) => entries.push(entry), setCallStartTime() {} },
            "./settings": { __esModule: true, default: { store: { logActivity: true } } },
        });
        assert.equal(lookups, 0);
        plugin.flux.EMBEDDED_ACTIVITY_UPDATE_V2({ applicationId: "app", location: { channel_id: "voice" }, participants: [{ user_id: "participant" }] });
        assert.equal(lookups, 1);
        if (change === "stop") plugin.stop();
        if (change === "account") account = "second";
        if (change === "channel") channel = "other";
        finish({ name: "Activity" });
        await setImmediate();
        assert.equal(entries.length, change === "none" ? 1 : 0);
    }
});

test("voice panel selectors read current media settings and device lists", () => {
    let volume = 20;
    let selected = "first";
    const devices: Record<string, { id: string; name: string; }> = { first: { id: "first", name: "First" } };
    const media = { getOutputVolume: () => volume, getOutputDeviceId: () => selected, getOutputDevices: () => devices };
    const hooks: Array<() => unknown> = [];
    const { OutputVolumeComponent, OutputDeviceComponent } = loadSource("src/equicordplugins/vcPanelSettings/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/BaseText": {}, "@components/Heading": {}, "@components/Link": {},
        "@utils/constants": { Devs: {} }, "@utils/misc": { identity: (value: unknown) => value },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            MediaEngineStore: media, lodash: { isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) },
            useStateFromStores: (stores: object[], selector: () => unknown) => {
                assert.equal(stores[0], media);
                hooks.push(selector);
                return selector();
            },
        },
    }, { React: { createElement: () => null, Fragment: "fragment" } }, "({ OutputVolumeComponent, OutputDeviceComponent })");
    assert.equal(hooks.length, 0);
    OutputVolumeComponent();
    OutputDeviceComponent();
    volume = 70;
    selected = "second";
    devices.second = { id: "second", name: "Second" };
    assert.equal(hooks[0](), 70);
    assert.equal(hooks[1](), "second");
    assert.equal(JSON.stringify(hooks[2]()), JSON.stringify(Object.values(devices)));
});

test("voice buttons apply server actions to the selected user", () => {
    const settings = { useServer: true, serverSelf: false };
    const calls: string[] = [];
    const react = { createElement: (_type: unknown, props: object) => ({ props }) };
    const source = loadSource("src/equicordplugins/voiceButtons/utils.tsx", {
        "./settings": { settings: { store: settings } },
        "@webpack": { findComponentByCodeLazy: () => null, findStoreLazy: () => ({ isLocalSoundboardMuted: () => false }) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice", mute: false, deaf: false }) },
            PermissionsBits: {}, PermissionStore: { can: () => true },
            MediaEngineStore: { isSelfMute: () => false, isSelfDeaf: () => false, isLocalMute: () => false, isLocalVideoDisabled: () => false },
            GuildActions: { setServerMute: (_guild: string, id: string) => calls.push(`serverMute:${id}`), setServerDeaf: (_guild: string, id: string) => calls.push(`serverDeaf:${id}`) },
            VoiceActions: { toggleSelfMute: () => calls.push("selfMute"), toggleSelfDeaf: () => calls.push("selfDeaf"), toggleLocalMute: (id: string) => calls.push(`localMute:${id}`) },
        },
    }, { React: react });
    for (const id of ["other", "self"]) {
        source.UserMuteButton({ user: { id } }).props.onClick();
        source.UserDeafenButton({ user: { id } }).props.onClick();
    }
    assert.deepEqual(calls, ["serverMute:other", "serverDeaf:other", "selfMute", "selfDeaf"]);
    settings.serverSelf = true;
    source.UserMuteButton({ user: { id: "self" } }).props.onClick();
    source.UserDeafenButton({ user: { id: "self" } }).props.onClick();
    assert.deepEqual(calls.slice(-2), ["serverMute:self", "serverDeaf:self"]);
    settings.useServer = false;
    source.UserMuteButton({ user: { id: "other" } }).props.onClick();
    assert.equal(calls.at(-1), "localMute:other");
});

test("installer builds settle subprocess failures without exposing process details", async () => {
    let finish: (error: Error | null) => void = () => {};
    const mocks: Record<string, object> = {
        "child_process": { exec: (command: string, options: { cwd: string; }, callback: (error: Error | null) => void) => {
            assert.equal(command, "pnpm build --dev");
            assert.equal(options.cwd, path.resolve("fixture"));
            finish = callback;
        } },
        "electron": {}, "fs": {}, "fs/promises": {}, path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const { build } = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), process: { env: {} } }, "({ build })");
    for (const error of [new Error("Missing shell at private path"), new Error("Build exited with private output")]) {
        const pending = build();
        finish(error);
        await assert.rejects(pending, { message: "Could not build LawyerCord. Try building from the terminal." });
    }
    const pending = build();
    finish(null);
    assert.equal(await pending, undefined);
});

test("installer uninstall settles missing, cancelled, failed and successful requests", async () => {
    let confirmation = 0;
    let removals = 0;
    let failRemoval = false;
    let builds = 0;
    const root = path.resolve("fixture/src/userplugins");
    const mocks: Record<string, object> = {
        "child_process": {},
        "electron": { dialog: { showMessageBox: async () => ({ response: confirmation }) } },
        "fs": { realpathSync: (value: string) => path.resolve(value) },
        "fs/promises": { rm: async (directory: string) => {
            assert.equal(directory, path.join(root, "plugin"));
            if (failRemoval) throw new Error("Removal failed");
            removals++;
        } },
        path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const native = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, {
        __dirname: path.resolve("fixture/dist"), onBuild: async () => { builds++; },
    }, "({ ...exports, configure: plugins => { getUserplugins = async () => plugins; build = onBuild; } })");
    native.configure([]);
    await assert.rejects(native.rmPlugin(null, "plugin"), { message: "Plugin not found." });
    native.configure([{ name: "Example", directory: "plugin" }]);
    assert.equal(await native.rmPlugin(null, "plugin"), false);
    assert.equal(removals, 0);
    confirmation = 1;
    failRemoval = true;
    await assert.rejects(native.rmPlugin(null, "plugin"), { message: "Could not uninstall the plugin." });
    assert.equal(builds, 0);
    failRemoval = false;
    assert.equal(await native.rmPlugin(null, "plugin"), true);
    assert.equal(removals, 1);
    assert.equal(builds, 1);
});

test("installer update commands reject traversal and directories linked outside the plugin root", async t => {
    const prefix = path.join(tmpdir(), "lawyercord-installer-");
    const temporary = mkdtempSync(prefix);
    t.after(() => {
        assert.ok(temporary.startsWith(prefix));
        rmSync(temporary, { recursive: true, force: true });
    });
    const root = path.join(temporary, "src/userplugins");
    mkdirSync(path.join(root, "valid"), { recursive: true });
    const outside = path.join(temporary, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    let commands = 0;
    const mocks: Record<string, object> = {
        "child_process": { exec: () => { commands++; throw new Error("Unexpected command"); } },
        "electron": {}, "fs": { realpathSync }, "fs/promises": {}, path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const native = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.join(temporary, "dist") }, "({ ...exports, getPluginDirectory })");
    assert.equal(native.getPluginDirectory("valid"), realpathSync(path.join(root, "valid")));
    for (const name of ["../outside", "..", ".", outside, "linked", "missing", "", null, 1]) {
        if (name === "missing") assert.equal(await native.isUpdateAvailableForPlugin(null, name), false);
        else await assert.rejects(native.isUpdateAvailableForPlugin(null, name), { message: "Invalid plugin directory." });
        await assert.rejects(native.updatePlugin(null, name), { message: "Invalid plugin directory." });
    }
    assert.equal(commands, 0);
});

test("installer update reviews render repository metadata as text", () => {
    const mocks: Record<string, object> = {
        "@main/settings": {}, "child_process": {}, "electron": {}, "fs": {}, "fs/promises": {},
        path,
        "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: readFileSync(`src/equicordplugins/userpluginInstaller.dev/misc/${name}.txt`, "utf8") };
    const { formatCommitMessages, generateUpdatePluginContent } = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: "/fixture/dist", Buffer }, "({ formatCommitMessages, generateUpdatePluginContent })");
    const commit = formatCommitMessages('<script>document.title="install"</script>////////1234567////////123456789////////<img src=x onerror=alert(1)> & text', "https://github.com/example/plugin");
    const url = generateUpdatePluginContent({ name: "Example", description: "Description", remote: "https://github.com/example/plugin", commit });
    const html = Buffer.from(url.split(",")[1], "base64").toString("utf8");
    assert.equal(html.includes('<script>document.title="install"</script>'), false);
    assert.equal(html.includes("<img src=x"), false);
    assert.ok(html.includes("&lt;img src=x"));
    assert.ok(html.includes("&amp; text"));
    assert.ok(html.includes('href="https://github.com/example/plugin/commit/123456789"'));
});

test("installer review templates keep placeholder text in metadata literal", () => {
    const mocks: Record<string, object> = { child_process: {}, electron: {}, fs: {}, "fs/promises": {}, path, "yaml-js": {} };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: readFileSync(`src/equicordplugins/userpluginInstaller.dev/misc/${name}.txt`, "utf8") };
    const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: "/fixture/dist", Buffer }, "({ generateReviewPluginContent, generateUpdatePluginContent })");
    const name = "%PLUGINDESC% %REMOTE% %COMMITMESSAGE%";
    const description = "%REMOTE% %COMMITMESSAGE% & <text>";
    for (const url of [
        api.generateReviewPluginContent({ name, description, usesNative: true, usesPreSend: true }),
        api.generateUpdatePluginContent({ name, description, remote: "https://github.com/example/plugin", commit: "A real commit" })
    ]) {
        const html = Buffer.from(url.split(",")[1], "base64").toString("utf8");
        assert.ok(html.includes(`<h3>${name}</h3>`));
        assert.ok(html.includes("<p>%REMOTE% %COMMITMESSAGE% &amp; &lt;text></p>"));
    }
});

test("installer subscriptions keep unique identities and allow self-removal", () => {
    const { VariableWithCallbacks } = loadSource("src/equicordplugins/userpluginInstaller.dev/VariableWithCallbacks.ts", {}, { Date: { now: () => 1 } });
    const value = new VariableWithCallbacks(0);
    const calls: number[] = [];
    const first = value.registerCallback((current: number, id: number) => {
        calls.push(current);
        value.deregisterCallback(id);
    });
    const second = value.registerCallback((current: number) => calls.push(current * 10));
    assert.notEqual(first, second);
    value.value(1);
    assert.deepEqual(calls, [1, 10]);
    value.value(2);
    assert.deepEqual(calls, [1, 10, 20]);
    value.deregisterCallback(second);
    value.value(3);
    assert.deepEqual(calls, [1, 10, 20]);
});

test("toast shutdown settles pending notifications and releases its root", async () => {
    let unmounts = 0;
    let removals = 0;
    let roots = 0;
    const notifications = loadSource("src/equicordplugins/toastNotifications/components/Notifications.tsx", {
        "@equicordplugins/toastNotifications/index": { settings: { store: { maxNotifications: 3 } } },
        "@webpack/common": { createRoot: () => {
            roots++;
            return { render() {}, unmount() { unmounts++; } };
        } },
        "./NotificationComponent": { __esModule: true, default: "notification" },
    }, {
        React: { createElement: () => ({}), Fragment: "fragment" },
        document: { createElement: () => ({ remove() { removals++; } }), body: { append() {} } },
    });
    let settled = 0;
    const pending = [1, 2].map(id => notifications.showNotification({ title: String(id), body: "", permanent: true }).then(() => { settled++; }));
    notifications.teardownNotifications();
    await setImmediate();
    assert.equal(settled, 2);
    await Promise.all(pending);
    assert.equal(unmounts, 1);
    assert.equal(removals, 1);
    const next = notifications.showNotification({ title: "Next", body: "" });
    assert.equal(roots, 2);
    notifications.teardownNotifications();
    await next;
    assert.equal(unmounts, 2);
    const { default: plugin } = loadSource("src/equicordplugins/toastNotifications/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/Button": {}, "@utils/constants": { EquicordDevs: {} },
        "@vencord/discord-types/enums": { UserNotificationSetting: { ALL_MESSAGES: 0, ONLY_MENTIONS: 1, NO_MESSAGES: 2 } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({}), findStoreLazy: () => ({}) }, "@webpack/common": {},
        "./components/Notifications": notifications
    });
    for (const event of ["LOGOUT", "CONNECTION_OPEN"]) {
        const pending = notifications.showNotification({ title: "Previous session", body: "", permanent: true });
        assert.equal(typeof plugin.flux[event], "function", event);
        plugin.flux[event]();
        await pending;
        assert.equal(unmounts, roots);
        assert.equal(removals, roots);
    }
});

test("guild toasts use Discord's resolved notification level", () => {
    let level = 0;
    const channel = { id: "channel", guild_id: "guild" };
    const api = loadSource("src/equicordplugins/toastNotifications/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { friendServerNotifications: false } }) },
        "@components/Button": {}, "@utils/constants": { EquicordDevs: {} },
        "@vencord/discord-types/enums": { UserNotificationSetting: { ALL_MESSAGES: 0, ONLY_MENTIONS: 1, NO_MESSAGES: 2 } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({ isGuildOrCategoryOrChannelMuted: () => false }) },
        "@webpack/common": { UserGuildSettingsStore: {
            getAllSettings: () => assert.fail("Do not reinterpret Discord settings"),
            resolvedMessageNotifications: (value: unknown) => { assert.equal(value, channel); return level; }
        } },
        "./components/Notifications": {}
    }, {}, "({ shouldNotifyForGuildMessage })");
    for (level of [0, 1, 2]) for (const message of [
        { content: "Hello", mentions: [] },
        { content: "`<@current>`", mentions: [] },
        { content: "Reply without a literal mention", mentions: [{ id: "current" }] },
        { content: "<@!current>", mentions: [{ id: "current" }] },
        { content: "Hello", mentions: [{ id: "someone-else" }] }
    ]) {
        assert.equal(api.shouldNotifyForGuildMessage(message, channel, "current", "author"), level === 0 || level === 1 && message.mentions.some(user => user.id === "current"));
    }
});

test("toast arrivals enforce a lowered limit and settle every evicted notification", async () => {
    const store = { maxNotifications: 5 };
    let visible: string[] = [];
    const notifications = loadSource("src/equicordplugins/toastNotifications/components/Notifications.tsx", {
        "@equicordplugins/toastNotifications/index": { settings: { store } },
        "@webpack/common": { createRoot: () => ({ render(tree: { children: { title: string; }[][]; }) { visible = tree.children[0].map(item => item.title); }, unmount() {} }) },
        "./NotificationComponent": { __esModule: true, default: "notification" }
    }, {
        React: { Fragment: "fragment", createElement: (tag: string, props: object, ...children: unknown[]) => tag === "notification" ? props : { children } },
        document: { createElement: () => ({ remove() {} }), body: { append() {} } }
    });
    const settled: number[] = [];
    const pending = [1, 2, 3, 4, 5].map(id => notifications.showNotification({ title: String(id), body: "", permanent: true }).then(() => settled.push(id)));
    store.maxNotifications = 2;
    pending.push(notifications.showNotification({ title: "6", body: "", permanent: true }).then(() => settled.push(6)));
    await setImmediate();
    assert.deepEqual(Array.from(visible), ["5", "6"]);
    assert.deepEqual(settled, [1, 2, 3, 4]);
    notifications.teardownNotifications();
    await Promise.all(pending);
    assert.equal(settled.length, 6);
});

test("URL highlighting clears compiled matches when the last pattern is removed", () => {
    const store = { patterns: [{ pattern: "example.com", color: "#123456" }], boldUrls: false, highlightEmbeds: true };
    const { plugin, updatePatterns } = loadSource("src/equicordplugins/urlHighlighter/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/Button": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Heading": {},
        "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => null },
        "@webpack/common": {},
    }, {}, "({ plugin: exports.default, updatePatterns })");
    const props = { href: "https://example.com" };
    assert.equal(plugin.getProps(props).style["--vc-url-hl-color"], "#123456");
    updatePatterns([]);
    assert.equal(Object.keys(plugin.getProps(props)).length, 0);
    updatePatterns([{ pattern: "example.com", color: "#654321" }]);
    assert.equal(plugin.getProps(props).style["--vc-url-hl-color"], "#654321");
});

test("UniversalMention reads current users and DM membership on each lookup", () => {
    const settings = { onlyDMUsers: false };
    let users: Record<string, { id: string; }> = { first: { id: "first" } };
    const dms = new Set<string>();
    const { default: plugin } = loadSource("src/equicordplugins/universalMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@components/Notice": { Notice: {} },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            UserStore: { getUsers: () => users },
            ChannelStore: { getDMFromUserId: (id: string) => dms.has(id) },
        },
    });
    assert.deepEqual(Array.from(plugin.useFilter(), (user: { id: string; }) => user.id), ["first"]);
    users = { second: { id: "second" } };
    assert.deepEqual(Array.from(plugin.useFilter(), (user: { id: string; }) => user.id), ["second"]);
    settings.onlyDMUsers = true;
    assert.equal(plugin.useFilter().length, 0);
    dms.add("second");
    assert.equal(plugin.useFilter(true)[0].userId, "second");
    users = {};
    assert.equal(plugin.useFilter().length, 0);
});

test("tone indicators preserve empty descriptions and resolve aliases without prototype properties", () => {
    const settings = { prefix: "/", customIndicators: "empty=; _constructor=Constructor alias" };
    const { default: plugin } = loadSource("src/equicordplugins/toneIndicators/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/text": loadSource("src/utils/text.ts", {}),
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React: { createElement: (type: unknown, props: object) => ({ type, props }) } },
        "./indicators": loadSource("src/equicordplugins/toneIndicators/indicators.ts", {}),
        "./ToneIndicator": { __esModule: true, default: "indicator" },
    });
    const empty = plugin.patchToneIndicators("keep /empty intact");
    assert.equal(Array.from(empty).join(""), "keep /empty intact");
    const alias = plugin.patchToneIndicators("/constructor");
    assert.equal(alias.props.desc, "Constructor alias");
    assert.equal(plugin.patchToneIndicators("/srs").props.desc, "Serious");
    settings.prefix = "+";
    assert.equal(plugin.patchToneIndicators("+srs").props.desc, "Serious");
});

test("RandomVoice discards join actions and screen sources after cancellation", async () => {
    let account = "first";
    let channelId = "channel";
    let tick: () => void = () => {};
    let cleared = 0;
    let actions = 0;
    let streams = 0;
    const pending: Array<(sources: object[]) => void> = [];
    const { plugin, runAfterVoiceJoin, startChannelStream, cancelPendingJoin } = loadSource("src/equicordplugins/randomVoice/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@api/UserArea": {}, "@components/Button": {}, "@components/Switch": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@shared/debounce": {}, "@utils/constants": { Devs: {}, EquicordDevs: {}, IS_MAC: false },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack": { findByCodeLazy: (code: string) => code.includes("STREAM_START")
            ? () => streams++ : () => new Promise(resolve => pending.push(resolve)) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId }) },
            SelectedChannelStore: { getVoiceChannelId: () => channelId },
            PermissionStore: { can: () => true }, PermissionsBits: {},
            MediaEngineStore: { getMediaEngine: () => ({}) },
        },
    }, {
        window: { removeEventListener() {} },
        setInterval: (callback: () => void) => { tick = callback; return 1; },
        clearInterval: () => cleared++,
    }, "({ plugin: exports.default, runAfterVoiceJoin, startChannelStream, cancelPendingJoin })");
    runAfterVoiceJoin("channel", [() => actions++]);
    plugin.stop();
    assert.equal(cleared, 1);
    tick();
    assert.equal(actions, 0, "a queued timer cannot run actions after stop");
    const channel = { id: "channel", guild_id: "guild", type: 2, isGuildStageVoice: () => false };
    const stopped = startChannelStream(channel);
    plugin.stop();
    pending[0]([{ id: "screen", name: "screen" }]);
    await stopped;
    assert.equal(streams, 0);
    const switched = startChannelStream(channel);
    channelId = "other";
    pending[1]([{ id: "screen", name: "screen" }]);
    await switched;
    assert.equal(streams, 0);
    channelId = "channel";
    const replaced = startChannelStream(channel);
    cancelPendingJoin();
    pending[2]([{ id: "screen", name: "screen" }]);
    await replaced;
    assert.equal(streams, 0);
    const differentAccount = startChannelStream(channel);
    account = "second";
    pending[3]([{ id: "screen", name: "screen" }]);
    await differentAccount;
    assert.equal(streams, 0);
    const valid = startChannelStream(channel);
    pending[4]([{ id: "screen", name: "screen" }]);
    await valid;
    assert.equal(streams, 1);
});

test("timezone dialog stays open when the database rejects a save", async () => {
    let succeeds = false;
    let closed = 0;
    const saved: string[] = [];
    const { SetTimezoneModal } = loadSource("src/equicordplugins/timezones/TimezoneModal.tsx", {
        "@api/DataStore": {}, "@components/Heading": {}, "@utils/margins": { Margins: {} },
        "@webpack/common": { Modal: "modal", useState: () => ["UTC", () => {}], useEffect() {}, useMemo: () => [] },
        ".": { settings: { store: {} } },
        "./database": {
            setTimezone: async () => succeeds,
            setUserDatabaseTimezone: async (_userId: string, value: string) => saved.push(value),
        },
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } });
    const modal = SetTimezoneModal({ userId: "user", database: true, modalProps: { onClose: () => closed++ } });
    await modal.props.actions[0].onClick();
    assert.equal(closed, 0);
    assert.equal(saved.length, 0);
    succeeds = true;
    await modal.props.actions[0].onClick();
    assert.equal(closed, 1);
    assert.deepEqual(saved, ["UTC"]);
});

test("video shortcut reads live settings and waits until invocation to access the media store", () => {
    let ready = false;
    let enabled = false;
    let listener: ((event: object) => void) | undefined;
    const settings = { keyBind: "KeyX", reqCtrl: true, reqShift: true, reqAlt: false };
    const dispatched: boolean[] = [];
    const common = {
        get MediaEngineStore() {
            assert.equal(ready, true, "store access must be deferred");
            return { isVideoEnabled: () => enabled };
        },
        FluxDispatcher: { dispatch: (event: { enabled: boolean; }) => dispatched.push(event.enabled) },
    };
    const { default: plugin } = loadSource("src/equicordplugins/toggleVideoBind/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ plain: settings }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": common,
    }, { document: {
        addEventListener: (_type: string, callback: typeof listener) => { listener = callback; },
        removeEventListener: (_type: string, callback: typeof listener) => { assert.equal(callback, listener); listener = undefined; },
    } });
    ready = true;
    plugin.start();
    const event = { code: "KeyX", ctrlKey: true, shiftKey: true, altKey: false, repeat: false };
    listener?.(event);
    assert.deepEqual(dispatched, [true]);
    enabled = true;
    settings.keyBind = "KeyY";
    listener?.(event);
    listener?.({ ...event, code: "KeyY", repeat: true });
    listener?.({ ...event, code: "KeyY", altKey: true });
    assert.equal(dispatched.length, 1);
    listener?.({ ...event, code: "KeyY" });
    assert.deepEqual(dispatched, [true, false]);
    plugin.stop();
    assert.equal(listener, undefined);
});

test("failed theme downloads preserve the installed stylesheet", async () => {
    let contents = ".existing { color: red; }";
    let status = 503;
    const { downloadTheme } = loadSource("src/equicordplugins/themeLibrary/native.ts", {
        "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => file },
        "@main/utils/constants": { THEMES_DIR: "themes" }, path,
        fs: { mkdtempSync: () => "temporary", renameSync() {}, rmSync() {}, rmdirSync() {}, writeFileSync: (_file: string, content: string) => { contents = content; } },
    }, { Buffer, AbortSignal, fetch: async () => new Response(status === 200 ? ".new { color: blue; }" : "Service unavailable", { status }) });
    const theme = { name: "existing", id: "123", content: "metadata" };
    await assert.rejects(downloadTheme(null, theme), /download/i);
    assert.equal(contents, ".existing { color: red; }");
    status = 200;
    await downloadTheme(null, theme);
    assert.equal(contents, ".new { color: blue; }");
});

test("theme library requests preserve authentication in Headers objects", async () => {
    const { themeRequest } = loadSource("src/equicordplugins/themeLibrary/components/ThemeTab.tsx", {
        "@api/DataStore": {}, "@api/Settings": {}, "@components/ErrorCard": {},
        "@components/Heading": {}, "@components/Icons": {}, "@components/Paragraph": {},
        "@components/settings": { wrapTab: (component: unknown) => component },
        "@equicordplugins/themeLibrary/types": { SearchStatus: {} },
        "@utils/Logger": { Logger: class {} }, "@utils/margins": {}, "@utils/misc": {},
        "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": {}, "./ThemeCard": {},
    }, {
        fetch: async (_url: string, options: RequestInit) => {
            const headers = new Headers(options.headers);
            assert.equal(headers.get("Authorization"), "Bearer test-token");
            assert.equal(headers.get("Accept"), "application/json");
            return new Response("{}");
        },
    });
    await themeRequest("/likes/get", { headers: new Headers({ Authorization: "Bearer test-token", Accept: "application/json" }) });
});

test("Song Spotlight validation does not trust a failed render cached as valid", async () => {
    const handlers = await import("@song-spotlight/api/handlers");
    const util = await import("@song-spotlight/api/util");
    let requests = 0;
    let exists = false;
    const native = loadSource("src/equicordplugins/songSpotlight.desktop/native.ts", {
        "@song-spotlight/api/handlers": handlers,
        "@song-spotlight/api/util": util,
        electron: { net: { fetch: async () => {
            requests++;
            return new Response(JSON.stringify(exists ? { id: 123 } : {}));
        } } },
    });
    try {
        handlers.clearCache();
        const song = { service: "soundcloud", type: "track", id: "123" };
        assert.equal(await native.renderSong(null, song), null);
        assert.equal(await native.validateSong(null, song), false);
        assert.equal(requests, 2, "validation checks the service after a failed render");
        exists = true;
        assert.equal(await native.validateSong(null, song), true);
        assert.equal(requests, 3, "an earlier missing result does not permanently reject the song");
    } finally {
        handlers.clearCache();
        util.setFetchHandler(fetch);
    }
});

test("Song Spotlight album playback advances in numeric track order", () => {
    let next: number | undefined;
    const { default: AudioPlayer } = loadSource("src/equicordplugins/songSpotlight.desktop/ui/components/AudioPlayer.tsx", {
        "@equicordplugins/songSpotlight.desktop/lib/utils": {},
        "@equicordplugins/songSpotlight.desktop/settings": {},
        "@webpack/common": {
            useMemo: (factory: () => unknown) => factory(),
            useRef: (current: unknown) => ({ current }),
            useCallback: (callback: unknown) => callback,
            useEffect() {},
        },
    }, { React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) } });
    const tree = AudioPlayer({
        audioRef: { current: undefined }, playing: 1,
        list: Array.from({ length: 12 }, (_, index) => ({ audio: { previewUrl: String(index) } })),
        setPlaying: (index: number | undefined) => { next = index; }, setLoadedAudio() {},
    });
    const item = tree.children[0][0].props;
    for (const index of [11, 10, 2, 1]) item.handleLoaded(index, true);
    item.handleStopped(1, true);
    assert.equal(next, 2);
    item.handleStopped(2, true);
    assert.equal(next, 10);
    item.handleStopped(10, true);
    assert.equal(next, 11);
    item.handleStopped(11, true);
    assert.equal(next, undefined);
});

test("Song Spotlight metadata ignores replaced songs and unmounted requests", async () => {
    let state: unknown;
    let deps: unknown[] = [];
    let effect: (() => (() => void)) | undefined;
    let cleanup: (() => void) | undefined;
    let updates = 0;
    const common = {
        useState: (initial: unknown) => {
            state ??= initial;
            return [state, (next: unknown) => { state = next; updates++; }];
        },
        useEffect: (next: () => () => void, nextDeps: unknown[]) => {
            if (nextDeps.some((value, index) => value !== deps[index])) {
                deps = nextDeps;
                effect = next;
            }
        },
    };
    const commit = () => {
        if (!effect) return;
        cleanup?.();
        cleanup = effect();
        effect = undefined;
    };
    const requests: Array<{ resolve(value: object): void; reject(error: Error): void; }> = [];
    const { useAwaiter } = loadSource("src/utils/react.tsx", {
        "@webpack/common": common, "./misc": {}, "./lazyReact": {},
    });
    const { useRender } = loadSource("src/equicordplugins/songSpotlight.desktop/service.ts", {
        "@song-spotlight/api/util": { sid: (song: { id: string; }) => song.id },
        "@utils/react": { useAwaiter },
    }, { VencordNative: { pluginHelpers: { SongSpotlight: {
        renderSong: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    } } } });
    useRender({ id: "first" });
    commit();
    useRender({ id: "second" });
    commit();
    requests[1].resolve({ label: "second" });
    await setImmediate();
    assert.equal(useRender({ id: "second" }).render.label, "second");
    requests[0].resolve({ label: "first" });
    await setImmediate();
    assert.equal(useRender({ id: "second" }).render.label, "second");
    assert.equal(useRender({ id: "third" }).render, null, "old metadata disappears before the new effect runs");
    commit();
    requests[2].reject(new Error("missing"));
    await setImmediate();
    assert.equal(useRender({ id: "third" }).failed, true);
    assert.equal(useRender({ id: "fourth" }).failed, false);
    commit();
    cleanup?.();
    const previous = updates;
    requests[3].resolve({ label: "unmounted" });
    await setImmediate();
    assert.equal(updates, previous);
});

test("Song Spotlight keeps refreshes, logout and pending data bound to their account", async () => {
    let account = "first";
    const requests: Array<{ url: URL; options: RequestInit; resolve(response: Response): void; }> = [];
    const common = {
        UserStore: { getCurrentUser: () => ({ id: account }) },
        showToast() {}, Toasts: { Type: {} },
        zustandPersist: (definition: unknown) => definition,
        zustandCreate: (definition: (set: (next: object) => void, get: () => object) => object) => {
            let state = definition(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        },
    };
    const storeMocks = {
        "@webpack/common": common,
        "@utils/lazy": { proxyLazy: (factory: () => object) => factory() },
        "@api/index": { DataStore: {} },
    };
    const authModule = loadSource("src/equicordplugins/songSpotlight.desktop/lib/stores/AuthorizationStore.ts", storeMocks);
    const songModule = loadSource("src/equicordplugins/songSpotlight.desktop/lib/stores/SongStore.ts", storeMocks);
    const auth = authModule.useAuthorizationStore;
    const songs = songModule.useSongStore;
    auth.getState().setToken("first-access", "first-refresh", "first");
    auth.getState().setToken("second-access", "second-refresh", "second");
    const api = loadSource("src/equicordplugins/songSpotlight.desktop/lib/api.ts", {
        "@song-spotlight/api/structs": await import("@song-spotlight/api/structs"),
        "@webpack/common": common, "./stores/AuthorizationStore": authModule, "./stores/SongStore": songModule,
    }, {
        URL, Headers,
        fetch: (url: URL, options: RequestInit) => new Promise<Response>(resolve => requests.push({ url, options, resolve })),
    });
    const first = api.authFetch(new URL("api/data", api.apiConstants.api), { method: "PUT", body: "first songs" });
    const firstRejected = assert.rejects(first, /account changed/);
    requests[0].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    assert.equal(requests[1].options.body, "first-access");
    account = "second";
    const second = api.authFetch(new URL("api/data", api.apiConstants.api));
    requests[2].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    assert.equal(requests[3].options.body, "second-access", "accounts never share a refresh");
    requests[1].resolve(new Response("first-renewed"));
    await firstRejected;
    assert.equal(requests.length, 4, "an account switch must not retry the old PUT");
    assert.equal(auth.getState().getToken("first").access, "first-renewed");
    assert.equal(auth.getState().getToken("second").access, "second-access");
    requests[3].resolve(new Response("second-renewed"));
    await setImmediate();
    assert.equal(new Headers(requests[4].options.headers).get("Authorization"), "second-renewed");
    requests[4].resolve(new Response("[]"));
    await second;

    const pending = api.authFetch(new URL("api/data", api.apiConstants.api));
    const signedOut = assert.rejects(pending);
    requests[5].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    auth.getState().deleteTokens();
    requests[6].resolve(new Response("must-not-restore"));
    await signedOut;
    assert.equal(auth.getState().getToken("second"), undefined);
    assert.equal(auth.getState().getToken("first").access, "first-renewed");

    account = "first";
    songs.getState().update({ userId: "second", data: ["keep"] });
    const save = api.saveData(["first song"]);
    account = "second";
    requests[7].resolve(new Response("true"));
    await save;
    assert.deepEqual(Array.from(songs.getState().users.first.data), ["first song"]);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    account = "first";
    const read = api.getData();
    account = "second";
    requests[8].resolve(new Response('[{"service":"spotify","type":"track","id":"read-first"}]'));
    await read;
    assert.deepEqual(Array.from(songs.getState().users.first.data), [{ service: "spotify", type: "track", id: "read-first" }]);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    account = "first";
    const deletion = api.deleteData();
    auth.getState().setToken("new-login", "new-refresh", "first");
    auth.getState().setToken("keep-login", "keep-refresh", "second");
    account = "second";
    requests[9].resolve(new Response("true"));
    await deletion;
    assert.equal(songs.getState().users.first, undefined);
    assert.deepEqual(Array.from(songs.getState().users.second.data), ["keep"]);
    assert.equal(auth.getState().getToken("first").access, "new-login");
    assert.equal(auth.getState().getToken("second").access, "keep-login");
    account = "first";
    const refreshedDeletion = api.deleteData();
    requests[10].resolve(new Response("expired", { status: 401 }));
    await setImmediate();
    requests[11].resolve(new Response("new-login-refreshed"));
    await setImmediate();
    requests[12].resolve(new Response("true"));
    await refreshedDeletion;
    assert.equal(auth.getState().getToken("first"), undefined, "deletion signs out the same refresh session");
    assert.equal(auth.getState().getToken("second").access, "keep-login");
    await assert.rejects(api.authFetch("https://other.example/api/data"), /Invalid Song Spotlight URL/);
    assert.equal(requests.length, 13, "foreign URLs never receive credentials");
});

test("Song Spotlight OAuth accepts only its redirect and the initiating account", async () => {
    let account = "first";
    let token: object | undefined;
    let callback: (value: { location: string; }) => Promise<void> = async () => assert.fail("modal missing");
    const requests: Array<{ options: RequestInit; resolve(response: Response): void; }> = [];
    const writes: string[] = [];
    const redirectURL = "https://dc.songspotlight.nexpid.xyz/api/auth/authorize";
    const { presentOAuth2Modal } = loadSource("src/equicordplugins/songSpotlight.desktop/lib/oauth2.tsx", {
        "@vencord/discord-types/enums": { ApplicationIntegrationType: {} },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            OAuth2AuthorizeModal: "modal", openModal: (render: (props: object) => void) => render({}),
            showToast() {}, Toasts: { Type: {} },
        },
        "./api": { apiConstants: { oauth2: { redirectURL } }, getData: async () => {} },
        "./utils": { logger: { error() {} } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({
            getToken: () => token,
            setToken: (_access: string, _refresh: string, userId: string) => writes.push(userId),
        }) } },
    }, {
        URL,
        React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; } },
        fetch: (_url: URL, options: RequestInit) => new Promise<Response>(resolve => requests.push({ options, resolve })),
    });
    presentOAuth2Modal();
    await callback({ location: "https://other.example/api/auth/authorize?code=code" });
    await callback({ location: "https://dc.songspotlight.nexpid.xyz/other?code=code" });
    assert.equal(requests.length, 0);
    const first = callback({ location: `${redirectURL}?code=code` });
    assert.equal(requests[0].options.headers, undefined, "the code exchange does not send stored credentials");
    assert.equal(requests[0].options.redirect, "error");
    account = "second";
    requests[0].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await first;
    assert.equal(writes.length, 0);
    presentOAuth2Modal();
    const superseded = callback({ location: `${redirectURL}?code=code` });
    token = {};
    requests[1].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await superseded;
    assert.equal(writes.length, 0);
    presentOAuth2Modal();
    const valid = callback({ location: `${redirectURL}?code=code` });
    requests[2].resolve(new Response("access", { headers: { "X-Refresh-Token": "refresh" } }));
    await valid;
    assert.deepEqual(writes, ["second"]);
});

function loadComponent(path: string, hooks: Record<string, unknown> = {}, additionalMocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@webpack/common": { React, TextInput: "input", ...hooks },
        "@components/BaseText": { BaseText: "div" },
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "./Common": { SettingsSection: "section", resolveError: (result: boolean | string) => result === true ? null : result || "Invalid input provided" },
        "@utils/css": { classNameFactory: (prefix: string) => (...names: string[]) => names.map(name => prefix + name).join(" ") },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") },
        ...additionalMocks
    };
    return loadSource(path, mocks, { React, ...globals });
}

test("hidden channel member requests omit missing owners and duplicate IDs", () => {
    const requests: { userIds: string[]; }[] = [];
    let ownerId: string | undefined;
    const enums = {
        ...loadSource("packages/discord-types/enums/channel.ts", {}),
        ...loadSource("packages/discord-types/enums/voice.ts", {})
    };
    const { default: Screen } = loadSource("src/plugins/showHiddenChannels/components/HiddenChannelLockScreen.tsx", {
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@plugins/permissionsViewer": { __esModule: true, default: { name: "PermissionsViewer" } },
        "@plugins/permissionsViewer/components/RolesAndUsersPermissions": {},
        "@plugins/permissionsViewer/utils": {},
        "@utils/misc": { classes: () => "" },
        "@utils/text": {},
        "@vencord/discord-types/enums": enums,
        "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({}), findComponentByCodeLazy: () => null },
        "@webpack/common": {
            GuildStore: { getGuild: () => ownerId ? { ownerId } : undefined },
            GuildMemberStore: { getMember: () => null },
            FluxDispatcher: { dispatch: (request: { userIds: string[]; }) => requests.push(request) },
            PermissionStore: { can: () => false }, PermissionsBits: {},
            useState: () => [[], () => {}], useEffect: (effect: () => void) => effect()
        },
        "..": { cl: () => "", settings: { use: () => ({}) } }
    }, { React: { createElement: () => null } });
    const channel = { id: "channel", guild_id: "guild", type: 0, permissionOverwrites: {}, isNSFW: () => false, isForumChannel: () => false, isGuildVoice: () => false, isGuildStageVoice: () => false, hasFlag: () => false };
    Screen({ channel });
    assert.equal(requests.length, 0);
    ownerId = "owner";
    Screen({ channel: { ...channel, permissionOverwrites: { owner: { type: 1, id: "owner" }, other: { type: 1, id: "other" } } } });
    assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0].userIds), ["owner", "other"]);
});

test("quest progress uses the current Discord store after automation removal", () => {
    const taskTypes = new Proxy({}, { get: (_target, key) => key });
    const task = { type: "WATCH_VIDEO", target: 100 };
    const quest = { id: "quest", config: { taskConfigV2: { tasks: { WATCH_VIDEO: task } } }, userStatus: { progress: { WATCH_VIDEO: { value: 25 } } } };
    const { getQuestPanelPercentComplete } = loadSource("src/equicordplugins/questify/utils/questState.ts", {
        "@vencord/discord-types/enums": { QuestTaskType: taskTypes },
        "@webpack/common": { QuestStore: { getQuest: () => quest } },
        "../settings/access": {},
        "../settings/def": {},
        "./filtering": {}
    });
    assert.equal(getQuestPanelPercentComplete({ quest: { id: "quest" } }).percentComplete, 0.25);
    quest.userStatus.progress.WATCH_VIDEO.value = 80;
    assert.equal(getQuestPanelPercentComplete({ quest: { id: "quest" }, percentCompleteText: "native" }).percentCompleteText, "80%");
    assert.equal(getQuestPanelPercentComplete({ quest: null }), null);
});

test("quest settings migration removes retired automation state and preserves preferences", () => {
    const current = { enabled: true, migrationVersion: 1, questButtonDisplay: "never", ignoredQuestIDs: { questIDs: ["keep"] }, resumeQuestIDs: { user: ["old"] }, autoCompleteQuestTypes: { WATCH_VIDEO: true } };
    const plain = { plugins: { Questify: current } };
    let saves = 0;
    const mocks = {
        "@api/Settings": { PlainSettings: plain, SettingsStore: { markAsChanged: () => saves++ }, definePluginSettings: (value: object) => value },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/types": { OptionType: {} },
        "../components/questButtonSettings": {},
        "../components/questFeaturesSetting": {},
        "../components/questNotificationsSetting": {},
        "../components/questTilesSetting": {},
        "../components/reorderQuestsSetting": {},
        "./def": { defaultQuestOrder: [] }
    };
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(current.migrationVersion, 2);
    assert.equal(current.questButtonDisplay, "never");
    assert.deepEqual(current.ignoredQuestIDs, { questIDs: ["keep"] });
    assert.equal("resumeQuestIDs" in current, false);
    assert.equal("autoCompleteQuestTypes" in current, false);
    assert.equal(saves, 1);
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(saves, 1);
    current.migrationVersion = 0;
    loadSource("src/equicordplugins/questify/settings/store.ts", mocks);
    assert.equal(plain.plugins.Questify.migrationVersion, 2);
    assert.equal(plain.plugins.Questify.enabled, true);
    assert.equal(saves, 2);
});

test("quest sort settings keep every status exactly once", () => {
    const defaults = ["UNCLAIMED", "CLAIMED", "IGNORED", "EXPIRED"];
    const mocks = {
        "../settings/access": {},
        "../settings/def": { defaultQuestOrder: defaults },
        "../settings/rerender": {},
        "../settings/ignoredQuests": {},
        "./questState": {},
        "./ui": { q: (value: string) => value },
        "./shared": {}
    };
    const sanitizers = [
        loadSource("src/equicordplugins/questify/components/reorderQuestsSetting.tsx", mocks, {}, "sanitizeQuestOrder"),
        loadSource("src/equicordplugins/questify/utils/questTiles.ts", mocks, {}, "getValidQuestOrder")
    ];
    for (const sanitize of sanitizers) {
        assert.deepEqual(Array.from(sanitize(["EXPIRED", "EXPIRED", "invalid", "CLAIMED"])), ["EXPIRED", "CLAIMED", "UNCLAIMED", "IGNORED"]);
        assert.deepEqual(Array.from(sanitize(null)), defaults);
        assert.deepEqual(Array.from(sanitize(defaults)), defaults);
    }
});

test("quest names only remove a separate Quest suffix", () => {
    const { normalizeQuestName } = loadSource("src/equicordplugins/questify/utils/filtering.ts", {});
    for (const [name, expected] of [
        [" Conquest ", "CONQUEST"], ["Request", "REQUEST"], ["Game Quest", "GAME"],
        ["Game   Quest ", "GAME"], ["Quest", ""], ["Game", "GAME"]
    ]) {
        assert.equal(normalizeQuestName({ config: { messages: { questName: name } } }), expected);
    }
});

test("profile images fall back after failed guild downloads", async () => {
    const urls: string[] = [];
    let blobReads = 0;
    const processImage = loadSource("src/equicordplugins/profileSets/utils/profile.ts", {
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@webpack": { findStoreLazy: () => ({}) },
        "@webpack/common": {}
    }, {
        fetch: async (url: string) => {
            urls.push(url);
            return { ok: !url.includes("/guilds/"), blob: async () => { blobReads++; return {}; } };
        },
        FileReader: class {
            result = "data:image/png;base64,fixture";
            onloadend = () => {};
            readAsDataURL() { this.onloadend(); }
        }
    }, "processImage");
    assert.equal(await processImage("avatar", "user", "avatar", "guild", true), "data:image/png;base64,fixture");
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/guilds\/guild\/users\/user\/avatars\//);
    assert.match(urls[1], /\/avatars\/user\//);
    assert.equal(blobReads, 1);
});

test("primary stream audio reads stores initialized after module evaluation", () => {
    const common: Record<string, unknown> = {};
    const logic = loadSource("src/equicordplugins/primaryStreamAudio/logic.ts", {});
    const { default: plugin } = loadSource("src/equicordplugins/primaryStreamAudio/index.ts", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": common,
        "./logic": logic
    }, { document: { querySelectorAll: () => [] } });
    const first = { id: "owner-a", _speakingFlags: 2 };
    const second = { id: "owner-b", _speakingFlags: 2 };
    plugin.getAudioElementVolume(first);
    assert.equal(plugin.getAudioElementVolume(second), 1);
    let selected = "owner-a";
    common.SelectedChannelStore = { getVoiceChannelId: () => "channel" };
    common.ChannelRTCStore = { getSelectedParticipant: () => ({ stream: { channelId: "channel", ownerId: selected } }) };
    assert.equal(plugin.getAudioElementVolume(second), 0);
    assert.equal(plugin.getAudioElementVolume(first), 1);
    selected = "owner-b";
    assert.equal(plugin.getAudioElementVolume(first), 0);
    assert.equal(plugin.getAudioElementVolume(second), 1);
});

test("background audio position effects settle after clamping", () => {
    type Position = { left: number; top: number; } | null;
    let position: Position = null;
    let refIndex = 0;
    const effects: (() => void)[] = [];
    const viewport = { innerWidth: 800, innerHeight: 600 };
    const widget = { getBoundingClientRect: () => ({ width: 200, height: 100 }) };
    const render = loadSource("src/equicordplugins/persistentAudioPlayback/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 1 } },
        "@webpack/common": { React: {
            useReducer: () => [0, () => {}],
            useState: () => [position, (update: (current: Position) => Position) => { position = update(position); }],
            useRef: () => ({ current: refIndex++ === 1 ? widget : null }),
            useCallback: (callback: () => void) => callback,
            useEffect: (effect: () => void) => effects.push(effect)
        } }
    }, { window: viewport }, "DetachedAudioWidget");
    render();
    const clamp = effects[effects.length - 1];
    clamp();
    assert.equal(position, null);
    const dragged = { left: 100, top: 100 };
    position = dragged;
    clamp();
    assert.equal(position, dragged);
    viewport.innerWidth = 250;
    viewport.innerHeight = 180;
    clamp();
    assert.equal(JSON.stringify(position), JSON.stringify({ left: 42, top: 72 }));
    const clamped = position;
    clamp();
    assert.equal(position, clamped);
});

test("new plugin notifications return failures to the flux dispatcher", async () => {
    const { default: plugin } = loadSource("src/equicordplugins/newPluginsManager/index.tsx", {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./knownSettings": {},
        "./NewPluginsModal": { openNewPluginsModal: async () => { throw new Error("Storage unavailable"); } }
    });
    await assert.rejects(plugin.flux.POST_CONNECTION_OPEN(), /Storage unavailable/);
});

test("Tidal clears the previous track and position on an empty playback update", () => {
    let changes = 0;
    const { TidalStore: store } = loadSource("src/equicordplugins/musicControls/tidal/TidalStore.ts", {
        "@utils/Logger": { Logger: class {} },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() { changes++; } } }, FluxDispatcher: {} },
        "../settings": { settings: { store: {} } }
    }, { WebSocket: class { addEventListener() {} } });
    const fields = { track: { id: 1, title: "Song", artist: { name: "Artist" }, duration: 120 }, currentTime: 15, playing: true };
    store.socket.onChange({ type: "update", all: true, fields });
    const track = store.track;
    assert.equal(track.name, "Song");
    assert.equal(store.mPosition, 15000);
    store.socket.onChange({ type: "update", all: true, fields: { ...fields, currentTime: 16 } });
    assert.equal(store.track, track);
    assert.equal(store.mPosition, 16000);
    store.socket.onChange({ type: "update", all: true, fields: { track: null, currentTime: 0, playing: false } });
    assert.equal(store.track, null);
    assert.equal(store.mPosition, 0);
    assert.equal(store.isPlaying, false);
    assert.equal(changes, 3);
});

test("MusicControls reconnects cached Tidal stores without initializing unused stores", async () => {
    const cached = Symbol("cached");
    const tidal: Record<symbol, object> = {};
    const lyrics: Record<symbol, object> = {};
    const calls: string[] = [];
    const { default: plugin } = loadSource("src/equicordplugins/musicControls/index.tsx", {
        "@components/ErrorBoundary": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/lazy": { SYM_LAZY_CACHED: cached },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./settings": { settings: { store: {} }, toggleHoverControls() {} },
        "./spotify/lyrics/api": { migrateOldLyrics: async () => {} },
        "./spotify/lyrics/components/lyrics": {},
        "./spotify/PlayerComponent": {},
        "./tidal/lyrics/components/lyrics": {},
        "./tidal/lyrics/providers/store": { TidalLrcStore: lyrics },
        "./tidal/TidalPlayer": {},
        "./tidal/TidalStore": { TidalStore: tidal }
    });
    await plugin.start();
    plugin.stop();
    assert.equal(calls.length, 0);
    tidal[cached] = { socket: { reconnect: () => calls.push("connect") }, destroy: () => calls.push("disconnect") };
    lyrics[cached] = { init: () => calls.push("subscribe"), destroy: () => calls.push("unsubscribe") };
    for (let i = 0; i < 2; i++) {
        await plugin.start();
        plugin.stop();
    }
    assert.deepEqual(calls, ["connect", "subscribe", "unsubscribe", "disconnect", "connect", "subscribe", "unsubscribe", "disconnect"]);
});

test("Tidal lyrics resume after shutdown and ignore old requests", async () => {
    const listeners = new Set<() => void>();
    const requests: ((lyrics: { time: number; text: string; }[]) => void)[] = [];
    const tidal = {
        track: { id: "track" },
        addChangeListener: (listener: () => void) => listeners.add(listener),
        removeChangeListener: (listener: () => void) => listeners.delete(listener)
    };
    const { TidalLrcStore: store } = loadSource("src/equicordplugins/musicControls/tidal/lyrics/providers/store.ts", {
        "@api/Notifications": { showNotification() {} },
        "@equicordplugins/musicControls/settings": { settings: { store: {} } },
        "@equicordplugins/musicControls/tidal/lyrics/api": { getLyrics: () => new Promise(resolve => requests.push(resolve)) },
        "@equicordplugins/musicControls/tidal/TidalStore": { TidalStore: tidal },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() {} } }, FluxDispatcher: {} }
    });
    store.init();
    store.init();
    assert.equal(listeners.size, 1);
    assert.equal(requests.length, 1);
    store.destroy();
    assert.equal(listeners.size, 0);
    store.init();
    assert.equal(listeners.size, 1);
    assert.equal(requests.length, 2);
    requests[0]([{ time: 0, text: "old" }]);
    await setImmediate();
    assert.equal(store.lyrics, null);
    requests[1]([{ time: 0, text: "current" }]);
    await setImmediate();
    assert.equal(store.lyrics[0].text, "current");
    store.destroy();
    assert.equal(listeners.size, 0);
});

test("lyrics fetching respects disabled fallback for either selected provider", async () => {
    for (const lyricsProvider of ["Spotify", "LRCLIB"]) {
        for (const fallbackProvider of [false, true]) {
            const calls: string[] = [];
            const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/api.tsx", {
                "@api/index": { DataStore: { get: async () => ({}), set: async () => {} } },
                "@equicordplugins/musicControls/settings": { settings: { store: { lyricsProvider, fallbackProvider } } },
                "./providers/types": { Provider: { Spotify: "Spotify", Lrclib: "LRCLIB" } },
                "./providers/SpotifyAPI": { getLyricsSpotify: async () => { calls.push("Spotify"); return null; } },
                "./providers/lrclibAPI": { getLyricsLrclib: async () => { calls.push("LRCLIB"); return null; } }
            });
            assert.equal(await module.getLyrics({ id: "track" }), null);
            assert.deepEqual(calls, fallbackProvider ? [lyricsProvider, lyricsProvider === "Spotify" ? "LRCLIB" : "Spotify"] : [lyricsProvider]);
        }
    }
});

test("LRCLIB preserves timestamp precision and bracketed lyric text", async () => {
    const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/providers/lrclibAPI/index.ts", {
        "@equicordplugins/musicControls/spotify/lyrics/providers/types": { Provider: { Lrclib: "LRCLIB" } }
    }, { URLSearchParams, fetch: async () => ({ ok: true, json: async () => ({
        syncedLyrics: "[ar:Artist]\n[00:24]First [echo]\n[01:02.345]Second\n[02:03.5]♪\ninvalid\n[00:99]invalid seconds"
    }) }) });
    const result = await module.getLyricsLrclib({ name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration: 200000 });
    assert.equal(JSON.stringify(result.lyricsVersions.LRCLIB), JSON.stringify([
        { time: 24, text: "First [echo]" }, { time: 62.345, text: "Second" }, { time: 123.5, text: null }
    ]));
});

test("music lyrics translation uses the selected target language", async () => {
    const requests: URL[] = [];
    const module = loadSource("src/equicordplugins/musicControls/spotify/lyrics/providers/translator/index.ts", {
        "@equicordplugins/musicControls/settings": { settings: { store: { translateTo: "nl" } } },
        "@equicordplugins/musicControls/spotify/lyrics/providers/types": { Provider: { Translated: "Translated", Romanized: "Romanized" } }
    }, { URLSearchParams, fetch: async (url: string) => {
        requests.push(new URL(url));
        return { ok: true, json: async () => ({ sentences: [{ trans: "Hallo" }] }) };
    } });
    const lyrics = await module.lyricsAlternativeFetchers.Translated([{ time: 1, text: "Hello" }]);
    assert.equal(requests[0].searchParams.get("tl"), "nl");
    assert.equal(lyrics[0].text, "Hallo");
    assert.equal(lyrics[0].time, 1);
});

test("static sticker conversion labels PNG output and releases its temporary URL", async () => {
    const files: File[] = [];
    let revoked = 0;
    class TestImage {
        width = 200;
        height = 100;
        onload = () => {};
        set src(_value: string) { this.onload(); }
    }
    const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
        "@ffmpeg/ffmpeg": { FFmpeg: class {} }, "@utils/discord": {}, "@utils/ffmpeg": {},
        "@vencord/discord-types/enums": {},
        "@webpack/common": {
            PendingReplyStore: { getPendingReply: () => null }, DraftStore: { getDraft: () => "" },
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            ChannelStore: { getChannel: () => ({ id: "channel" }) },
            UploadHandler: { promptToUpload: (uploads: File[]) => files.push(...uploads) }
        },
        ".": { settings: { store: { promptToUpload: true } } },
        "./utils": { corsFetch: async () => ({ ok: true, blob: async () => new Blob() }) }
    }, {
        File, Blob, Image: TestImage,
        URL: class extends URL {
            static createObjectURL() { return "blob:fixture"; }
            static revokeObjectURL() { revoked++; }
        },
        document: { createElement: () => ({
            getContext: () => ({ drawImage() {} }),
            toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob(["PNG fixture"], { type }))
        }) }
    });
    for (const filename of ["cat.jpg", "cat", ""]) {
        await module.sendSticker({ channelId: "channel", sticker: { image: "https://example.com/", filename }, ctrlKey: false, shiftKey: false });
    }
    assert.deepEqual(files.map(file => file.name), ["cat.png", "cat.png", "sticker.png"]);
    assert.equal(files.every(file => file.type === "image/png"), true);
    assert.equal(revoked, 3);
});

test("sticker sends retain their account through conversion and upload", async () => {
    for (const prompt of [false, true]) {
        for (const switchAt of ["missing", "conversion", "upload", "none"]) {
            let userId: string | undefined = switchAt === "missing" ? undefined : "first";
            let conversions = 0;
            let prompts = 0;
            let uploads = 0;
            let sends = 0;
            const handlers: Record<string, () => void> = {};
            const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
                "@ffmpeg/ffmpeg": {}, "@utils/discord": {}, "@utils/ffmpeg": {},
                "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: "web" } },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
                    PendingReplyStore: { getPendingReply: () => null }, DraftStore: { getDraft: () => "" },
                    ChannelStore: { getChannel: () => ({ id: "channel" }) },
                    UploadHandler: { promptToUpload: () => prompts++ },
                    CloudUploader: class { on(event: string, callback: () => void) { handlers[event] = callback; } upload() { uploads++; } },
                    Constants: { Endpoints: { MESSAGES: () => "/messages" } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
                    RestAPI: { post: async () => { sends++; } }
                }, ".": { settings: { store: { promptToUpload: prompt } } }, "./utils": {}
            }, { convert: async () => { conversions++; if (switchAt === "conversion") userId = "second"; return new File(["gif"], "sticker.gif"); } }, "(toGIF = convert, exports)");
            await module.sendSticker({ channelId: "channel", sticker: { isAnimated: true, image: "image" }, ctrlKey: false, shiftKey: false });
            if (switchAt === "upload") userId = "second";
            handlers.complete?.();
            const active = switchAt !== "missing" && switchAt !== "conversion";
            assert.equal(conversions, switchAt === "missing" ? 0 : 1);
            assert.equal(prompts, active && prompt ? 1 : 0);
            assert.equal(uploads, active && !prompt ? 1 : 0);
            assert.equal(sends, active && !prompt && switchAt !== "upload" ? 1 : 0);
        }
    }
});

test("sticker upload clears only the matching reply after a successful post", async () => {
    for (const outcome of ["success", "post-error", "conversion-error", "prompt", "new-reply", "new-mention", "new-account"]) {
        let userId = "first";
        let pending = { message: { id: "reply" }, shouldMention: false };
        const dispatches: unknown[] = [];
        const handlers: Record<string, () => void> = {};
        let finish: () => void = () => {};
        const posted = new Promise<void>(resolve => { finish = resolve; });
        const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
            "@ffmpeg/ffmpeg": {}, "@utils/discord": {}, "@utils/ffmpeg": {},
            "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: "web" } },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) }, DraftStore: { getDraft: () => "" },
                PendingReplyStore: { getPendingReply: () => pending },
                MessageActions: { getSendMessageOptionsForReply: () => ({ messageReference: { message_id: "reply" } }) },
                FluxDispatcher: { dispatch: (event: unknown) => dispatches.push(event) },
                ChannelStore: { getChannel: () => ({ id: "channel" }) }, UploadHandler: { promptToUpload() {} },
                CloudUploader: class { on(event: string, callback: () => void) { handlers[event] = callback; } upload() {} },
                Constants: { Endpoints: { MESSAGES: () => "/messages" } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
                RestAPI: { post: () => outcome === "post-error" ? Promise.reject(new Error("Failed")) : posted },
                Toasts: { Type: {} }, showToast() {}
            }, ".": { settings: { store: { promptToUpload: outcome === "prompt" } } }, "./utils": {}
        }, { convert: async () => { if (outcome === "conversion-error") throw new Error("Failed"); return new File(["gif"], "sticker.gif"); } }, "(toGIF = convert, exports)");
        await module.sendSticker({ channelId: "channel", sticker: { isAnimated: true, image: "image" }, ctrlKey: false, shiftKey: false });
        assert.equal(dispatches.length, 0);
        handlers.complete?.();
        assert.equal(dispatches.length, 0);
        if (outcome === "new-reply") pending = { ...pending, message: { id: "different" } };
        if (outcome === "new-mention") pending = { ...pending, shouldMention: true };
        if (outcome === "new-account") userId = "second";
        finish();
        await setImmediate();
        assert.equal(dispatches.length, outcome === "success" ? 1 : 0);
    }
});

test("sticker link insertion preserves draft text and the pending reply", async () => {
    for (const draft of ["", "draft", "draft ", "draft\n"]) {
        const inserted: string[] = [];
        let replyReads = 0;
        const notices: string[] = [];
        const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
            "@ffmpeg/ffmpeg": {}, "@utils/discord": { insertTextIntoChatInputBox: (text: string) => inserted.push(text) },
            "@utils/ffmpeg": {}, "@vencord/discord-types/enums": {},
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: "self" }) }, DraftStore: { getDraft: () => draft },
                PendingReplyStore: { getPendingReply: () => { replyReads++; throw new Error("Insertion must not consume a reply"); } },
                Toasts: { Type: {} }, showToast: (message: string) => notices.push(message)
            }, ".": {}, "./utils": {}
        });
        await module.sendSticker({ channelId: "channel", sticker: { image: "https://example.com/sticker.png" }, ctrlKey: true, shiftKey: true });
        assert.deepEqual(inserted, [(draft === "draft" ? " " : "") + "https://example.com/sticker.png"]);
        assert.equal(replyReads, 0);
        assert.deepEqual(notices, []);
    }
});

test("sticker send failures settle and notify only the initiating account", async () => {
    for (const failure of ["conversion", "prompt", "upload", "post", "link"]) {
        for (const stale of [false, true]) {
            let userId = "first";
            const notices: string[] = [];
            const handlers: Record<string, () => void> = {};
            const reject = async () => { if (stale) userId = "second"; throw new Error("Request failed"); };
            const module = loadSource("src/equicordplugins/moreStickers/upload.ts", {
                "@ffmpeg/ffmpeg": {}, "@utils/discord": {}, "@utils/ffmpeg": {},
                "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: "web" } },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => ({ id: userId }) },
                    PendingReplyStore: { getPendingReply: () => null }, DraftStore: { getDraft: () => "" },
                    ChannelStore: { getChannel: () => ({ id: "channel" }) },
                    UploadHandler: { promptToUpload: reject }, MessageActions: { _sendMessage: reject },
                    CloudUploader: class {
                        on(event: string, callback: () => void) { handlers[event] = callback; }
                        upload() { if (failure === "upload") { if (stale) userId = "second"; handlers.error(); } else handlers.complete(); }
                    },
                    Constants: { Endpoints: { MESSAGES: () => "/messages" } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
                    RestAPI: { post: reject }, Toasts: { Type: { FAILURE: "failure" } },
                    showToast: (message: string) => notices.push(message)
                }, ".": { settings: { store: { promptToUpload: failure === "prompt" } } }, "./utils": {}
            }, { convert: async () => failure === "conversion" ? reject() : new File(["gif"], "sticker.gif") }, "(toGIF = convert, exports)");
            await module.sendSticker({ channelId: "channel", sticker: { isAnimated: true, image: "image" }, ctrlKey: false, shiftKey: failure === "link" });
            await setImmediate();
            assert.deepEqual(notices, stale ? [] : ["Could not send sticker."]);
        }
    }
});

test("animated sticker conversions own and terminate their workers", async () => {
    for (const failure of ["fetch", "load", "write", "exec", "exit", "read", "string", "none"]) {
        const workers: { terminations: number; }[] = [];
        const failAt = (stage: string) => { if (failure === stage) throw new Error("Conversion failed"); };
        class Worker {
            terminations = 0;
            inputName = "";
            constructor() { workers.push(this); }
            async writeFile(name: string) { this.inputName = name; failAt("write"); }
            async exec(args: string[]) { assert.notEqual(this.inputName, args.at(-1)); failAt("exec"); return failure === "exit" ? 1 : 0; }
            async readFile() { failAt("read"); return failure === "string" ? "bad data" : new Uint8Array([1, 2]); }
            terminate() { this.terminations++; }
        }
        const convert = loadSource("src/equicordplugins/moreStickers/upload.ts", {
            "@ffmpeg/ffmpeg": { FFmpeg: Worker }, "@utils/discord": {},
            "@utils/ffmpeg": { loadFFmpeg: async () => { failAt("load"); } },
            "@vencord/discord-types/enums": {}, "@webpack/common": {}, ".": {},
            "./utils": { corsFetch: async () => { failAt("fetch"); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; } }
        }, { URL, File }, "toGIF");
        if (failure === "none") {
            const files = await Promise.all([convert("https://example.com/output.gif"), convert("https://example.com/")]);
            assert.equal(workers.length, 2);
            assert.equal(files.every((file: File) => file.type === "image/gif" && file.size === 2), true);
        } else {
            await assert.rejects(convert("https://example.com/a.png"));
            assert.equal(workers.length, failure === "fetch" ? 0 : 1);
        }
        assert.equal(workers.every(worker => worker.terminations === 1), true);
    }
});

test("mic loopback stop restores only deafening applied by the plugin", async () => {
    for (const initiallyDeaf of [false, true]) {
        let deaf = initiallyDeaf;
        let finish: () => void = () => {};
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        const module = loadSource("src/equicordplugins/micLoopbackTester/index.tsx", {
            "@api/UserArea": {}, "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: "self" }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
                MediaEngineStore: { isSelfDeaf: () => deaf },
                VoiceActions: {
                    setLoopback: (_name: string, active: boolean) => active ? Promise.resolve() : stopped,
                    toggleSelfDeaf: () => { deaf = !deaf; }
                }
            }
        }, {}, "({ plugin: exports.default, enableLoopback })");
        await module.enableLoopback();
        assert.equal(deaf, true);
        const pending = module.plugin.stop();
        assert.equal(deaf, true);
        finish();
        await pending;
        assert.equal(deaf, initiallyDeaf);
    }
});

test("middle click settings preserve paste protection and stopped listeners stay removed", () => {
    const listeners = new Map<string, (event: object) => void>();
    const store = { openScope: "links", pasteScope: "always", pasteThreshold: 100 };
    const plugin = loadSource("src/equicordplugins/middleClickTweaks/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/index": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} }
    }, { document: {
        addEventListener: (name: string, callback: (event: object) => void) => listeners.set(name, callback),
        removeEventListener: (name: string, callback: (event: object) => void) => {
            assert.equal(listeners.get(name), callback);
            listeners.delete(name);
        }
    } }).default;
    plugin.start();
    store.openScope = "none";
    plugin.settings.def.openScope.onChange?.("none");
    listeners.get("mouseup")?.({ button: 1 });
    assert.equal(plugin.isPastingDisabled(true), true);
    plugin.stop();
    store.openScope = "links";
    plugin.settings.def.openScope.onChange?.("links");
    assert.equal(listeners.size, 0);
});

test("logger export iteration preserves stored attachment URLs without populating display caches", async () => {
    const record = { message_id: "1", message: { attachments: [{ url: "https://example.com/image.png", proxy_url: "https://example.com/proxy.png" }] } };
    const module = loadSource("src/equicordplugins/messageLoggerEnhanced/db.ts", {
        "@webpack/common": {},
        idb: { openDB: async () => ({ transaction: () => ({ store: { openCursor: async () => ({ value: record, continue: async () => null }) } }) }) },
        "./utils": {}, "./utils/cleanUp": { stripTransientRenderState: () => assert.fail("Export must not prepare display records") },
        "./utils/constants": {},
        "./utils/saveImage": { getAttachmentBlobUrl: () => assert.fail("Export must not read attachment files") }
    });
    await setImmediate();
    const batches: (typeof record)[][] = [];
    for await (const batch of module.iterateAllMessagesIDB()) batches.push(batch);
    assert.equal(batches.length, 1);
    assert.equal(batches[0][0], record);
    assert.equal(record.message.attachments[0].url, "https://example.com/image.png");
    assert.equal(module.cachedMessages.size, 0);
});

test("native logger imports preserve Unicode across bounded chunks", async () => {
    const text = "a".repeat(65535) + "🛒é終";
    const bytes = Buffer.from(text);
    let position = 0;
    let closed = 0;
    const module = loadSource("src/equicordplugins/messageLoggerEnhanced/native/import.ts", {
        "node:crypto": { randomUUID: () => "fixture" },
        "node:fs/promises": { open: async () => ({
            async read(target: Buffer, offset: number, length: number) {
                assert.equal(length, 65536);
                const bytesRead = bytes.copy(target, offset, position, position + length);
                position += bytesRead;
                return { bytesRead };
            },
            async close() { closed++; }
        }) },
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["fixture.json"] }) } }
    }, { Buffer, TextDecoder });
    const id = await module.startNativeLogImport({});
    let result = "";
    for (;;) {
        const chunk = await module.readNativeLogChunk({}, id, Number.MAX_SAFE_INTEGER);
        if (chunk === null) break;
        result += chunk;
    }
    assert.equal(result, text);
    await module.closeNativeLogImport({}, id);
    assert.equal(closed, 1);
});

test("MessageBurst retains outgoing text until its edit resolves", async () => {
    for (const success of [false, true]) {
        let finish: () => void = () => {};
        const edit = new Promise<void>((resolve, reject) => { finish = () => success ? resolve() : reject(new Error("Edit failed")); });
        const plugin = loadSource("src/equicordplugins/messageBurst/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: { timePeriod: 3 } }) },
            "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
            "@webpack/common": {
                ChannelStore: { getChannel: () => ({ isGroupDM: () => false }) },
                MessageStore: { getMessages: () => ({ last: () => ({ id: "previous", author: { id: "self" }, content: "First", timestamp: new Date() }) }) },
                UserStore: { getCurrentUser: () => ({ id: "self" }) },
                MessageActions: { editMessage: () => edit }
            }
        }, { document: { querySelector: () => null } }).default;
        const outgoing = { content: "Second" };
        const pending = plugin.onBeforeMessageSend("channel", outgoing);
        assert.equal(outgoing.content, "Second");
        finish();
        if (success) await pending;
        else await assert.rejects(pending, /Edit failed/);
        assert.equal(outgoing.content, success ? "" : "Second");
    }
});

test("LimitlessScreenshare preserves source resolution when changing frame rate", () => {
    let resolution: number | undefined = 0;
    const plugin = loadSource("src/equicordplugins/limitlessScreenshare/index.tsx", {
        "@utils/constants": { EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": {
            MediaEngineStore: { getState: () => ({ goLiveSource: { quality: { resolution, frameRate: 30 } } }) },
            Menu: { MenuRadioItem: "radio" }
        },
        "./CustomRange": { CustomRange: (props: object) => ({ props }) },
        "./settings": { MIN_FPS: 1, MIN_RESOLUTION: 3, settings: { store: { maxFPS: 120, maxResolution: 1080, roundResolution: false, resolutions: [], fpss: [{ label: "60fps", value: 60 }] } } }
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } }).default;
    const updates: number[] = [];
    const controls = plugin.SettingsRange((_enabled: boolean, value: number) => updates.push(value), [true, "fixture"], false);
    controls[0].props.onChange(60);
    controls[1].props.action();
    assert.deepEqual(updates, [0, 0]);
    resolution = undefined;
    controls[0].props.onChange(60);
    assert.equal(updates[2], 720);
});

test("InvisibleChat displays decrypted URLs without requesting a preview", async () => {
    let updated = false;
    const module = loadSource("src/equicordplugins/invisibleChat.desktop/index.tsx", {
        "@api/ChatButtons": {}, "@api/Settings": { definePluginSettings: () => ({}) },
        "@api/MessageUpdater": { updateMessage: () => { updated = true; } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} }, "@utils/dependencies": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} },
        "@webpack/common": {}, "./components/DecryptionModal": {}, "./components/EncryptionModal": {}
    });
    const message = { channel_id: "channel", id: "message", embeds: [] as { rawDescription: string; }[] };
    const plaintext = "Private link: https://example.test/private-token";
    await module.buildEmbed(message, plaintext);
    assert.equal(updated, true);
    assert.equal(message.embeds.length, 1);
    assert.equal(message.embeds[0].rawDescription, plaintext);
});

test("InstantScreenshare never substitutes a different media source", async () => {
    const selected = { id: "window:selected", name: "Selected window" };
    let sources = [{ id: "screen:other", name: "Other screen" }, selected];
    let failures = 0;
    const module = loadSource("src/equicordplugins/instantScreenshare/utils.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { streamMedia: selected.id, includeVideoDevices: false } }) },
        "@components/Heading": {}, "@components/margins": {}, "@components/Paragraph": {},
        "@utils/constants": {}, "@utils/Logger": { Logger: class {} },
        "@utils/types": { OptionType: {} },
        "@webpack": { findByCodeLazy: () => async () => sources, findByPropsLazy: () => ({}) },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({}) }, showToast: () => { failures++; }, Toasts: { Type: {} } }
    });
    assert.equal(await module.getCurrentMedia(), selected);
    sources = [sources[0]];
    assert.equal(await module.getCurrentMedia(), null);
    assert.equal(module.settings.store.streamMedia, selected.id);
    sources = [];
    assert.equal(await module.getCurrentMedia(), null);
    assert.equal(failures, 2);
});

test("HideServers shutdown only persists pending edits", async () => {
    let finishLoad: (value: string[]) => void = () => {};
    const writes: string[][] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const { HiddenServersStore: store } = loadSource("src/equicordplugins/hideServers/HiddenServersStore.ts", {
        "@api/DataStore": {
            get: () => new Promise<string[]>(resolve => { finishLoad = resolve; }),
            set: (_key: string, value: string[]) => { writes.push(Array.from(value)); }
        },
        "@webpack": { proxyLazyWebpack: (factory: () => object) => factory(), findStoreLazy: () => ({}) },
        "@webpack/common": { Flux: { Store: class { emitChange() {} } }, FluxDispatcher: {}, GuildStore: {} }
    }, {
        setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: (id: number) => timers.delete(id)
    });
    const loading = store.load();
    store.unload();
    finishLoad(["saved"]);
    await loading;
    assert.deepEqual(writes, []);
    assert.equal(store.hiddenGuilds.size, 0);
    store.addHiddenGuild("edited");
    store.unload();
    assert.deepEqual(writes, [["edited"]]);
    assert.equal(timers.size, 0);
    store.unload();
    assert.equal(writes.length, 1);
});

test("GitHub profile tab renders loading and failure messages", () => {
    for (const [loading, error, expected] of [[true, null, "Loading repositories..."], [false, "Request failed", "Request failed"]] as const) {
        let index = 0;
        const values = [[], loading, error, null];
        const tab = loadComponent("src/equicordplugins/githubRepos/components/ProfileTabComponent.tsx", {
            useState: () => [values[index++], () => {}], useEffect: () => {}
        }, {
            "@equicordplugins/githubRepos/githubApi": {},
            "..": { cl: (name: string) => name, settings: { store: {} } }, "./RepoCard": {}
        });
        const result = tab.ProfileTabComponent({ id: "fixture" });
        assert.ok(JSON.stringify(result).includes(expected));
    }
});

test("GIF collection extensions handle URL schemes, case and malformed input", () => {
    const extension = loadSource("src/equicordplugins/gifCollections/utils/getUrlExtension.ts", {
        "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } }
    });
    for (const url of ["https://example.test/file.MP4?x=1", "http://example.test/file.mp4", "//example.test/file.mp4"]) {
        assert.equal(extension.getUrlExtension(url), "mp4");
    }
    for (const url of ["not a URL", "https://example.test/path", "https://example.test/folder.mp4/file"]) {
        assert.equal(extension.getUrlExtension(url), undefined);
    }
    const format = loadSource("src/equicordplugins/gifCollections/utils/getFormat.ts", {
        "../types": { Format: { IMAGE: 1, VIDEO: 2 } }, "./getUrlExtension": extension
    });
    assert.equal(format.getFormat("https://media.tenor.com/file.GIF"), 1);
    assert.equal(format.getFormat("https://media.tenor.com/file.MP4"), 2);
    const audio = loadSource("src/equicordplugins/gifCollections/utils/isAudio.ts", { "./getUrlExtension": extension });
    assert.equal(audio.isAudio("http://example.test/file.MP3"), true);
});

test("Friendship ranks cover milestone days without gaps or duplicate badges", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    let days = 0;
    let friend = true;
    const ranks = loadSource("src/equicordplugins/friendshipRanks/index.tsx", {
        "@api/Badges": { BadgePosition: {} }, "@components/ErrorBoundary": {}, "@components/Flex": {},
        "@components/Paragraph": {}, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { RelationshipStore: { isFriend: () => friend, getSince: () => new Date(now - days * 86400000).toISOString() } }
    }, { Date: class extends Date { constructor(value: string | number = now) { super(value); } } });
    const badges: { description: string; shouldShow(info: { userId: string; }): boolean; }[] = ranks.default.userProfileBadges;
    const shown = () => badges.filter(badge => badge.shouldShow({ userId: "fixture" })).map(badge => badge.description);
    for (const [age, title] of [[0, "Sprout"], [29, "Sprout"], [30, "Blooming"], [90, "Burning"], [182, "Burning"], [183, "Fighter"], [365, "Star"], [730, "Royal"], [1826, "Royal"], [1827, "Besties"]] as const) {
        days = age;
        assert.equal(JSON.stringify(shown()), JSON.stringify([title]));
    }
    friend = false;
    assert.equal(shown().length, 0);
});

test("Friend codes clear only after successful revocation", async () => {
    for (const success of [false, true]) {
        let finish: () => void = () => {};
        const request = new Promise<void>((resolve, reject) => { finish = () => success ? resolve() : reject(new Error("Failed")); });
        let cleared = false;
        let failed = false;
        let hook = 0;
        const panel = loadComponent("src/equicordplugins/friendCodes/FriendCodesPanel.tsx", {
            useState: () => hook++ === 0 ? [[{ code: "fixture" }], () => { cleared = true; }] : [false, () => {}],
            useEffect: () => {}, Button: { Colors: {}, Looks: {} },
            showToast: () => { failed = true; }, Toasts: { Type: {} }
        }, {
            "@components/Flex": { Flex: "flex" }, "@components/Heading": { Heading: "heading" },
            "@utils/clipboard": {}, "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({ revokeFriendInvites: () => request }) }
        });
        const tree = panel.default();
        const button = tree.props.children[0].props.children[1].props.children[1].props.children[1];
        const pending = button.props.onClick();
        assert.equal(cleared, false);
        finish();
        await pending;
        assert.equal(cleared, success);
        assert.equal(failed, !success);
    }
});

test("FontLoader uses the escaped selected family for body and code fonts", async () => {
    const store = { selectedFont: 'Font";{}', applyOnCodeBlocks: true };
    const elements: { textContent: string; remove(): void; }[] = [];
    const plugin = loadSource("src/equicordplugins/fontLoader/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), migratePluginSetting: () => {} },
        "@components/Card": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@shared/debounce": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/margins": {}, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}
    }, {
        CSS: { escape: (value: string) => { assert.equal(value, store.selectedFont); return "escaped-family"; } },
        document: { createElement: () => ({ textContent: "", remove() {} }), head: { appendChild: (element: typeof elements[number]) => elements.push(element) } }
    });
    await plugin.default.start();
    const css = elements[0].textContent;
    assert.equal((css.match(/escaped-family/g) || []).length, 4);
    assert.ok(css.includes("--font-code: escaped-family, monospace"));
    assert.equal(css.includes(store.selectedFont), false);
    store.applyOnCodeBlocks = false;
    await plugin.default.start();
    assert.equal(elements[0].textContent.includes("--font-code"), false);
});

test("Filename plugins preserve names and apply extension fixes without anonymizing", () => {
    const definitions = { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} };
    const fixer = loadSource("src/equicordplugins/fixFileExtensions/index.tsx", {
        "@api/PluginManager": {}, "@plugins/anonymiseFileNames": { tarExtMatcher: /\.tar\.\w+$/ },
        "@utils/constants": { Devs: {} }, "@utils/types": definitions
    });
    const store = { anonymiseByDefault: false, spoilerMessages: false, method: 1, consistent: "image" };
    const enabled = { enabled: true };
    const anonymizer = loadSource("src/plugins/anonymiseFileNames/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "@api/Settings": { definePluginSettings: () => ({ store }), Settings: { plugins: { FixFileExtensions: enabled } } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@equicordplugins/fixFileExtensions": fixer, "@utils/constants": { Devs: {} },
        "@utils/types": definitions, "@webpack": { findByCodeLazy: () => null }, "@webpack/common": {}
    });
    for (const [filename, expected] of [["README", "README"], ["archive.tar.gz", "archive.tar.gz"], ["photo.jpe", "photo.jpg"]]) {
        const direct = { filename };
        fixer.default.fixExt(direct);
        assert.equal(direct.filename, expected);
        const combined = { filename };
        anonymizer.default.anonymise(combined);
        assert.equal(combined.filename, expected);
    }
    enabled.enabled = false;
    store.spoilerMessages = true;
    const original = { filename: "photo.jpe" };
    anonymizer.default.anonymise(original);
    assert.equal(original.filename, "SPOILER_photo.jpe");
    enabled.enabled = true;
    store.anonymiseByDefault = true;
    const anonymous = { filename: "photo.jpe" };
    anonymizer.default.anonymise(anonymous);
    assert.equal(anonymous.filename, "SPOILER_image.jpg");
});

test("File upload destination selection respects disabled fallbacks and host order", () => {
    const types = loadSource("src/equicordplugins/fileUpload/types.ts", {});
    const store = { disableFallbacks: true, fallbackOrder: "" };
    const upload = loadSource("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": {}, "@equicordplugins/fileUpload/settings": { settings: { store } },
        "@equicordplugins/fileUpload/types": types, "@utils/clipboard": {}, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/web": {}, "@webpack/common": {},
        "./apngToGif": {}, "./getMediaUrl": {}, "./s3": {}, "./sharex": {}
    }, { IS_DISCORD_DESKTOP: false }, "({ buildUploadOrder })");
    assert.throws(() => upload.buildUploadOrder("catbox", "file.exe"), /Choose another service/);
    assert.throws(() => upload.buildUploadOrder("0x0", "file.png"), /Choose another service/);
    assert.equal(JSON.stringify(upload.buildUploadOrder("catbox", "file.png")), '["catbox"]');
    store.disableFallbacks = false;
    const order: string[] = upload.buildUploadOrder("catbox", "file.exe");
    assert.equal(order[0], "zipline");
    assert.equal(order.includes("catbox"), false);
    assert.equal(order.includes("0x0"), false);
    const supported: string[] = upload.buildUploadOrder("catbox", "file.png");
    assert.equal(supported[0], "catbox");
    assert.equal(supported.filter(service => service === "catbox").length, 1);
});

test("File uploads report failure, busy state and success", async () => {
    const upload = loadSource("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": {}, "@equicordplugins/fileUpload/settings": {},
        "@equicordplugins/fileUpload/types": { ServiceType: {}, serviceLabels: {} }, "@utils/clipboard": {}, "@utils/discord": {},
        "@utils/Logger": { Logger: class { error() {} } }, "@utils/web": {},
        "@webpack/common": { showToast: () => {}, Toasts: { Type: {} } },
        "./apngToGif": {}, "./getMediaUrl": {}, "./s3": {}, "./sharex": {}
    }, { IS_DISCORD_DESKTOP: false, setTimeout: () => 0 }, `
        isConfigured = () => true;
        isFileTypeAllowed = () => true;
        uploadPreparedBlob = async () => { throw new Error("Failed"); };
        ({ uploadProvidedFiles, succeed() { uploadPreparedBlob = async () => "url"; }, busy() { isUploading = true; },
            cancelLate() {
                cancelRequested = false;
                buildUploadOrder = () => ["fixture"];
                uploadToService = async () => { cancelRequested = true; return "url"; };
                return uploadWithFallbacks({ size: 1 }, "fixture.txt", "fixture");
            }
        });
    `);
    const files = [{ name: "fixture.txt" }];
    assert.equal(await upload.uploadProvidedFiles(files), false);
    assert.equal(await upload.uploadProvidedFiles([]), false);
    upload.succeed();
    assert.equal(await upload.uploadProvidedFiles(files), true);
    upload.busy();
    assert.equal(await upload.uploadProvidedFiles(files), false);
    await assert.rejects(upload.cancelLate(), /Upload cancelled by user/);
});

test("Draft attachments remain until their upload succeeds", async () => {
    let succeeded = false;
    let removed = 0;
    const draft = loadSource("src/equicordplugins/fileUpload/index.tsx", {
        "@api/ContextMenu": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findByPropsLazy: () => ({}) }, "@webpack/common": {},
        "./settings": { settings: {} }, "./types": {}, "./utils/getMediaUrl": {},
        "./utils/upload": { isConfigured: () => true, isFileTypeAllowed: () => true,
            uploadProvidedFiles: async () => succeeded, logger: { warn: () => {} } }
    }, {}, "({ handleUploadFileFromDraft })");
    const upload = { item: { file: {} }, removeFromMsgDraft: () => removed++ };
    await draft.handleUploadFileFromDraft(upload);
    assert.equal(removed, 0);
    succeeded = true;
    await draft.handleUploadFileFromDraft(upload);
    assert.equal(removed, 1);
});

test("ShareX response substitutions preserve literal dollar sequences", () => {
    const sharex = loadSource("src/equicordplugins/fileUpload/utils/sharex.ts", {});
    const response = "https://example.test/$&/$$/$`/$'";
    assert.equal(sharex.resolveShareXTemplate("$response$", response, null), response);
    assert.equal(sharex.resolveShareXTemplate("{response}", response, null), response);
});

test("Element highlighter escapes inspected text in its tooltip", () => {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    const highlighter = loadSource("src/equicordplugins/elementHighlighter.dev/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { showId: true, showClasses: true, showFont: true } }) },
        "@components/Button": {}, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/discord": {}, "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => null }, "@webpack/common": { lodash: { escape } }
    }, { HTMLElement: class {} }, "({ buildTooltipContent })");
    const payload = '<img src=x onerror="alert(1)">';
    const html = highlighter.buildTooltipContent({ tagName: "DIV", id: payload, className: payload, getAttribute: () => null },
        { color: "rgb(1, 2, 3)", fontFamily: payload, fontSize: "12px" }, { width: 20, height: 10 });
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes(escape(payload)));
    assert.ok(html.includes("20x10"));
});

test("Toolbox reflects plugin toggles without changing its search", () => {
    let enabled = true;
    let hook = 0;
    const memo: unknown[] = [];
    const menu = loadComponent("src/equicordplugins/equicordToolbox/menu.tsx", {
        Menu: {}, useState: () => ["", () => {}],
        useMemo: (factory: () => unknown) => { const index = hook++; return memo[index] ??= factory(); }
    }, {
        "@api/Notifications/notificationLog": {},
        "@api/PluginManager": { isPluginEnabled: () => enabled, isSettingHidden: () => false, isSettingDisabled: () => false,
            plugins: { Fixture: { name: "Fixture", settings: { def: { option: { type: 1 } } } } } },
        "@api/Settings": { useSettings: () => ({ plugins: { Fixture: { option: true } } }) },
        "@components/settings": {}, "@utils/react": {},
        "@utils/text": { wordsFromCamel: (value: string) => value, wordsToTitle: (value: string) => value },
        "@utils/types": { OptionType: { BOOLEAN: 1 } }, ".": {}
    });
    assert.ok(JSON.stringify(menu.buildPluginMenuEntries()).includes("Fixture-menu"));
    enabled = false;
    hook = 0;
    assert.equal(JSON.stringify(menu.buildPluginMenuEntries()).includes("Fixture-menu"), false);
});

test("Cancelling a dependency restart leaves the requested plugin disabled", async () => {
    const settings = { enabled: false };
    let confirm = false;
    let reloads = 0;
    const helper = loadSource("src/equicordplugins/equicordHelper/utils.tsx", {
        "@api/Notices": {},
        "@api/PluginManager": {
            plugins: { Fixture: { name: "Fixture" } },
            startDependenciesRecursive: () => ({ restartNeeded: true, failures: [] })
        },
        "@api/Settings": { Settings: { plugins: { Fixture: settings } } },
        "@webpack/common": { Alerts: { show: (options: { onCancel(): void; onConfirm(): void; }) => confirm ? options.onConfirm() : options.onCancel() } }
    }, { React: { createElement: () => null }, location: { reload: () => reloads++ } });
    assert.equal(await helper.toggleEnabled("Fixture"), false);
    assert.equal(settings.enabled, false);
    assert.equal(reloads, 0);
    confirm = true;
    assert.equal(await helper.toggleEnabled("Fixture"), true);
    assert.equal(settings.enabled, true);
    assert.equal(reloads, 1);
});

test("Desktop CSP preserves explicit hosts without allowing every origin", () => {
    const csp = loadSource("src/main/csp/index.ts", {
        "@main/settings": { NativeSettings: { store: { customCspRules: { "example.test": ["connect-src"] } } } },
        "electron": {}
    }, {}, "({ patchCsp })");
    const headers = { "content-security-policy": ["default-src 'self'; connect-src 'self'"] };
    csp.patchCsp(headers);
    const policy = headers["content-security-policy"][0];
    assert.equal(policy.split(/\s+/).includes("*"), false);
    assert.ok(policy.includes("api.github.com"));
    assert.ok(policy.includes("example.test"));
    const connect = policy.split("; ").find(directive => directive.startsWith("connect-src "));
    for (const host of ["streaks.equicord.org", "badges.equicord.org", "dc.songspotlight.nexpid.xyz", "fonts.google.com",
        "fonts.googleapis.com", "fonts.gstatic.com", "translate.googleapis.com", "timezone.creations.works", "themes.equicord.org",
        "lrclib.net", "spotify-lyrics-api-pi.vercel.app", "api.stats.fm", "www.reddit.com", "nekos.best", "api.thecatapi.com", "api.thedogapi.com"])
        assert.ok(connect?.split(" ").includes(host), host);
    const fonts = policy.split("; ").find(directive => directive.startsWith("font-src "));
    assert.ok(fonts?.split(" ").includes("fonts.gstatic.com"));
});

test("Dragify validates JSON fields before resolving a drop", () => {
    const drag = loadSource("src/equicordplugins/dragify/utils.ts", {});
    const stores = { ChannelStore: { getChannel: () => null }, GuildStore: { getGuild: () => null }, UserStore: { getUser: () => null } };
    const id = "123456789012345678";
    for (const payload of [{ kind: "user", id: 123 }, { kind: "user", id: "bad> @everyone" }, { kind: 42, id }, { type: {}, id }, { kind: "channel", id, guildId: [] }]) {
        assert.equal(drag.parseDragifyPayload(JSON.stringify(payload)), null);
        assert.equal(drag.parseFromStrings([JSON.stringify(payload)], stores), null);
    }
    assert.equal(drag.parseDragifyPayload(JSON.stringify({ kind: "user", id })).id, id);
    assert.equal(drag.parseFromStrings([JSON.stringify({ type: "channel", channelId: id, guildId: "@me" })], stores).guildId, "@me");
});

test("Dragify derives active drag state from the current entity", () => {
    const drag = loadSource("src/equicordplugins/dragify/dragState.ts", {}, { clearInterval, clearTimeout });
    for (const kind of ["user", "guild", "channel"]) {
        drag.beginDrag({ kind, id: "fixture" });
        assert.equal(drag.hasActiveDrag(), true);
        assert.equal(drag.isUserDragActive(), kind === "user");
        assert.equal(drag.isGuildDragActive(), kind === "guild");
        drag.clearDragState();
        assert.equal(drag.hasActiveDrag(), false);
        assert.equal(drag.isUserDragActive(), false);
        assert.equal(drag.isGuildDragActive(), false);
    }
});

test("Discord MCP handles response failures and cancels pending startup", async () => {
    const errors: string[] = [];
    let first = true;
    let stop = () => {};
    let polls = 0;
    let initialized = () => {};
    const initialization = new Promise<void>(resolve => { initialized = resolve; });
    const Native = {
        initializeBridge: () => initialization,
        async takeRequests() {
            polls++;
            if (first) { first = false; return [{ id: "fixture", tool: "unknown" }]; }
            stop(); return [];
        },
        async writeResponse() { throw new Error("Disk write failed"); }
    };
    const loaded = loadSource("src/equicordplugins/discordMcp.desktop/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/settings/tabs/plugins/components/Common": {},
        "@plugins/voiceMessages/waveform": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error(message: string) { errors.push(message); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, defineDefault: (value: unknown) => value, OptionType: {} },
        "@vencord/discord-types/enums": {}, "@webpack/common": {},
        "../voiceMessageTranscriber.desktop/utils": {}, "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
    }, { VencordNative: { pluginHelpers: { DiscordMCP: Native } } }, "({ ...exports, bridgeLoop })");
    stop = loaded.default.stop;
    await loaded.bridgeLoop(0);
    await setImmediate();
    assert.deepEqual(errors, ["Bridge response failed"]);
    const previousPolls = polls;
    const starting = loaded.default.start();
    loaded.default.stop();
    initialized();
    await starting;
    await setImmediate();
    assert.equal(polls, previousPolls);
});

test("Discord MCP attachment downloads reject redirects and untrusted origins", async () => {
    let redirect = false;
    let oversized = false;
    let cancelled = false;
    let requests = 0;
    let deadline = 0;
    const fetchAttachmentData = loadSource("src/equicordplugins/discordMcp.desktop/native.ts", {
        "@main/utils/constants": { DATA_DIR: "/fixture" },
        crypto: {}, fs: {}, "fs/promises": {}, os: {}, path,
        "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
    }, {
        __dirname: "/fixture", Buffer, URL,
        AbortSignal: { timeout: (ms: number) => { deadline = ms; return new AbortController().signal; } },
        fetch: async (_url: URL, options?: RequestInit) => {
            requests++;
            if (redirect && options?.redirect === "error") throw new TypeError("Redirect blocked");
            if (oversized) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
                headers: { "content-length": String(26 * 1024 * 1024) }
            });
            return new Response("attachment", { headers: { "content-type": "image/png" } });
        }
    }, "fetchAttachmentData");
    for (const url of ["https://untrusted.invalid/attachments/a", "http://cdn.discordapp.com/attachments/a", "https://cdn.discordapp.com:8443/attachments/a", "https://cdn.discordapp.com/other/a"]) {
        await assert.rejects(fetchAttachmentData(url), /untrusted/);
    }
    assert.equal(requests, 0);
    const url = "https://cdn.discordapp.com/attachments/a";
    assert.equal((await fetchAttachmentData(url)).data.toString(), "attachment");
    assert.equal(deadline, 120_000);
    redirect = true;
    await assert.rejects(fetchAttachmentData(url), /Redirect blocked/);
    redirect = false;
    oversized = true;
    await assert.rejects(fetchAttachmentData(url), /25 MB/);
    assert.equal(cancelled, true);
});

test("cursor sprites release listeners, frames and body styles on cleanup", () => {
    for (const name of ["oneko", "fathorse"]) {
        const listeners = new Set<unknown>();
        const frames = new Map<number, (time: number) => void>();
        const nodes = new Set<object>();
        let frameId = 0;
        const events = {
            addEventListener: (_name: string, listener: unknown) => listeners.add(listener),
            removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener)
        };
        const body = {
            style: { transform: "scale(1)", willChange: "opacity" },
            appendChild(node: { parentElement: object | null; isConnected: boolean }) {
                node.parentElement = body; node.isConnected = true; nodes.add(node);
            }
        };
        const requestAnimationFrame = (callback: (time: number) => void) => { frames.set(++frameId, callback); return frameId; };
        const cancelAnimationFrame = (id: number) => frames.delete(id);
        const { default: start } = loadSource(`src/equicordplugins/cursorBuddy/${name}.js`, {}, {
            document: {
                ...events, body,
                createElement: () => ({
                    style: {}, parentElement: null, isConnected: false,
                    remove() { this.parentElement = null; this.isConnected = false; nodes.delete(this); }
                })
            },
            window: { ...events, requestAnimationFrame, cancelAnimationFrame, innerWidth: 1000, innerHeight: 800 },
            requestAnimationFrame, cancelAnimationFrame, Image: class {}
        });
        for (let i = 0; i < 3; i++) {
            const cleanup = start({ shake: true, image: "fixture" });
            assert.equal(nodes.size, 1);
            assert.equal(listeners.size, 1);
            assert.equal(frames.size, 1);
            for (const [id, callback] of [...frames]) { frames.delete(id); callback(100); }
            cleanup();
            assert.equal(nodes.size, 0);
            assert.equal(listeners.size, 0);
            assert.equal(frames.size, 0);
            assert.deepEqual(body.style, { transform: "scale(1)", willChange: "opacity" });
        }
    }
});

test("favorite emote drags preserve favorites when an endpoint disappears", () => {
    let update: (state: { emojis: string[] }) => unknown = () => assert.fail("No update scheduled");
    const { default: plugin } = loadSource("src/equicordplugins/dragFavoriteEmotes/index.tsx", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@webpack": { findByPropsLazy: () => ({}), findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            useDrop: (factory: () => object) => factory(),
            UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: {
                updateAsync: (_key: string, callback: typeof update) => { update = callback; }
            } }
        }
    });
    const drop = plugin.drop({ emoji: { id: "target" }, category: "FAVORITES" });
    drop.drop({ id: "source" });
    for (const emojis of [["target", "other"], ["source", "other"], ["other"]]) {
        const before = [...emojis];
        assert.equal(update({ emojis }), false);
        assert.deepEqual(emojis, before);
    }
    const forward = { emojis: ["source", "other", "target"] };
    update(forward);
    assert.deepEqual(forward.emojis, ["other", "source", "target"]);
    const backward = { emojis: ["target", "other", "source"] };
    update(backward);
    assert.deepEqual(backward.emojis, ["source", "target", "other"]);
});

test("custom user colors preserve black when reopening the picker", () => {
    let initialColor: unknown;
    const colors: Record<string, string> = { user: "000000" };
    const { SetColorModal } = loadComponent("src/equicordplugins/customUserColors/SetColorModal.tsx", {
        useState: (value: unknown) => { initialColor = value; return [value, (next: unknown) => { initialColor = next; }]; }
    }, {
        "@api/DataStore": {}, "@components/Heading": {},
        "@utils/margins": { Margins: {} }, "./index": { colors }
    });
    const tree = SetColorModal({ id: "user", modalProps: {} });
    assert.equal(initialColor, 0);
    tree.props.children[0].props.children[0].props.children[1].props.onChange(null);
    assert.equal(initialColor, 372735);
    SetColorModal({ id: "missing", modalProps: {} });
    assert.equal(initialColor, 372735);
});

test("sound imports validate all overrides before replacing settings", () => {
    const soundTypes = [{ id: "message1", name: "Message" }, { id: "mute", name: "Mute" }];
    const makeEmptyOverride = () => ({ enabled: false, selectedSound: "default", volume: 100, useFile: false });
    const store: Record<string, string> = { message1: "original message", mute: "original mute" };
    const { importOverrides } = loadSource("src/equicordplugins/customSounds/index.tsx", {
        "@api/DataStore": {},
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/Button": {}, "@components/Heading": {},
        "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, StartAt: {} },
        "@webpack/common": {}, "./audioStore": {}, "./SoundOverrideComponent": {},
        "./types": { soundTypes, makeEmptyOverride, seasonalSounds: {} }
    }, {}, "({ importOverrides })");
    const original = { ...store };
    for (const text of ["{", "null", "{}", '{"overrides":[null]}', ...[
        { id: "unknown" }, { id: "__proto__" }, { id: "mute", volume: -1 },
        { id: "mute", volume: 101 }, { id: "mute", enabled: "yes" },
        { id: "mute", selectedSound: "constructor" }, { id: "mute", selectedFileId: {} }
    ].map(invalid => JSON.stringify({ overrides: [{ id: "message1", enabled: true }, invalid] }))]) {
        assert.throws(() => importOverrides(text));
        assert.deepEqual(store, original);
    }
    importOverrides(JSON.stringify({ overrides: [{ id: "message1", enabled: true, volume: 0 }] }));
    assert.deepEqual(JSON.parse(store.message1), { enabled: true, selectedSound: "default", volume: 0, useFile: false });
    assert.deepEqual(JSON.parse(store.mute), makeEmptyOverride());
    importOverrides('{"overrides":[]}');
    assert.deepEqual(JSON.parse(store.message1), makeEmptyOverride());
});

test("folder icon rendering handles unset entries and uses the shared error boundary", () => {
    const settings: { store: { folderIcons?: Record<string, { url: string; size?: number; } | null>; solidIcon: boolean; } } = {
        store: { solidIcon: false }
    };
    let boundaryOptions: unknown;
    const { default: plugin } = loadComponent("src/equicordplugins/customFolderIcons/index.tsx", {}, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown, options: unknown) => {
            boundaryOptions = options;
            return component;
        } } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "./components": {}, "./settings": { settings },
        "./util": { int2rgba: (_color: number, alpha: number) => String(alpha) }
    });
    assert.equal((boundaryOptions as { noop: boolean }).noop, true);
    const props = { folderNode: { id: "folder", color: 0 } };
    const unsetEntries: Array<typeof settings.store.folderIcons> = [undefined, {}, { folder: null }];
    for (const folderIcons of unsetEntries) {
        settings.store.folderIcons = folderIcons;
        assert.equal(plugin.shouldReplace(props), false);
        assert.equal(plugin.replace(props), null);
    }
    settings.store.folderIcons = { folder: { url: "https://fixture.invalid/icon.png", size: 175 } };
    assert.equal(plugin.shouldReplace(props), true);
    let tree = plugin.replace(props);
    assert.equal(tree.props.children[0].props.src, "https://fixture.invalid/icon.png");
    assert.equal(tree.props.children[0].props.width, "175%");
    assert.equal(tree.props.style.backgroundColor, "0.4");
    settings.store.solidIcon = true;
    settings.store.folderIcons = { folder: { url: "https://fixture.invalid/icon.png" } };
    tree = plugin.replace(props);
    assert.equal(tree.props.children[0].props.width, "100%");
    assert.equal(tree.props.style.backgroundColor, "1");
});

test("folder icon editing preserves saved size and resetting an unused folder is safe", () => {
    const settings: { store: { folderIcons?: Record<string, { url: string; size: number; }> } } = {
        store: { folderIcons: { folder: { url: "https://fixture.invalid/icon.png", size: 175 } } }
    };
    let closes = 0;
    const { ImageModal } = loadComponent("src/equicordplugins/customFolderIcons/components.tsx", {
        useState: (initial: unknown) => [initial, () => {}],
        Button: "button", Slider: "slider", closeModal: () => closes++
    }, {
        "./settings": { settings },
        "@utils/types": { makeRange: (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i) },
        "./util": {}
    });
    const props = { folderId: "folder", folderColor: 0 };
    const tree = ImageModal(props);
    const buttons = tree.props.children.filter((node: { type?: string }) => node?.type === "button");
    buttons[0].props.onClick();
    assert.equal(settings.store.folderIcons?.folder.size, 175);
    settings.store.folderIcons = undefined;
    const empty = ImageModal(props);
    empty.props.children.filter((node: { type?: string }) => node?.type === "button")[1].props.onClick();
    assert.equal(closes, 2);
    empty.props.children.filter((node: { type?: string }) => node?.type === "button")[0].props.onClick();
    const readFolderSize = () => settings.store.folderIcons?.folder.size;
    assert.equal(readFolderSize(), 100);
    assert.equal(closes, 3);
});

test("content warnings are blurred before the first hover", () => {
    const TriggerContainer = loadSource("src/equicordplugins/contentWarning/index.tsx", {
        "@api/index": {},
        "@api/Settings": { definePluginSettings: () => ({ store: { onClick: false } }) },
        "@components/Flex": {}, "@components/Heading": {}, "@components/Icons": {},
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/react": {}, "@utils/text": { escapeRegExp: RegExp.escape },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { useState: () => [false, () => {}] }
    }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) } }, "TriggerContainer");
    const element = TriggerContainer({ child: "flagged content" });
    assert.equal(element.props.className, "vc-content-warning-container");
    const target = { className: element.props.className };
    element.props.onMouseEnter({ currentTarget: target });
    assert.equal(target.className, "vc-content-warning-enter");
    element.props.onMouseLeave({ currentTarget: target });
    assert.equal(target.className, "vc-content-warning-leave");
});

test("command palette forms prevent duplicate submissions before rendering", async () => {
    const { FormPage } = loadComponent("src/equicordplugins/commandPalette/ui/pages/FormPage.tsx", {
        useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
        useRef: (current: unknown) => ({ current }),
        useEffect() {},
        useLayoutEffect: (effect: () => void) => effect(),
        useMemo: (factory: () => unknown) => factory()
    }, { "../markdownPaste": {}, "../MessageMarkdownPreview": {}, "../PaletteIcon": {} });
    let submissions = 0;
    let finish = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const formRef = { current: { submit() {} } };
    FormPage({
        spec: { fields: [], submit: () => { submissions++; return pending; } },
        ctx: {}, formRef
    });
    formRef.current.submit();
    formRef.current.submit();
    assert.equal(submissions, 1);
    finish();
    await pending;
    await setImmediate();
    formRef.current.submit();
    assert.equal(submissions, 2);
});

test("command palette leaves composition keys to the input method", () => {
    const keyboard = loadSource("src/equicordplugins/commandPalette/ui/keyboard.ts", {
        "@utils/constants": { IS_MAC: false }
    }, {}, "({ ...exports, handleKeyDown, handleKeyUp })");
    let actions = 0;
    keyboard.setPaletteKeyHandler(() => { actions++; return true; });
    const event = {
        key: "Enter", isComposing: true,
        preventDefault: () => assert.fail("Composition was prevented"),
        stopImmediatePropagation: () => assert.fail("Composition was intercepted")
    };
    keyboard.handleKeyDown(event);
    keyboard.handleKeyUp(event);
    assert.equal(keyboard.comboFromEvent(event), null);
    assert.equal(actions, 0);
    keyboard.handleKeyDown({ ...event, isComposing: false, preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(actions, 1);
    const shouldSubmit = loadSource("src/equicordplugins/commandPalette/ui/pages/FormPage.tsx", {
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": {},
        "../markdownPaste": {},
        "../MessageMarkdownPreview": {},
        "../PaletteIcon": {}
    }, {}, "shouldSubmitOnEnter");
    assert.equal(shouldSubmit({ key: "Enter", nativeEvent: { isComposing: true } }), false);
    assert.equal(shouldSubmit({ key: "Enter", nativeEvent: { isComposing: false } }), true);
});

test("moving a bookmark into a later folder preserves the bookmark", () => {
    const bookmark = { channelId: "channel", guildId: "guild", name: "Bookmark" };
    const folder = { name: "Folder", bookmarks: [] as typeof bookmark[] };
    const bookmarks: (typeof bookmark | typeof folder)[] = [bookmark, folder];
    let drop: (item: object, monitor: object) => void = () => assert.fail("Folder drop handler was not registered");
    const React = { createElement() {} };
    const Bookmark = loadSource("src/equicordplugins/channelTabs/components/BookmarkContainer.tsx", {
        "@components/BaseText": {},
        "@equicordplugins/channelTabs/util": { isBookmarkFolder: (value: object) => "bookmarks" in value, settings: { store: {}, use: () => ({}) } },
        "@equicordplugins/channelTabs/util/icons": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
        "@utils/misc": { classes: () => "" }, "@webpack": { findComponentByCodeLazy: () => null },
        "./ChannelTab": {}, "./ContextMenus": {},
        "@webpack/common": {
            React, useRef: () => ({ current: null }), useState: (value: unknown) => [value, () => {}], useEffect() {},
            useDrag: () => [{}, (ref: unknown) => ref],
            useDrop: (create: () => { drop?: typeof drop; }) => { const spec = create(); if (spec.drop) drop = spec.drop; return [{}, (ref: unknown) => ref]; }
        }
    }, { React }, "Bookmark");
    Bookmark({ bookmarks, index: 1, methods: {
        deleteBookmark: (index: number) => bookmarks.splice(index, 1),
        addBookmark(value: typeof bookmark, index: number) {
            const target = bookmarks[index];
            assert.ok(target && "bookmarks" in target);
            target.bookmarks.push(value);
        }
    } });
    drop({ bookmark, index: 0, isFromFolder: false }, { getItemType: () => "vc_Bookmark" });
    assert.deepEqual(bookmarks, [folder]);
    assert.deepEqual(folder.bookmarks, [bookmark]);
});

test("channel tab limits preserve foreground and background opening behavior", () => {
    const navigations: string[] = [];
    const tabs = loadSource("src/equicordplugins/channelTabs/util/tabs.tsx", {
        "@api/index": {}, "@api/PluginManager": {},
        "@utils/css": { classNameFactory: () => () => "" },
        "./constants": { logger: { warn() {}, error() {} }, settings: { store: { maxOpenTabs: 1 } } },
        "@webpack/common": {
            NavigationRouter: { transitionToGuild: (_guildId: string, channelId: string) => navigations.push(channelId) },
            SelectedChannelStore: { getChannelId: () => "initial" }, SelectedGuildStore: { getGuildId: () => "guild" }
        }
    }, { setTimeout: () => 0, clearTimeout() {} });
    tabs.setUpdaterFunction(() => {});
    tabs.createTab({ guildId: "guild", channelId: "initial" }, false);
    tabs.setOpenTab(tabs.openedTabs[0].id);
    tabs.createTab({ guildId: "guild", channelId: "foreground" }, true);
    assert.deepEqual(navigations, ["foreground"]);
    tabs.createTab({ guildId: "guild", channelId: "background" }, false);
    assert.deepEqual(navigations, ["foreground"]);
    assert.equal(tabs.openedTabs.length, 1);
    assert.equal(tabs.openedTabs[0].channelId, "background");
});

test("channel tab animation selection can clear all and replace multiple choices", () => {
    let onChange: (values: (string | { value: string; })[]) => void = () => assert.fail("Selector was not rendered");
    const previousSettings = { animationQuestsActive: true, animationHover: true };
    let saves = 0;
    const { AnimationSettings, settings } = loadSource("src/equicordplugins/channelTabs/util/constants.tsx", {
        "@api/Settings": { PlainSettings: { plugins: { ChannelTabs: previousSettings } }, SettingsStore: { markAsChanged: () => saves++ }, definePluginSettings: (definitions: Record<string, { default?: unknown; }>) => ({ store: Object.fromEntries(Object.entries(definitions).map(([key, option]) => [key, option.default])) }) },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@equicordplugins/channelTabs/components/ChannelTabsContainer": {},
        "@equicordplugins/channelTabs/components/KeybindSettings": {},
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { makeRange: () => [], OptionType: {} },
        "@webpack/common": { SearchableSelect: "select", useState: (initial: unknown) => [initial, () => {}] }
    }, { React: { createElement(type: string, props: { onChange: typeof onChange; }) { if (type === "select") onChange = props.onChange; } } }, "({ AnimationSettings, settings: exports.settings })");
    assert.equal("animationQuestsActive" in previousSettings, false);
    assert.equal(previousSettings.animationHover, true);
    assert.equal(saves, 1);
    AnimationSettings();
    onChange([]);
    const enabled = () => Object.keys(settings.store).filter(key => key.startsWith("animation") && settings.store[key] === true).sort();
    assert.deepEqual(enabled(), []);
    onChange(["hover", { value: "selection" }]);
    assert.deepEqual(enabled(), ["animationHover", "animationSelection"]);
});

test("status bypass checks the message channel without creating DMs", async () => {
    const notifications: object[] = [];
    const errors: unknown[] = [];
    let createdDms = 0;
    let mentioned = false;
    const store = { guilds: "", channels: "", users: "123456789012345678", statusToUse: "dnd", allowOutsideOfDms: false, respectSilentPings: true, notificationSound: false };
    const { default: plugin } = loadSource("src/equicordplugins/bypassStatus/index.tsx", {
        "@api/AudioPlayer": {},
        "@api/index": { Notifications: { showNotification: (notification: object) => { notifications.push(notification); } } },
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { Devs: {} }, "@utils/discord": { getCurrentChannel: () => null },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {
            ChannelActionCreators: { getOrEnsurePrivateChannel: async () => { createdDms++; return "dm"; } },
            ChannelStore: { getChannel: (id: string) => ({ name: id, isDM: () => id === "dm" }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: () => undefined },
            PresenceStore: { getStatus: () => "dnd" }, MessageStore: { getMessage: () => ({ mentioned }) },
            WindowStore: { isFocused: () => false }
        }
    });
    plugin.start();
    const dispatch = (channelId: string, flags = 0) => plugin.flux.MESSAGE_CREATE({
        channelId, guildId: channelId === "dm" ? undefined : "guild",
        message: { id: "message", channel_id: channelId, content: "hello", flags, author: { id: store.users, username: "author" } }
    });
    await dispatch("guild-channel");
    assert.equal(notifications.length, 0);
    await dispatch("dm");
    assert.equal(notifications.length, 1);
    store.allowOutsideOfDms = true;
    mentioned = true;
    await dispatch("guild-channel");
    assert.equal(notifications.length, 2);
    await dispatch("dm", 1 << 12);
    assert.equal(notifications.length, 2);
    assert.equal(createdDms, 0);
    assert.deepEqual(errors, []);
});

test("audio downloads finishing after unmount do not allocate object URLs", async () => {
    const effects: (() => () => void)[] = [];
    const canvas = { getContext: () => null };
    let firstRef = true;
    const React = {
        createElement() {},
        useRef(value: unknown) {
            const current = firstRef ? canvas : value;
            firstRef = false;
            return { current };
        },
        useEffect(effect: () => () => void) { effects.push(effect); }
    };
    let finishDownload: (response: Response) => void = () => assert.fail("Download did not start");
    let allocated = 0;
    const Visualizer = loadSource("src/equicordplugins/betterAudioPlayer/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React }
    }, {
        URL: class extends URL { static createObjectURL() { allocated++; return "blob:fixture"; } },
        fetch: (url: string) => {
            assert.equal(url, "https://fixture.invalid/audio?signature=original");
            return new Promise<Response>(resolve => { finishDownload = resolve; });
        },
        cancelAnimationFrame() {}
    }, "Visualizer");
    Visualizer({ playerRef: { current: { addEventListener() {}, removeEventListener() {} } }, src: "https://fixture.invalid/audio?signature=original" });
    const cleanup = effects[0]();
    cleanup();
    finishDownload(new Response("audio"));
    await setImmediate();
    assert.equal(allocated, 0);
});

test("Base64 decoding returns Unicode text and skips invalid encodings", () => {
    const decode = loadSource("src/equicordplugins/baseDecoder/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/CodeBlock": {}, "@components/ErrorBoundary": {}, "@components/Heading": {},
        "@utils/constants": { EquicordDevs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}
    }, { atob, TextDecoder, console: { error() {} } }, "decodeBase64Strings");
    const text = "Hello, café 😀";
    assert.deepEqual(Array.from(decode([Buffer.from(text).toString("base64"), "/w==", "%%%"])), [text]);
});

function decorFixture() {
    const scheduled = new Map<() => Promise<void>, number>();
    const requests: { ids: string[]; signal?: AbortSignal; resolve: (result: Record<string, string | null>) => void; reject: (error: Error) => void; }[] = [];
    const errors: unknown[] = [];
    const clock = { now: 1_000 };
    const module = loadComponent("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal?: AbortSignal) => new Promise<Record<string, string | null>>((resolve, reject) => requests.push({ ids, signal, resolve, reject })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 10_000, SKU_ID: "decor" },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }, {
        AbortController, Date: class extends Date { static now() { return clock.now; } },
        setTimeout(callback: () => Promise<void>, delay: number) {
            scheduled.set(callback, clock.now + delay);
            return callback;
        },
        clearTimeout(callback: () => Promise<void>) { scheduled.delete(callback); }
    });
    const store = module.useUsersDecorationsStore;
    function flush() {
        const callback = scheduled.keys().next().value;
        assert.ok(callback);
        scheduled.delete(callback);
        return callback();
    }
    function advance(milliseconds: number) {
        clock.now += milliseconds;
        const work: Promise<void>[] = [];
        for (const [callback, due] of scheduled) {
            if (due <= clock.now) {
                scheduled.delete(callback);
                work.push(callback());
            }
        }
        return work;
    }
    return { store, requests, scheduled, flush, advance, errors, clock };
}

test("folder zipping drains directory batches and rejects read and size failures", { timeout: 1000 }, async () => {
    const readDirectory = loadSource("src/equicordplugins/autoZipper/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { extensions: "" } }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": {}, fflate: {}
    }, {}, "readDirectoryEntry");
    const directory = (name: string, batches: object[][]) => ({
        name, isDirectory: true,
        createReader: () => ({ readEntries: (resolve: (entries: object[]) => void) => resolve(batches.shift() ?? []) })
    });
    const file = (name: string, size = 1, fail = false) => ({
        name, isFile: true,
        file: (resolve: (value: object) => void, reject: (error: Error) => void) => fail
            ? reject(new Error("Read failed"))
            : resolve({ size, arrayBuffer: async () => new Uint8Array([7]).buffer })
    });
    const files = await readDirectory(directory("root", [[file("a")], [directory("nested", [[file("b")]])]]));
    assert.deepEqual(Object.keys(files), ["a", "nested/b"]);
    assert.deepEqual(Array.from(files["nested/b"]), [7]);
    await assert.rejects(readDirectory(directory("root", [[file("bad", 1, true)]])), /Read failed/);
    await assert.rejects(readDirectory(directory("root", [[file("large", 100 * 1024 * 1024 + 1)]])), /too large/);
    await assert.rejects(readDirectory(directory("root", [Array.from({ length: 501 }, (_, i) => file(String(i)))])), /more than 500/);
});

test("random mentions use the destination channel and preserve text when no members are loaded", () => {
    const plugin = loadComponent("src/equicordplugins/atSomeone/index.ts", {
        ChannelStore: { getChannel: (id: string) => ({
            guild: { guild_id: "destination" }, dm: { recipients: ["recipient"] }, empty: { guild_id: "empty" }
        })[id] },
        GuildMemberStore: { getMembers: (id: string) => id === "destination" ? [{ userId: "member" }] : [] }
    }, {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    assert.equal(plugin.start, undefined);
    for (const [channel, expected] of [["guild", "<@member> <@member>"], ["dm", "<@recipient> <@recipient>"], ["empty", "@someone @someone"], ["missing", "@someone @someone"]]) {
        const message = { content: "@someone @someone" };
        plugin.onBeforeMessageSend(channel, message);
        assert.equal(message.content, expected);
    }
});

test("clip file reads share the size cap and selected files reuse the byte writer", async () => {
    const footer = Buffer.from([0x75, 0x75, 0x69, 0x64, 0xA1, 0xC8, 0x52, 0x99, 0x33, 0x46, 0x4D, 0xB8, 0x88, 0xF0, 0x83, 0xF5, 0x7A, 0x75, 0xA5, 0xEF]);
    const payload = Buffer.concat([Buffer.from([1, 2, 3]), footer, Buffer.from('{"applicationName":"Fixture"}')]);
    let oversized = false;
    let id = 0;
    let reads = 0;
    const writes: Buffer[] = [];
    const native = loadComponent("src/equicordplugins/clipUpload.desktop/native.ts", {}, {
        "@main/ipcMain": { ensureSafePath: () => true },
        "@main/utils/constants": { DATA_DIR: "fixture" },
        crypto: { randomUUID: () => String(++id) },
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["clip.mp4"], canceled: false }) } },
        fs: { createReadStream: (_path: string, options: { end: number; }) => {
            assert.equal(options.end, 500 * 1024 * 1024);
            reads++;
            return Readable.from([payload]);
        } },
        "fs/promises": { mkdir: async () => {}, writeFile: async (_path: string, data: Buffer) => { writes.push(data); } },
        path,
        "stream/consumers": { buffer: async (stream: Readable) => oversized ? { length: 500 * 1024 * 1024 + 1 } : buffer(stream) }
    }, { Buffer, Uint8Array });
    const picked = await native.chooseVideoFile({});
    const metadata = await native.parseClipFileMetadata({}, picked.token);
    assert.equal(metadata[0].applicationName, "Fixture");
    const temp = await native.createTempVideoFile({}, picked.token);
    assert.equal(typeof temp, "string");
    assert.deepEqual(Array.from(writes[0]), [1, 2, 3]);
    assert.deepEqual(Array.from(await native.readVideoFile({}, temp)), Array.from(payload));
    oversized = true;
    const large = await native.chooseVideoFile({});
    assert.equal(await native.parseClipFileMetadata({}, large.token), null);
    assert.equal(await native.createTempVideoFile({}, large.token), null);
    assert.equal(await native.readVideoFile({}, temp), null);
    assert.equal(writes.length, 1);
    assert.equal(reads, 6);
});

test("favourite attachment downloads validate IPC input and bound network responses", async () => {
    let requests = 0;
    let cancelled = 0;
    let mode = "success";
    const { fetchAttachment } = loadComponent("src/equicordplugins/favouriteAnything/native.ts", {}, {}, {
        URL, Buffer, AbortSignal,
        fetch: async (_url: URL, options: RequestInit) => {
            requests++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            if (mode === "network") throw new Error("Private path or network details");
            let read = false;
            return {
                ok: true,
                headers: { get: (name: string) => name === "content-length" ? (mode === "header" ? "524288001" : null) : "text/plain" },
                body: {
                    cancel: async () => { cancelled++; },
                    getReader: () => ({
                        read: async () => {
                            if (read) return { done: true };
                            read = true;
                            return { done: false, value: mode === "stream" ? { byteLength: 524288001 } : new Uint8Array([1, 2, 3]) };
                        },
                        cancel: async () => { cancelled++; },
                        releaseLock() {}
                    })
                }
            };
        }
    });
    const attachment = { filename: "file.txt", url: "https://cdn.discordapp.com/attachments/file.txt" };
    for (const invalid of [null, {}, { ...attachment, filename: 1 }, ...["http://cdn.discordapp.com/file", "https://cdn.discordapp.com:444/file", "https://user@cdn.discordapp.com/file", "https://example.com/file"].map(url => ({ ...attachment, url }))]) {
        const result = await fetchAttachment({}, invalid);
        assert.equal(result.success, false);
    }
    assert.equal(requests, 0);
    const success = await fetchAttachment({}, attachment);
    assert.equal(success.success, true);
    assert.deepEqual(Array.from(success.data), [1, 2, 3]);
    assert.equal(success.filename, "file.txt");
    assert.equal(success.type, "text/plain");
    for (mode of ["header", "stream", "network"]) {
        const result = await fetchAttachment({}, attachment);
        assert.equal(result.success, false);
        assert.equal(result.error.includes("Private"), false);
    }
    assert.equal(cancelled, 2);
});

test("favourite attachment base64url encoding preserves bytes and rejects malformed input", () => {
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/favouriteAnything/polyfills.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { encode, decode } = runInNewContext(`Uint8Array.fromBase64 = undefined; Uint8Array.prototype.toBase64 = undefined;\n${outputText}\n({ encode: bytes => uint8ArrayToBase64(new Uint8Array(bytes)), decode: base64ToUint8Array });`, {
        exports: {}, atob, btoa
    });
    for (let length = 0; length < 260; length++) {
        const bytes = Array.from({ length }, (_, index) => (index * 37 + length) % 256);
        const expected = Buffer.from(bytes).toString("base64url");
        assert.equal(encode(bytes), expected);
        assert.deepEqual(Array.from(decode(expected)), bytes);
    }
    assert.deepEqual(Array.from(decode(" A Q I =\r\n")), [1, 2]);
    assert.deepEqual(Array.from(decode("AQ==")), [1]);
    for (const invalid of ["A", "A=", "AQ=", "AQ===", "AQ=A", "AAAA=", "+w", "/w", "AA!", "AA\u00a0"])
        assert.throws(() => decode(invalid), invalid);
});

test("linked message previews reject neighboring messages returned by an around lookup", async () => {
    const source = readFileSync("src/plugins/messageLinkEmbeds/index.tsx", "utf8");
    const code = transpileModule(source.slice(source.indexOf("async function fetchMessage("), source.indexOf("function getImages(")), {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText;
    for (const id of ["neighbor", "requested"]) {
        const message = { id, channel_id: "channel" };
        let stored = 0;
        const cache = new Map();
        const fetchMessage = runInNewContext(`${code}\nfetchMessage;`, {
            messageCache: cache,
            setMessageCache: (key: string, value: unknown) => cache.set(key, value),
            RestAPI: { get: async () => ({ body: [message] }) },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } },
            MessageStore: { getMessages: () => ({ receiveMessage: () => { stored++; return { get: () => message }; } }) }
        });
        assert.equal(await fetchMessage("channel", "requested"), id === "requested" ? message : undefined);
        assert.equal(stored, id === "requested" ? 1 : 0);
    }
});

test("queued task failures are reported without interrupting ordered work", async () => {
    const errors: unknown[][] = [];
    const { Queue } = loadComponent("src/utils/Queue.ts", {}, {
        "./Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    });
    const queue = new Queue(2);
    const calls: string[] = [];
    queue.push(() => { calls.push("first"); throw new Error("Synchronous failure"); });
    queue.push(() => calls.push("discarded"));
    queue.unshift(async () => { calls.push("urgent"); throw new Error("Asynchronous failure"); });
    queue.unshift(() => calls.push("newest"));
    await setImmediate();
    assert.deepEqual(calls, ["first", "newest", "urgent"]);
    assert.equal(errors.length, 2);
    assert.equal(queue.size, 0);
    queue.push(() => calls.push("resumed"));
    await setImmediate();
    assert.equal(calls.at(-1), "resumed");
});

test("audio player preserves zero volume and clamps explicit values", () => {
    const plugin = loadComponent("src/equicordplugins/_api/audioPlayer.ts", {}, {
        "@api/AudioPlayer": { audioProcessorFunctions: {}, AudioType: {}, identifyAudioType: () => "url" },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }, { structuredClone }).default;
    for (const [volume, internalVolume, expected] of [
        [0, null, 0], [undefined, 0, 0], [undefined, undefined, 1],
        [50, null, 0.5], [100, 0.25, 0.25], [-10, null, 0], [200, null, 1]
    ] as const) {
        const player = { _volume: -1, destroyAudio() {} };
        plugin.buildPlayer(player, { volume }, "https://example.com/sound.mp3", null, internalVolume, "default");
        assert.equal(player._volume, expected);
    }
});

test("Decor continuous arrivals cannot postpone the first batch and stopped timers cannot fetch", async () => {
    const f = decorFixture();
    f.store.getState().start();
    f.store.getState().fetch("a");
    f.advance(100); f.store.getState().fetch("b");
    f.advance(100); f.store.getState().fetch("c");
    assert.equal(f.requests.length, 0);
    const first = f.advance(100);
    assert.equal(f.requests.length, 1);
    assert.deepEqual([...f.requests[0].ids], ["a", "b", "c"]);
    f.store.getState().fetch("d");
    f.advance(299);
    assert.equal(f.requests.length, 1);
    const second = f.advance(1);
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ d: "new" }); await Promise.all(second);
    f.requests[0].resolve({ a: null, b: "b", c: null }); await Promise.all(first);
    assert.equal(f.store.getState().usersDecorations.get("d").asset, "new");
    f.store.getState().fetch("cancelled");
    f.store.getState().stop();
    await Promise.all(f.advance(300));
    assert.equal(f.requests.length, 2);
    f.store.getState().start(); f.store.getState().fetch("restarted");
    const restarted = f.advance(300);
    assert.equal(f.requests.length, 3);
    f.requests[2].resolve({ restarted: null }); await Promise.all(restarted);
});

test("Decor lookups preserve newer local and unrelated decoration updates", async () => {
    const { store, requests, flush } = decorFixture();
    store.getState().start?.();
    store.getState().fetch("a");
    const first = flush();
    store.getState().set("a", "local");
    store.getState().fetch("b");
    const second = flush();
    requests[1].resolve({ b: "remote-b" }); await second;
    requests[0].resolve({ a: "old-a" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "local");
    assert.equal(store.getState().usersDecorations.get("b").asset, "remote-b");
});

test("Decor lookups deduplicate pending IDs and prefer the latest forced request", async () => {
    const { store, requests, scheduled, flush } = decorFixture();
    store.getState().start();
    store.getState().fetch("a"); store.getState().fetch("a");
    const first = flush();
    assert.deepEqual([...requests[0].ids], ["a"]);
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0);
    store.getState().fetch("a", true);
    const second = flush();
    requests[1].resolve({ a: "new" }); await second;
    requests[0].resolve({ a: "old" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "new");
});

test("Decor stop cancels queued requests and old failures cannot erase restarted work", async () => {
    const { store, requests, scheduled, flush, errors } = decorFixture();
    store.getState().fetch("inactive");
    assert.equal(scheduled.size, 0);
    store.getState().start(); store.getState().fetch("a");
    const old = flush();
    store.getState().fetch("queued"); store.getState().stop();
    assert.equal(scheduled.size, 0);
    assert.equal(requests[0].signal?.aborted, true);
    store.getState().start(); store.getState().fetch("a");
    const current = flush();
    requests[0].reject(new Error("Old failure")); await old;
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0, "the old cleanup must preserve the new in-flight marker");
    requests[1].resolve({ a: "current" }); await current;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    store.getState().fetch("a", true); const failed = flush();
    requests[2].reject(new Error("Retryable failure")); await failed;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    assert.equal(errors.length, 1);
    store.getState().fetch("a", true); const retry = flush();
    store.getState().stop(); requests[3].resolve({ a: "late" }); await retry;
    assert.equal(store.getState().usersDecorations.size, 0);
});

test("Decor cached absence expires and expired entries are released", async () => {
    const { store, requests, scheduled, flush, clock } = decorFixture();
    store.getState().start(); store.getState().fetch("a");
    const first = flush(); requests[0].resolve({ a: null }); await first;
    store.getState().fetch("a"); assert.equal(scheduled.size, 0);
    clock.now += 10_000;
    store.getState().fetch("b"); const second = flush(); requests[1].resolve({ b: "b" }); await second;
    assert.equal(store.getState().usersDecorations.has("a"), false);
    store.getState().fetch("a"); assert.equal(scheduled.size, 1);
    store.getState().stop();
});

test("Decor public lookups check HTTP and response shapes and never request the entire user list", async () => {
    const requests: { url: string; signal?: AbortSignal; }[] = [];
    const response: { ok: boolean; body: unknown; } = { ok: true, body: { a: "asset", b: null, unrelated: "ignored" } };
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": { API_URL: "https://decor.invalid/api" },
        "./stores/AuthorizationStore": {},
        "./utils/decoration": {},
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    }, { URL, fetch: async (url: URL, options: { signal?: AbortSignal; }) => {
        requests.push({ url: String(url), signal: options.signal });
        return { ok: response.ok, json: async () => response.body };
    } });
    assert.deepEqual(structuredClone(await api.getUsersDecorations([])), {});
    assert.equal(requests.length, 0);
    const controller = new AbortController();
    assert.deepEqual(structuredClone(await api.getUsersDecorations(["a", "b", "missing"], controller.signal)), { a: "asset", b: null, missing: null });
    assert.equal(requests[0].signal, controller.signal);
    assert.deepEqual(JSON.parse(new URL(requests[0].url).searchParams.get("ids") ?? "null"), ["a", "b", "missing"]);
    response.ok = false; await assert.rejects(api.getUsersDecorations(["a"]), /Could not load/);
    response.ok = true;
    for (const body of [null, [], { a: 123 }, { a: {} }]) {
        response.body = body; await assert.rejects(api.getUsersDecorations(["a"]), /Invalid decoration response/);
    }
});

test("Decor lifecycle keeps initialization and connection work obsolete after logout or stop", async () => {
    const { store, scheduled } = decorFixture();
    const pending: ((configured: boolean) => void)[] = [];
    const account = { id: "first", clears: 0, authInits: 0 };
    const authorizationListeners = new Set<(state: object, previous: object) => void>();
    const plugin = loadComponent("src/plugins/decor/index.tsx", { UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined } }, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { setBaseUrl: () => new Promise<boolean>(resolve => pending.push(resolve)), cancelConfiguration: () => undefined },
        "./lib/stores/AuthorizationStore": { useAuthorizationStore: {
            getState: () => ({ init: () => account.authInits++, clear: () => undefined }),
            subscribe(listener: (state: object, previous: object) => void) {
                authorizationListeners.add(listener);
                return () => authorizationListeners.delete(listener);
            }
        } },
        "./lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: { getState: () => ({ clear: () => account.clears++ }) } },
        "./lib/stores/UsersDecorationsStore": { useUsersDecorationsStore: store },
        "./settings": { settings: { store: { baseUrl: "https://decor.invalid" } } },
        "./ui/components": {}, "./ui/components/DecorSection": {}
    }).default;
    const first = plugin.start();
    plugin.stop(); pending.shift()?.(true); await first;
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    const second = plugin.start();
    const connection = plugin.flux.CONNECTION_OPEN();
    account.id = ""; plugin.flux.LOGOUT(); pending.shift()?.(true); await Promise.all([second, connection]);
    assert.equal(store.getState().session, null);
    account.id = "second"; await plugin.flux.CONNECTION_OPEN();
    assert.equal(typeof store.getState().session, "symbol");
    assert.equal(scheduled.size, 1);
    plugin.stop(); await plugin.flux.CONNECTION_OPEN();
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    assert.ok(account.clears >= 4);
    assert.equal(account.authInits, 2);
    plugin.stop();
});

function loadShortcuts() {
    const state = { resolutions: 0, opens: 0, roots: 0, unmounts: 0, renders: [] as unknown[], blocked: false, failRoot: false };
    const module = Object.freeze({ value: "lazy module", nested: Object.freeze({ value: 1 }) });
    const lazy = proxyLazy(() => { state.resolutions++; return module; });
    const modules: Record<string, unknown>[] = [];
    const fluxStores = new Map<string, object>();
    const popups: ReturnType<typeof makePopup>[] = [];
    function makePopup() {
        let pagehide: (() => void) | undefined;
        return {
            closed: false, closes: 0, focus() {},
            document: {
                head: { append() {} },
                body: { style: {}, appendChild: (element: object) => element },
                createElement: () => ({})
            },
            addEventListener(event: string, callback: () => void) { assert.equal(event, "pagehide"); pagehide = callback; },
            close() { this.closes++; this.closed = true; pagehide?.(); },
            leave() { this.closed = true; pagehide?.(); }
        };
    }
    const window = {
        open() {
            state.opens++;
            if (state.blocked) return null;
            const popup = makePopup();
            popups.push(popup);
            return popup;
        }
    };
    const byProps = (...keys: string[]) => (value: Record<string, unknown>) => keys.every(key => Object.hasOwn(value, key));
    const webpack = {
        fluxStores,
        filters: { byProps, byCode: byProps, componentByCode: byProps, byClassNames: byProps },
        findAll: (filter: (value: object) => boolean) => modules.filter(filter),
        findStore: (name: string) => { const store = fluxStores.get(name); if (!store) throw new Error("Missing store"); return store; },
        findModuleId: (code: string) => code === "present" ? 0 : null,
        extract: (id: number) => { assert.equal(id, 0); return "source"; },
        search() {}
    };
    const plugin = loadComponent("src/plugins/consoleShortcuts/index.ts", {
        LazyModule: lazy,
        createRoot: () => {
            if (state.failRoot) throw new Error("Root unavailable");
            state.roots++;
            return { render: (element: unknown) => state.renders.push(element), unmount: () => state.unmounts++ };
        }
    }, {
        "@debug/loadLazyChunks": { loadLazyChunks() { assert.fail("Automatic chunk loading"); } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentChannel: () => null, getCurrentGuild: () => null },
        "@utils/intlHash": { runtimeHashMessageKey() {} },
        "@utils/lazy": { SYM_LAZY_GET },
        "@utils/native": { relaunch() { assert.fail("Unexpected relaunch"); } },
        "@utils/patches": { canonicalizeMatch() {}, canonicalizeReplace() {}, canonicalizeReplacement() {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, StartAt: {} },
        "@webpack": webpack
    }, {
        window, document: { querySelectorAll: () => [] },
        IS_WEB: false, IS_VESKTOP: false, IS_EQUIBOP: false
    }).default;
    return { plugin, window, state, module, modules, fluxStores, popups };
}

test("console aliases resolve lazies only on access without mutating module exports", async () => {
    const { plugin, window, state, module } = loadShortcuts();
    plugin.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.resolutions, 0);
    const shortcuts = Reflect.get(window, "shortcutList");
    assert.equal(Reflect.get(window, "LazyModule"), module);
    assert.equal(shortcuts.LazyModule, module);
    assert.equal(state.resolutions, 1);
    assert.deepEqual(module.nested, { value: 1 });
    plugin.stop();
    assert.equal(Object.hasOwn(window, "LazyModule"), false);
});

test("console aliases restore owned descriptors and preserve collisions and external replacements", () => {
    const { plugin, window } = loadShortcuts();
    const previous = { value: "previous", writable: false, configurable: true, enumerable: false };
    Object.defineProperty(window, "wp", previous);
    Object.defineProperty(window, "find", { value: "reserved", configurable: false });
    const previousList = { value: "previous list", writable: true, configurable: true, enumerable: false };
    Object.defineProperty(window, "shortcutList", previousList);
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    plugin.start();
    assert.equal(Reflect.get(window, "shortcutList"), shortcuts);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(shortcuts.find(() => true), null);
    Object.defineProperty(window, "reload", { value: "external", configurable: true });
    plugin.stop();
    plugin.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "wp"), previous);
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "shortcutList"), previousList);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(Reflect.get(window, "reload"), "external");
    plugin.start();
    plugin.stop();
    assert.equal(Reflect.get(window, "reload"), "external");
});

test("console searches distinguish identical-looking closures and reflect replaced modules and stores", () => {
    const { plugin, window, modules, fluxStores } = loadShortcuts();
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    const first = { id: 1 }, second = { id: 2 };
    modules.push(first, second);
    const byId = (id: number) => (module: { id: number }) => module.id === id;
    assert.equal(String(byId(1)), String(byId(2)));
    assert.equal(shortcuts.find(byId(1)), first);
    assert.equal(shortcuts.find(byId(2)), second);
    const replacement = { id: 1 };
    modules.splice(0, 1, replacement);
    assert.equal(shortcuts.find(byId(1)), replacement);
    assert.equal(shortcuts.findExportedComponent("absent"), undefined);
    assert.equal(shortcuts.wpexs("absent"), null);
    assert.equal(shortcuts.wpexs("present"), "source");
    assert.equal(shortcuts.findStore("Sample"), null);
    assert.equal(shortcuts.Stores.Sample, undefined);
    fluxStores.set("Sample", first);
    assert.equal(shortcuts.Stores.Sample, first);
    assert.equal(shortcuts.findStore("Sample"), first);
    fluxStores.set("Sample", second);
    assert.equal(shortcuts.findStore("Sample"), second);
    assert.equal(shortcuts.Stores.Sample, second);
    plugin.stop();
});

test("console previews report blocked popups and reuse one root until close or stop", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    const component = () => null;
    state.blocked = true;
    assert.throws(() => fakeRender(component), /Could not open/);
    assert.equal(state.roots, 0);
    state.blocked = false;
    fakeRender(component, { value: 1 });
    fakeRender(component, { value: 2 });
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 2);
    popups[0].leave();
    assert.equal(state.unmounts, 1);
    fakeRender(component);
    assert.equal(state.roots, 2);
    plugin.stop();
    plugin.stop();
    assert.equal(state.unmounts, 2);
    assert.equal(popups[1].closed, true);
    assert.equal(popups[1].closes, 1);
});

test("console previews can retry after root creation fails", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    state.failRoot = true;
    assert.throws(() => fakeRender(() => null), /Root unavailable/);
    assert.equal(popups[0].closed, true);
    state.failRoot = false;
    fakeRender(() => null);
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 1);
    plugin.stop();
    assert.equal(state.unmounts, 1);
});

test("member counts subscribe to scalar values and tooltip renders skip channel work", () => {
    const selectors: { select: () => unknown; value: unknown; stores: unknown[]; deps: unknown[]; }[] = [];
    let channelReads = 0;
    let groups = [{ id: "online", count: 3 }, { id: "offline", count: 20 }];
    const module = loadComponent("src/plugins/memberCount/MemberCount.tsx", {
        ChannelStore: { getChannel: () => ({}) },
        GuildMemberCountStore: { getMemberCount: () => 23 },
        PermissionStore: { can: () => true }, PermissionsBits: { VIEW_CHANNEL: 1 },
        VoiceStateStore: { getVoiceStates: () => ({}) }, SelectedChannelStore: {},
        useEffect() {},
        useStateFromStores(stores: unknown[], select: () => unknown, deps: unknown[] = []) {
            const value = select(); selectors.push({ stores, select, value, deps }); return value;
        }
    }, {
        "@utils/discord": { getCurrentChannel: () => { channelReads++; return { id: "channel", guild_id: "guild" }; } },
        "@utils/misc": { isObjectEmpty: (value: object) => Object.keys(value).length === 0 },
        ".": { ChannelMemberStore: { getProps: () => ({ groups }) }, ThreadMemberListStore: { getMemberListSections: () => ({}) }, cl: () => "", numberFormat: String, settings: { use: () => ({ voiceActivity: true }) } },
        "./OnlineMemberCountStore": { OnlineMemberCountStore: { getCount: () => 5 } },
        "./CircleIcon": {}, "./VoiceIcon": {}
    });
    module.MemberCount({});
    assert.equal(selectors[4].value, 3);
    groups = [{ id: "online", count: 3 }, { id: "offline", count: 99 }];
    assert.equal(selectors[4].select(), selectors[4].value);
    assert.deepEqual([...selectors[4].deps], [undefined, "guild", "channel"]);
    selectors.length = 0;
    module.MemberCount({ isTooltip: true, tooltipGuildId: "guild" });
    assert.equal(channelReads, 1);
    assert.equal(selectors[4].value, null);
    assert.equal(selectors[5].value, null);
});

test("APNG failed worker loads terminate and concurrent conversions share the retry", async () => {
    const workers: { loaded: boolean; terminated: boolean; }[] = [];
    let loads = 0;
    const module = loadComponent("src/equicordplugins/fileUpload/utils/apngToGif.ts", {}, {
        "@ffmpeg/ffmpeg": { FFmpeg: class {
            loaded = false;
            terminated = false;
            constructor() { workers.push(this); }
            terminate() { this.terminated = true; }
            async writeFile() {}
            async exec() {}
            async readFile() { return new Uint8Array([1]); }
            async deleteFile() {}
        } },
        "@utils/ffmpeg": { loadFFmpeg: async (worker: { loaded: boolean; }) => { if (++loads === 1) throw new Error("Load failed"); worker.loaded = true; } }
    }, { Blob, console: { error() {} } });
    assert.equal(await module.convertApngToGif(new Blob()), null);
    assert.equal(workers[0].terminated, true);
    const results = await Promise.all([module.convertApngToGif(new Blob()), module.convertApngToGif(new Blob())]);
    assert.equal(loads, 2);
    assert.equal(results.every(result => result instanceof Blob), true);
});

test("DevCompanion replacement closes the old socket and ignores its late events", () => {
    class Socket {
        static OPEN = 1;
        readyState = 1;
        closed = false;
        sent: string[] = [];
        listeners = new Map<string, (event: object) => void>();
        constructor() { sockets.push(this); }
        close() { this.closed = true; this.readyState = 3; }
        send(message: string) { this.sent.push(message); }
        addEventListener(type: string, listener: (event: object) => void) { this.listeners.set(type, listener); }
    }
    const sockets: Socket[] = [];
    const module = loadComponent("src/plugins/devCompanion.dev/initWs.tsx", {
        Toasts: { show() {}, genId: () => "toast", Type: { SUCCESS: 1, FAILURE: 2 }, Position: { TOP: 1 } }
    }, {
        "@api/Settings": {}, "@debug/loadLazyChunks": {}, "@debug/reporterData": {},
        "@utils/discord": {}, "@utils/patches": {}, "@webpack": { wreq: { m: {} } },
        ".": { CLIENT_VERSION: [0, 1, 2], PORT: 8485, settings: { store: {} }, logger: { info() {}, error() {}, debug() {} } },
        "./types": {}, "./types/send": {}, "./util": {}
    }, { WebSocket: Socket, IS_COMPANION_TEST: false });
    module.initWs();
    module.initWs();
    assert.equal(sockets[0].closed, true);
    sockets[0].listeners.get("open")?.({});
    assert.equal(sockets[0].sent.length, 0);
    sockets[1].listeners.get("open")?.({});
    assert.equal(sockets[1].sent.length, 1);
    module.stopWs();
    assert.equal(sockets[1].closed, true);
    sockets[1].listeners.get("message")?.({ data: "invalid" });
    assert.equal(sockets[1].sent.length, 1);
});

test("source fixtures reject recoverable syntax errors before execution", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lawyercord-source-syntax-"));
    const fixture = path.join(directory, "fixture.ts");
    let executed = false;
    try {
        writeFileSync(fixture, "executed(); function broken() { return Math.max(1, 2; }");
        assert.throws(() => loadSource(fixture, {}, { executed: () => { executed = true; } }), /fixture\.ts:.*expected/);
        assert.equal(executed, false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function loadSource(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}, result = "exports") {
    if (path === "src/equicordplugins/userpluginInstaller.dev/native.ts") {
        mocks = { typescript, ...mocks };
        globals = { process: { env: {} }, ...globals };
    }
    const { outputText: code, diagnostics = [] } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    for (const diagnostic of diagnostics) {
        if (diagnostic.category === typescript.DiagnosticCategory.Error)
            assert.fail(`${path}: ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    }
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

function response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
}

function loadGlobalBadges() {
    const store: Record<string, string | boolean> = { apiUrl: "https://fixture.invalid", showModStyle: "none", showAero: true };
    const requests: { url: string; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const errors: unknown[][] = [];
    const intervals = new Map<number, () => Promise<void>>();
    const toasts: { type: string; }[] = [];
    const mocks = {
        "./settings": { settings: { store } },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    };
    const utils = loadSource("src/equicordplugins/globalBadges/utils.ts", mocks, {
        fetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }))
    });
    const { default: plugin } = loadSource("src/equicordplugins/globalBadges/index.tsx", {
        ...mocks,
        "./utils": utils,
        "@api/Badges": { BadgePosition: { START: 0 } },
        "@components/Button": {},
        "@plugins/_api/badges": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { Toasts: { genId: () => "toast", show: (toast: { type: string; }) => toasts.push(toast), Type: { SUCCESS: "success", FAILURE: "failure" } } }
    }, {
        setInterval: (callback: () => Promise<void>) => { intervals.set(1, callback); return 1; },
        clearInterval: (id: number) => intervals.delete(id)
    });
    return { utils, plugin, store, requests, errors, intervals, toasts };
}

test("global badge display settings use existing data and unknown service names remain readable", async () => {
    const { utils, plugin, requests, store } = loadGlobalBadges();
    const pending = utils.loadBadges();
    requests[0].resolve(response({ users: { fixture: [
        { mod: "aero", badge: "aero.png", tooltip: "Contributor" },
        { mod: "newmod", badge: "new.png", tooltip: "Developer" },
        { mod: "vencord", badge: "vencord.png", tooltip: "Donor" },
        { mod: "", badge: "empty.png", tooltip: "Empty" }
    ] } }));
    await pending;
    assert.equal(plugin.getGlobalBadges("fixture").length, 2);
    store.showAero = false;
    store.showModStyle = "prefix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "newmod - Developer");
    assert.equal(plugin.getGlobalBadges("fixture").length, 1);
    store.showAero = true;
    store.showModStyle = "suffix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "Contributor - Aero");
    assert.equal(requests.length, 1);
});

test("global badge loads discard stale responses and stop invalidates pending data", async () => {
    const { utils, plugin, requests, store, intervals } = loadGlobalBadges();
    const first = utils.loadBadges();
    store.apiUrl = "https://new-fixture.invalid/";
    const second = utils.loadBadges();
    assert.equal(requests[1].url, "https://new-fixture.invalid/users");
    requests[1].resolve(response({ users: { current: [] } }));
    await second;
    requests[0].resolve(response({ users: { stale: [] } }));
    await first;
    assert.equal(plugin.getGlobalBadges("current")?.length, 0);
    assert.equal(plugin.getGlobalBadges("stale"), undefined);
    plugin.start();
    assert.equal(intervals.size, 1);
    plugin.stop();
    requests[2].resolve(response({ users: { stopped: [] } }));
    await setImmediate();
    assert.equal(intervals.size, 0);
    assert.equal(plugin.getGlobalBadges("stopped"), undefined);
});

test("global badge refresh retries failures, rejects malformed data and reports manual errors", async () => {
    const { utils, plugin, requests, intervals, errors, toasts } = loadGlobalBadges();
    plugin.start();
    assert.equal(intervals.size, 1);
    requests[0].reject(new Error("offline"));
    await setImmediate();
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0]();
    requests[1].resolve(response({ users: { good: [] } }));
    await retry;
    for (const invalid of [null, {}, { users: [] }, { users: { broken: {} } }, { users: { broken: [null] } }, { users: { broken: [{ mod: "aero", badge: "a.png" }] } }]) {
        const offset = requests.length;
        const pending = utils.refreshBadges();
        requests[offset].resolve(response(invalid));
        await pending;
        assert.equal(plugin.getGlobalBadges("good")?.length, 0);
    }
    const offset = requests.length;
    const manual = plugin.toolboxActions["Refetch Global Badges"]();
    requests[offset].resolve(response({}, 503));
    await manual;
    assert.equal(toasts.at(-1)?.type, "failure");
    plugin.stop();
});

test("chat badge classes stay lazy until rendering and sibling badge keys are unique", () => {
    let ready = false;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { CheckBadge } = loadSource("src/equicordplugins/showBadgesInChat/index.tsx", {
        "@plugins/_api/badges": { __esModule: true, default: {
            getDonorBadges: () => [{ id: "one" }, { id: "two" }], getEquicordDonorBadges: () => [{ id: "one" }, { id: "two" }]
        } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": {
            findComponentByCodeLazy: () => "role-icon",
            findCssClassesLazy: () => new Proxy({}, { get() { assert.equal(ready, true, "Discord classes are unavailable during module initialization"); return "role-icon"; } })
        },
        "./settings": { __esModule: true, default: { store: {} } }
    }, { React }, "({ CheckBadge })");
    ready = true;
    for (const badge of ["EquicordDonor", "VencordDonor", "DiscordProfile"]) {
        const rendered = CheckBadge({ badge, author: { id: "fixture", flags: 3 } });
        const keys = rendered.props.children[0].map((child: { props: { key: string; }; }) => child.props.key);
        assert.equal(keys.length, 2);
        assert.equal(new Set(keys).size, 2);
    }
});

test("animation preferences gate every patch and expose their restart requirement", () => {
    const store: Record<string, boolean> = {};
    const { default: plugin } = loadSource("src/plugins/alwaysAnimate/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } }
    });
    for (const [key, option] of Object.entries(plugin.settings.def) as [string, { restartNeeded?: boolean; }][]) {
        store[key] = false;
        assert.equal(option.restartNeeded, true, key);
    }
    const active = () => plugin.patches.filter((patch: { predicate?(): boolean; }) => !patch.predicate || patch.predicate());
    assert.equal(active().length, 0);
    store.roleGradients = true;
    assert.equal(active().length, 3);
});

test("emoji copy menus keep the real webpack proxy lazy until the Unicode action is used", () => {
    let lookups = 0;
    const copied: string[] = [];
    const plugin = loadComponent("src/plugins/copyEmojiMarkdown/index.tsx", {
        Menu: { MenuGroup: "group", MenuItem: "item" }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: { copyUnicode: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: (text: string) => copied.push(text) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => proxyLazy(() => { lookups++; return { convertNameToSurrogate: () => "🛒" }; }) }
    }).default;
    assert.equal(lookups, 0);
    const children: { props: { children: { props: { action: () => void; }; }[]; }; }[] = [];
    plugin.contextMenus["expression-picker"](children, { target: { dataset: { type: "emoji", name: "cart" } } });
    assert.equal(lookups, 0);
    children[0].props.children[0].props.action();
    assert.equal(lookups, 1);
    assert.deepEqual(copied, ["🛒"]);
});

test("sticker pack metadata updates preserve concurrent packs without holding a storage mutex", async () => {
    const entries = new Map<string, unknown>();
    let updates = 0;
    const module = loadComponent("src/equicordplugins/moreStickers/stickers.ts", {}, {
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": {
            async set(key: string, value: unknown) { entries.set(key, value); },
            async get(key: string) { return entries.get(key); },
            async del(key: string) { entries.delete(key); },
            async update(key: string, change: (value: unknown) => unknown) { updates++; entries.set(key, change(entries.get(key))); },
            async updateMany(changes: [string, (value: unknown) => unknown][]) {
                updates++;
                const pending = changes.map(([key, change]) => [key, change(entries.get(key))] as const);
                for (const [key, value] of pending) entries.set(key, value);
            }
        },
    });
    await Promise.all(["a", "b"].map(id => module.saveStickerPack({ id, title: id.toUpperCase(), logo: { id: "logo", title: "Logo", image: "image", stickerPackId: id }, stickers: [] })));
    assert.equal(updates, 2);
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["a", "b"]);
    await module.deleteStickerPack("a");
    assert.deepEqual(Array.from(await module.getStickerPackMetas(), (pack: { id: string; }) => pack.id), ["b"]);
    const key = "OtherPlugin_settings";
    const original = { enabled: true };
    entries.set(key, original);
    assert.equal(await module.getStickerPack(key), null);
    const imported = { id: key, title: "Imported", logo: { id: "logo", title: "Logo", image: "image", stickerPackId: key }, stickers: [] };
    await module.saveStickerPack(imported);
    assert.equal(entries.get(key), original);
    assert.equal(await module.getStickerPack(key), imported);
    await module.deleteStickerPack(key);
    assert.equal(entries.get(key), original);
    assert.equal(await module.getStickerPack(key), null);
    const legacy = { id: "custom-legacy", title: "Legacy", logo: { id: "logo", title: "Logo", image: "image", stickerPackId: "custom-legacy" }, stickers: [] };
    entries.set(legacy.id, legacy);
    assert.equal(await module.getStickerPack(legacy.id), legacy);
    await module.deleteStickerPack(legacy.id);
    assert.equal(await module.getStickerPack(legacy.id), null);
    assert.equal(entries.get(legacy.id), legacy);
    await module.saveStickerPack(legacy);
    assert.equal(await module.getStickerPack(legacy.id), legacy);
    for (const id of ["pack123", "custom"]) {
        const untitled = Object.freeze({ ...legacy, id, title: "null" });
        await module.saveStickerPack(untitled);
        assert.equal(untitled.title, "null");
        assert.equal((await module.getStickerPack(id)).title, id === "pack123" ? "123" : "custom");
        assert.equal((await module.getStickerPackMetas()).find((meta: { id: string; }) => meta.id === id).title, id === "pack123" ? "123" : "custom");
    }
    for (const malformed of [{ ...legacy, logo: null }, { ...legacy, stickers: [null] }, { ...legacy, id: "other-pack" }]) {
        entries.set(`MoreStickers:PackData:${legacy.id}`, malformed);
        assert.equal(await module.getStickerPack(legacy.id), null);
        assert.equal(entries.get(`MoreStickers:PackData:${legacy.id}`), malformed);
        entries.delete(`MoreStickers:PackData:${legacy.id}`);
        entries.set(legacy.id, malformed);
        assert.equal(await module.getStickerPack(legacy.id), null);
        assert.equal(entries.get(legacy.id), malformed);
    }
    for (const key of ["MoreStickers:Packs", "Vencord-MoreStickers-Packs"]) {
        for (const malformed of [{}, [legacy, null], [{ ...legacy, logo: null }]]) {
            entries.set(key, malformed);
            await assert.rejects(module.getStickerPackMetas(key), /Saved sticker pack metadata is invalid/);
            assert.equal(entries.get(key), malformed);
        }
    }
});

test("v1 sticker migration preserves unchanged IDs and saved packs after cleanup failures", async () => {
    for (const [oldId, newId, failCleanup, missing] of [
        ["custom-pack", "custom-pack", false, false],
        ["Vencord-MoreStickers-Line-Pack-123", "MoreStickers:Line:Pack:123", false, false],
        ["custom-pack", "custom-pack", true, false],
        ["Vencord-MoreStickers-Line-Pack-123", "MoreStickers:Line:Pack:123", true, false],
        ["missing-pack", "missing-pack", false, true]
    ] as const) {
        const pack = { id: oldId, title: "Legacy", logo: { id: "logo", title: "Logo", image: "image", stickerPackId: oldId }, stickers: [{ id: "sticker", title: "Sticker", image: "image", stickerPackId: oldId }] };
        const entries = new Map<string, unknown>([[oldId, pack], ["Vencord-MoreStickers-Packs", [{ id: oldId, title: pack.title, logo: pack.logo }]]]);
        if (missing) entries.delete(oldId);
        let cleanupBlocked = failCleanup;
        const DataStore = {
            async set(key: string, value: unknown) { entries.set(key, value); },
            async get(key: string) { return entries.get(key); },
            async del(key: string) { entries.delete(key); },
            async update(key: string, change: (value: unknown) => unknown) {
                if (cleanupBlocked && key === "Vencord-MoreStickers-Packs") throw new Error("Storage unavailable");
                entries.set(key, change(entries.get(key)));
            },
            async updateMany(changes: [string, (value: unknown) => unknown][]) {
                const pending = changes.map(([key, change]) => {
                    if (cleanupBlocked && key === "Vencord-MoreStickers-Packs") throw new Error("Storage unavailable");
                    return [key, change(entries.get(key))] as const;
                });
                for (const [key, value] of pending) entries.set(key, value);
            }
        };
        const stickers = loadSource("src/equicordplugins/moreStickers/stickers.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": DataStore
        });
        const notices: string[] = [];
        let recentReads = 0;
        const migration = loadSource("src/equicordplugins/moreStickers/migrate-v1.ts", {
            "@api/index": { DataStore },
            "@utils/Logger": { Logger: class { error() {} } },
            "@webpack/common": { Toasts: { show: ({ message }: { message: string; }) => notices.push(message), genId: () => "toast", Type: {} } },
            "./components/misc": { getRecentStickers: async () => { recentReads++; return []; } },
            "./stickers": stickers
        }, { console: { error() {} } });
        await migration.migrate();
        assert.equal((await stickers.getStickerPack(newId))?.id, missing ? undefined : newId);
        assert.deepEqual(Array.from(await stickers.getStickerPackMetas(), (meta: { id: string; }) => meta.id), missing ? [] : [newId]);
        assert.equal(entries.has("Vencord-MoreStickers-Packs"), failCleanup || missing);
        assert.deepEqual(notices, [failCleanup || missing ? "Migration incomplete. Some sticker packs could not be migrated." : "Sticker Pack Migration Complete"]);
        assert.equal(recentReads, failCleanup || missing ? 0 : 1);
        if (oldId !== newId) assert.equal(await stickers.getStickerPack(oldId), failCleanup ? pack : null);
        if (failCleanup) {
            cleanupBlocked = false;
            const edited = { ...await stickers.getStickerPack(newId), title: "Edited after interruption" };
            await stickers.saveStickerPack(edited);
            assert.equal(await migration.isV1(), true);
            await migration.migrate();
            assert.equal(await stickers.getStickerPack(newId), edited);
            assert.equal(entries.has("Vencord-MoreStickers-Packs"), false);
            assert.equal(await migration.isV1(), false);
        }
    }
});

test("recent sticker migration resumes without old packs and preserves current entries", async () => {
    const current = { id: "custom", stickerPackId: "pack", title: "Current" };
    const oldKey = "Vencord-MoreStickers-RecentStickers";
    const newKey = "MoreStickers:RecentStickers";
    const entries = new Map<string, unknown>([
        [oldKey, [{ ...current, title: "Old" }, ...Array.from({ length: 20 }, (_, index) => ({ id: `legacy${index}`, stickerPackId: "pack" }))]],
        [newKey, [current]]
    ]);
    const DataStore = {
        async del(key: string) { entries.delete(key); },
        async update(key: string, change: (value: unknown) => unknown) { entries.set(key, change(entries.get(key))); }
    };
    const migration = loadSource("src/equicordplugins/moreStickers/migrate-v1.ts", {
        "@api/index": { DataStore }, "@utils/Logger": { Logger: class {} },
        "@webpack/common": { Toasts: { show() {}, genId: () => "toast", Type: {} } },
        "./components/misc": { getRecentStickers: async (key: string) => entries.get(key) ?? [] },
        "./stickers": { getStickerPackMetas: async () => [] }
    });
    assert.equal(await migration.isV1(), true);
    await migration.migrate();
    const recents = entries.get(newKey) as { id: string; title?: string; }[];
    assert.equal(recents.length, 16);
    assert.equal(recents[0], current);
    assert.equal(new Set(recents.map(sticker => sticker.id)).size, 16);
    assert.equal(entries.has(oldKey), false);
    assert.equal(await migration.isV1(), false);
});

test("sticker file imports validate the entire batch before writing packs", async () => {
    const stickers = loadSource("src/equicordplugins/moreStickers/stickers.ts", {
        "@api/DataStore": {}, "./components": {},
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    });
    const sticker = { id: "sticker", stickerPackId: "pack", title: "Sticker", image: "https://example.com/image.png" };
    const pack = { id: "pack", title: "Pack", logo: sticker, stickers: [sticker] };
    for (const invalid of [null, { ...pack, id: 1 }, { ...pack, logo: null }, { ...pack, stickers: [null] },
        { ...pack, stickers: [{ ...sticker, filename: 1 }] }, { ...pack, author: null },
        { ...pack, dynamic: { refreshUrl: "url", authHeaders: { key: 1 } } }]) {
        assert.equal(stickers.isStickerPack(invalid), false);
    }
    assert.equal(stickers.isStickerPack({ ...pack, author: { name: "Author", url: "url" }, dynamic: { refreshUrl: "url", authHeaders: { key: "value" } } }), true);
    const source = readFileSync("src/equicordplugins/moreStickers/components/misc.tsx", "utf8");
    const callback = source.match(/input.onchange = async e => \{([\s\S]*?)\n\s*\};\n\s*input.click/);
    assert.ok(callback);
    for (const valid of [true, false]) {
        const saved: unknown[] = [];
        const notices: string[] = [];
        const change = runInNewContext(transpileModule(`(async () => {${callback[1]}})`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
            input: { files: [{ text: async () => JSON.stringify(valid ? [pack, pack] : [pack, { ...pack, logo: null }]) }] },
            isStickerPack: stickers.isStickerPack, saveStickerPack: async (value: unknown) => saved.push(value),
            Toasts: { show: ({ type }: { type: string; }) => notices.push(type), genId: () => "toast", Type: { SUCCESS: "success", FAILURE: "failure" } },
            console: { error() {} }
        });
        await change();
        assert.equal(saved.length, valid ? 2 : 0);
        assert.deepEqual(notices, [valid ? "success" : "failure"]);
    }
});

test("sticker inspector derives its pack from the current hover", () => {
    let hovered = { id: "sticker", stickerPackId: "second" };
    let stateIndex = 0;
    const titles: unknown[] = [];
    const React = {
        createElement: (type: unknown, _props: unknown, ...children: unknown[]) => { if (type === "strong") titles.push(children[0]); return null; },
        useState: (initial: unknown) => [stateIndex++ === 0 ? hovered : initial, () => {}],
        useRef: () => ({ current: null }), useEffect() {}
    };
    const picker = loadSource("src/equicordplugins/moreStickers/components/picker.tsx", {
        "@equicordplugins/moreStickers/types": {},
        "@utils/react": { useAwaiter: () => [[]] },
        "@equicordplugins/moreStickers/upload": {}, "@equicordplugins/moreStickers/utils": { clPicker: () => "" },
        "@shared/debounce": { debounce: (callback: unknown) => callback }, "@webpack/common": { React },
        "./categories": {}, "./icons": {}, "./misc": { RECENT_STICKERS_ID: "recent", RECENT_STICKERS_TITLE: "Recent" }
    });
    let packs = [{ id: "first", title: "First", logo: {}, stickers: [] }, { id: "second", title: "Second", logo: {}, stickers: [] }];
    const render = () => { stateIndex = 0; picker.PickerContent({ stickerPacks: packs, setSelectedStickerPackId() {}, closePopout() {} }); };
    render();
    packs = packs.map(pack => pack.id === "second" ? { ...pack, title: "Updated" } : pack);
    render();
    hovered = { ...hovered, stickerPackId: "missing" };
    render();
    assert.deepEqual(titles, ["Second", "Updated", ""]);
});

test("sticker search uses the parent query and clears without delayed writes", () => {
    const inputs: { value: string; onChange: (value: string) => void; }[] = [];
    const clearButtons: { onClick: () => void; }[] = [];
    const changes: string[] = [];
    const TextInput = Symbol("TextInput");
    const CancelIcon = Symbol("CancelIcon");
    const picker = loadSource("src/equicordplugins/moreStickers/components/picker.tsx", {
        "@equicordplugins/moreStickers/types": {}, "@equicordplugins/moreStickers/upload": {},
        "@equicordplugins/moreStickers/utils": { clPicker: () => "" }, "@utils/react": {},
        "@webpack/common": { TextInput, React: { createElement: (type: unknown, props: never) => {
            if (type === TextInput) inputs.push(props);
            if (type === CancelIcon) clearButtons.push(props);
            return null;
        } } },
        "./categories": {}, "./icons": { CancelIcon }, "./misc": {}
    });
    const onQueryChange = (value: string) => changes.push(value);
    picker.PickerHeader({ query: "cat", onQueryChange });
    assert.equal(inputs[0].value, "cat");
    inputs[0].onChange("dog");
    clearButtons[0].onClick();
    picker.PickerHeader({ query: "", onQueryChange });
    assert.equal(inputs[1].value, "");
    assert.equal(clearButtons.length, 1);
    assert.deepEqual(changes, ["dog", ""]);
});

test("recent sticker loads handle errors and ignore unmounted results", async () => {
    for (const failed of [false, true]) {
        for (const unmounted of [false, true]) {
            const effects: (() => () => void)[] = [];
            const updates: { value?: unknown; error?: unknown; }[] = [];
            let notices = 0;
            const React = {
                createElement: () => null, useRef: () => ({ current: null }),
                useState: (initial: unknown) => [initial, (value: { value?: unknown; error?: unknown; }) => updates.push(value)],
                useEffect: (effect: () => () => void) => effects.push(effect)
            };
            const shared = loadSource("src/utils/react.tsx", { "@webpack/common": { ...React, React }, "./misc": {}, "./lazyReact": {} });
            const recent = [{ id: "recent-sticker" }];
            const picker = loadSource("src/equicordplugins/moreStickers/components/picker.tsx", {
                "@equicordplugins/moreStickers/types": {}, "@equicordplugins/moreStickers/upload": {},
                "@equicordplugins/moreStickers/utils": { clPicker: () => "" },
                "@shared/debounce": { debounce: (callback: unknown) => callback }, "@utils/react": shared,
                "@webpack/common": { React, showToast: () => notices++, Toasts: { Type: {} } }, "./categories": {}, "./icons": {},
                "./misc": { getRecentStickers: async () => { if (failed) throw new Error("Load failed"); return recent; } }
            });
            picker.PickerContent({ stickerPacks: [] });
            assert.equal(effects.length, 1);
            const cleanup = effects[0]();
            if (unmounted) cleanup();
            await setImmediate();
            assert.equal(updates.length, unmounted ? 0 : 1);
            assert.equal(notices, failed && !unmounted ? 1 : 0);
            if (!failed && !unmounted) assert.equal(updates[0].value, recent);
        }
    }
});

test("sticker picker uses shared async cleanup for pack loading", async () => {
    for (const failure of ["none", "metadata", "payload"]) {
        for (const unmounted of [false, true]) {
            const effects: (() => () => void)[] = [];
            const updates: { value?: unknown; error?: unknown; }[] = [];
            let notices = 0;
            const React = {
                createElement: () => null,
                useState: (initial: unknown) => [initial, (value: { value?: unknown; error?: unknown; }) => updates.push(value)],
                useEffect: (effect: () => () => void) => effects.push(effect)
            };
            const shared = loadSource("src/utils/react.tsx", {
                "@webpack/common": { ...React, React }, "./misc": {}, "./lazyReact": {}
            });
            const pack = { id: "loaded", title: "Loaded", logo: { image: "image" }, stickers: [] };
            const plugin = loadSource("src/equicordplugins/moreStickers/index.tsx", {
                "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {}, EquicordDevs: {} },
                "@utils/react": shared, "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
                "@webpack/common": { React, showToast: () => notices++, Toasts: { Type: {} } },
                "./components": {}, "./utils": { cl: () => "" },
                "./stickers": {
                    getStickerPackMetas: async () => { if (failure === "metadata") throw new Error("Load failed"); return [{ id: "loaded" }, { id: "missing" }]; },
                    getStickerPack: async (id: string) => { if (failure === "payload") throw new Error("Load failed"); return id === "loaded" ? pack : null; }
                }
            }).default;
            plugin.moreStickersComponent({ channel: { id: "channel" }, closePopout() {} });
            assert.equal(effects.length, 1);
            const cleanup = effects[0]();
            if (unmounted) cleanup();
            await setImmediate();
            assert.equal(updates.length, unmounted ? 0 : 1);
            assert.equal(notices, !unmounted && failure !== "none" ? 1 : 0);
            if (!unmounted && failure === "none") assert.deepEqual(Array.from(updates[0].value as object[]), [pack]);
        }
    }
});

test("sticker settings retain successful loads and discard unmounted completions", async () => {
    const source = readFileSync("src/equicordplugins/moreStickers/components/misc.tsx", "utf8");
    const callback = source.match(/React.useEffect\(\(\) => \{([\s\S]*?)\n    \}, \[\]\)/);
    assert.ok(callback);
    for (const failure of ["none", "packs", "legacy", "both"]) {
        for (const unmounted of [false, true]) {
            const updates: string[] = [];
            let notices = 0;
            const effect = runInNewContext(`(() => {${callback[1]}})`, {
                getStickerPackMetas: async () => { if (failure === "packs" || failure === "both") throw new Error("Invalid packs"); return []; },
                isV1: async () => { if (failure === "legacy" || failure === "both") throw new Error("Invalid legacy packs"); return true; },
                setstickerPackMetas: () => updates.push("packs"), setV1: () => updates.push("legacy"),
                Toasts: { show: () => notices++, genId: () => "toast", Type: {} }
            });
            const cleanup = effect();
            if (unmounted) cleanup();
            await setImmediate();
            assert.deepEqual(updates, unmounted ? [] : ["packs", "legacy"].filter(key => failure !== key && failure !== "both"));
            assert.equal(notices, !unmounted && failure !== "none" ? 1 : 0);
        }
    }
});

test("sticker migration button refreshes results and handles rejected storage work", async () => {
    const source = readFileSync("src/equicordplugins/moreStickers/components/misc.tsx", "utf8");
    const callback = source.match(/onClick=\{async \(\) => \{(\s*try \{\s*await migrate\(\);[\s\S]*?)\n\s*\}\}/);
    assert.ok(callback);
    for (const failure of ["none", "migration", "refresh", "status"]) {
        const calls: string[] = [];
        const notices: string[] = [];
        const click = runInNewContext(`(async () => {${callback[1]}})`, {
            migrate: async () => { calls.push("migration"); if (failure === "migration") throw new Error("Storage unavailable"); },
            refreshStickerPackMetas: async () => { calls.push("refresh"); if (failure === "refresh") throw new Error("Storage unavailable"); },
            isV1: async () => { calls.push("status"); if (failure === "status") throw new Error("Storage unavailable"); return false; },
            setV1: (pending: boolean) => { assert.equal(pending, false); calls.push("updated"); },
            Toasts: { show: ({ message }: { message: string; }) => notices.push(message), genId: () => "toast", Type: {} }
        });
        await click();
        assert.equal(notices.length, failure === "none" ? 0 : 1);
        assert.deepEqual(calls, failure === "none" ? ["migration", "refresh", "status", "updated"]
            : ["migration", "refresh", "status"].slice(0, ["migration", "refresh", "status"].indexOf(failure) + 1));
    }
});

test("legacy LINE stickers and recent entries migrate to current importer identities", () => {
    const migration = loadSource("src/equicordplugins/moreStickers/migrate-v1.ts", {
        "@api/index": {}, "@utils/Logger": { Logger: class {} }, "@webpack/common": {}, "./components/misc": {}, "./stickers": {}
    }, {}, "({ migrateStickerPack, migrateSticker })");
    for (const [file, oldPackId, oldStickerId] of [
        ["lineStickers", "Vencord-MoreStickers-Line-Pack-123", "Vencord-MoreStickers-Line-Sticker123-456"],
        ["lineEmojis", "Vencord-MoreStickers-Line-Emoji-Pack-123", "Vencord-MoreStickers-Line-Emoji123-456"]
    ]) {
        const importer = loadSource(`src/equicordplugins/moreStickers/${file}.ts`, { "./utils": {} });
        const source = { id: "456", stickerPackId: "123", staticUrl: "image" };
        const expected = importer.convert({ id: "123", title: "Pack", mainImage: source, stickers: [source] });
        const legacySticker = { ...expected.stickers[0], id: oldStickerId, stickerPackId: oldPackId };
        const migrated = migration.migrateStickerPack({ ...expected, id: oldPackId, logo: legacySticker, stickers: [legacySticker] });
        assert.deepEqual(JSON.parse(JSON.stringify(migrated)), JSON.parse(JSON.stringify(expected)));
        assert.deepEqual(JSON.parse(JSON.stringify(migration.migrateSticker(legacySticker))), JSON.parse(JSON.stringify(expected.stickers[0])));
    }
});

test("theme watcher detects empty-folder changes and notifies once", async () => {
    let files: { fileName: string; }[] = [];
    const notices: string[] = [];
    const store = { includeLocal: true, includeOnline: false, autoRefresh: true, showNotifications: true, sortOrder: "recent" };
    const watcher = loadSource("src/equicordplugins/quickThemeSwitcher.discordDesktop/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), Settings: { enabledThemes: [], enabledThemeLinks: [], themeNames: {} }, SettingsStore: {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@shared/debounce": { debounce: (callback: () => void) => callback },
        "@utils/constants": { Devs: {}, IS_MAC: false },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, StartAt: {} },
        "@webpack/common": { showToast: (message: string) => notices.push(message), Toasts: { Type: { SUCCESS: 1 } } }
    }, { window: { VencordNative: { themes: { getThemesList: async () => files } } } },
    "(pluginStarted = true, { watch: watchForLocalThemeChanges, themes: () => themeList })");
    await watcher.watch();
    assert.equal(notices.length, 0);
    files = [{ fileName: "first.css" }];
    await watcher.watch();
    assert.equal(watcher.themes().length, 1);
    assert.deepEqual(notices, ["Added 1 local theme"]);
    files = [];
    await watcher.watch();
    assert.equal(watcher.themes().length, 0);
    assert.deepEqual(notices, ["Added 1 local theme", "Removed 1 local theme"]);
    store.showNotifications = false;
    files = [{ fileName: "second.css" }];
    await watcher.watch();
    assert.equal(watcher.themes().length, 1);
    assert.equal(notices.length, 2);
});

test("quote preview ignores superseded and unmounted image work", async () => {
    const effects: (() => (() => void) | void)[] = [];
    const states: unknown[] = [];
    let stateIndex = 0;
    const pending: ((image: Blob) => void)[] = [];
    const created: Blob[] = [];
    const revoked: string[] = [];
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const modal = loadSource("src/equicordplugins/quoter/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { grayscale: false, showWatermark: false, saveAsGif: false, watermark: "", quoteFont: "font" } }) },
        "@components/FormSwitch": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack/common": { React, IconUtils: { getUserAvatarURL: () => "avatar" },
            useState: (initial: unknown) => { const index = stateIndex++; states[index] = initial; return [initial, (value: unknown) => { states[index] = value; }]; },
            useEffect: (effect: () => (() => void) | void) => effects.push(effect) },
        "./components/QuoteIcon": {}, "./types": { QuoteFont: {} },
        "./utils": { createQuoteImage: () => new Promise<Blob>(resolve => pending.push(resolve)) }
    }, { React, URL: { createObjectURL: (image: Blob) => { created.push(image); return "blob:preview"; }, revokeObjectURL: (url: string) => revoked.push(url) } }, "QuoteModal");
    modal({ message: { author: {}, content: "Quote" } });
    const firstCleanup = effects[1]();
    firstCleanup?.();
    const secondCleanup = effects[1]();
    const latest = new Blob(["latest"]);
    pending[1](latest);
    await Promise.resolve();
    pending[0](new Blob(["stale"]));
    await Promise.resolve();
    assert.equal(states[4], latest);
    assert.equal(created.length, 1);
    secondCleanup?.();
    assert.deepEqual(revoked, ["blob:preview"]);
    const closedCleanup = effects[1]();
    closedCleanup?.();
    pending[2](new Blob(["closed"]));
    await Promise.resolve();
    assert.equal(created.length, 1);
    assert.equal(states[4], null);
});

test("encrypted embeds discard decrypted content after invalidation or account change", async () => {
    let userId = "first";
    let extracted = 0;
    const pending: ((value: object) => void)[] = [];
    const cache = loadSource("src/equicordplugins/secureMessaging.desktop/embedCache.ts", {
        "@webpack": { findByCodeLazy: () => () => null },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./embedUrls": { extractSecureEmbedUrls: () => { extracted++; return []; } },
        "./messageMetadata": { discordEditedTimestamp: () => null },
        "./protocol": { isEncryptedMessage: () => true }
    }, { VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncoming: () => new Promise(resolve => pending.push(resolve)) } } } });
    const message = { channel_id: "channel", id: "message", author: { id: "sender" }, content: "ciphertext" };
    cache.patchEncryptedMessageEmbeds(message, () => {});
    cache.clearEncryptedEmbedCache();
    pending[0]({ status: "decrypted", plaintext: "private URL" });
    await setImmediate();
    assert.equal(extracted, 0);
    cache.patchEncryptedMessageEmbeds(message, () => {});
    userId = "second";
    cache.patchEncryptedMessageEmbeds(message, () => {});
    assert.equal(pending.length, 3);
    pending[1]({ status: "decrypted", plaintext: "old account" });
    await setImmediate();
    assert.equal(extracted, 0);
    pending[2]({ status: "decrypted", plaintext: "current account" });
    await setImmediate();
    assert.equal(extracted, 1);
});

test("encrypted attachment cache separates authenticated message contexts", async () => {
    let userId = "local-a";
    let decryptions = 0;
    const cache = loadSource("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
        "./messageMetadata": loadSource("src/equicordplugins/secureMessaging.desktop/messageMetadata.ts", {}),
        "./protocol": { isEncryptedMessage: () => true }
    }, { VencordNative: { pluginHelpers: { SecureMessaging: { decryptIncomingAttachments: async () => { decryptions++; return { status: "invalid_message" }; } } } } });
    const message = { channel_id: "channel", id: "message", author: { id: "sender" }, content: "ciphertext", attachments: [{ id: "attachment", size: 1, url: "url", proxy_url: "proxy" }], edited_timestamp: null as string | null };
    cache.encryptedAttachmentStatus(message);
    await Promise.resolve();
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 1);
    message.author.id = "other-sender";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 2);
    message.edited_timestamp = "2026-01-01T00:00:00.000Z";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 3);
    userId = "local-b";
    cache.encryptedAttachmentStatus(message);
    assert.equal(decryptions, 4);
});

test("screen recorder releases capture and discards work after disable", async () => {
    let resolvePicker: (stream: object) => void = () => {};
    let trackStops = 0;
    let uploads = 0;
    const track = { onended: null, stop: () => trackStops++ };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    class Recorder {
        state = "inactive";
        mimeType = "video/webm";
        ondataavailable?: (event: { data: Blob; }) => void;
        onstop?: () => void;
        start() { this.state = "recording"; }
        stop() {
            this.state = "inactive";
            queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["video"]) }); this.onstop?.(); });
        }
    }
    const module = loadSource("src/equicordplugins/screenRecorder.equibop/index.tsx", {
        "@components/Icons": {}, "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { DraftType: { ChannelMessage: 0 }, UploadHandler: { promptToUpload: () => uploads++ } }
    }, { navigator: { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { resolvePicker = resolve; }) } }, MediaRecorder: Recorder, File },
    "({ start: startRecording, finish: stopRecording, disable: exports.default.stop })");
    const pending = module.start({});
    module.disable();
    resolvePicker(stream);
    await pending;
    assert.equal(trackStops, 1);
    assert.equal(uploads, 0);
    const active = module.start({});
    resolvePicker(stream);
    await active;
    module.disable();
    await Promise.resolve();
    assert.ok(trackStops >= 2);
    assert.equal(uploads, 0);
    const normal = module.start({});
    resolvePicker(stream);
    await normal;
    module.finish();
    await Promise.resolve();
    assert.equal(uploads, 1);
});

test("scheduled reaction retries stop after account changes or shutdown", async () => {
    for (const change of ["account", "stop"]) {
        let userId = "first";
        let requests = 0;
        const timers: (() => void)[] = [];
        const add = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": {}, "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) },
                RestAPI: { put: async () => { requests++; throw { status: 429, body: { retry_after: 1 } }; } } },
            ".": { settings: { store: {} } }
        }, { setTimeout: (callback: () => void) => { timers.push(callback); return 1; } },
        "Object.assign(addReactionsToMessage, { stop: exports.stopScheduler })");
        const pending = add("channel", "message", [{ emoji: { name: "hello" } }]);
        await setImmediate();
        assert.equal(requests, 1);
        assert.equal(timers.length, 1);
        if (change === "account") userId = "second";
        else add.stop();
        timers[0]();
        await pending;
        assert.equal(requests, 1);
    }
});

test("scheduled sends accepted after shutdown skip reactions but finish successfully", async () => {
    let finish: () => void = () => {};
    const send = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": {}, "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, ChannelStore: { getChannel: () => ({}) }, FluxDispatcher: { dispatch() {} },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
            RestAPI: { post: async () => { await new Promise<void>(resolve => { finish = resolve; }); return { body: { id: "sent" } }; },
                put: () => assert.fail("No reactions after stop") }, showToast: () => assert.fail("No toast after stop") },
        ".": { settings: { store: { showNotifications: true } } }
    }, {}, "Object.assign(sendScheduledMessage, { stop: exports.stopScheduler })");
    const pending = send({ id: "queued", channelId: "channel", reactions: [{ emoji: { name: "hello" } }] });
    send.stop();
    finish();
    assert.equal(await pending, true);
});

test("scheduled sends stopped during persistence remain saved without posting", async () => {
    for (const changed of [false, true]) {
        let userId = "account";
        let finish: () => void = () => {};
        const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [scheduledEntry({ id: "queued", userId: "account", scheduledTime: 0 })],
                set: () => new Promise<void>(resolve => { finish = resolve; }) },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, ChannelStore: { getChannel: () => assert.fail("Must stop before sending") } },
            ".": { settings: { store: {} } }
        });
        await module.loadScheduledMessages();
        const pending = module.sendScheduledMessageNow("queued");
        await setImmediate();
        if (changed) userId = "other";
        else module.stopScheduler();
        finish();
        assert.equal((await pending).success, false);
        assert.equal(module.getScheduledMessages().length, 1);
        assert.equal(typeof module.getScheduledMessages()[0].attemptedAt, "number");
    }
});

test("scheduled send batches stop before starting the next message", async () => {
    let posts = 0;
    let finish: () => void = () => {};
    const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": { get: async () => [1, 2].map(id => (scheduledEntry({ id: String(id), userId: "account", channelId: "channel", scheduledTime: 0 }))), set: async () => {} },
        "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, ChannelStore: { getChannel: () => ({}) }, FluxDispatcher: { dispatch() {} },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
            RestAPI: { post: async () => { posts++; await new Promise<void>(resolve => { finish = resolve; }); return { body: { id: "sent" } }; } } },
        ".": { settings: { store: { showNotifications: false } } }
    }, {}, "({ ...exports, checkAndSendMessages })");
    await module.loadScheduledMessages();
    const pending = module.checkAndSendMessages();
    await setImmediate();
    assert.equal(posts, 1);
    module.stopScheduler();
    finish();
    await pending;
    assert.equal(posts, 1);
    assert.equal(module.getScheduledMessages().length, 1);
    assert.equal(module.getScheduledMessages()[0].id, "2");
    assert.equal(module.getScheduledMessages()[0].attemptedAt, undefined);
});

test("scheduled preview restoration stops between messages after invalidation", async () => {
    for (const change of ["none", "cleanup", "account", "remove"]) {
        const reads: (() => void)[] = [];
        let userId = "first";
        const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [1, 2].map(id => (scheduledEntry({ id: String(id), userId: "first", channelId: "channel", scheduledTime: id }))), set: async () => {} },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) },
                MessageStore: { hasPresent: () => false }, FluxDispatcher: { dispatch() {} },
                MessageActions: { fetchMessages: () => new Promise<void>(resolve => reads.push(resolve)) } },
            ".": { settings: { store: { showPhantomMessages: true } } }
        }, { setTimeout: () => 1 });
        await module.loadScheduledMessages();
        const pending = module.recreatePhantomMessages();
        assert.equal(reads.length, 1);
        if (change === "cleanup") module.cleanupAllPhantomMessages();
        if (change === "account") userId = "second";
        if (change === "remove") await module.removeScheduledMessage("2");
        reads[0]();
        await setImmediate();
        assert.equal(reads.length, change === "none" ? 2 : 1);
        if (change === "none") reads[1]();
        await pending;
    }
});

test("scheduled phantom history loads cannot revive stale previews", async () => {
    for (const change of ["none", "cleanup", "replace", "account"]) {
        const reads: (() => void)[] = [];
        const created: string[] = [];
        let userId = "first";
        const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": {}, "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) },
                MessageStore: { hasPresent: () => false },
                MessageActions: { fetchMessages: () => new Promise<void>(resolve => reads.push(resolve)) },
                FluxDispatcher: { dispatch: ({ type, message }: { type: string; message: { content: string; }; }) => {
                    if (type === "MESSAGE_CREATE") created.push(message.content);
                } } },
            ".": { settings: { store: { showPhantomMessages: true } } }
        }, { setTimeout: () => 1 });
        const message = { id: "queued", userId: "first", channelId: "channel", content: "Old", scheduledTime: 1 };
        let settled = false;
        const pending = module.createPhantomMessage(message).then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        let replacement: Promise<void> | undefined;
        if (change === "cleanup") module.cleanupAllPhantomMessages();
        if (change === "replace") replacement = module.createPhantomMessage({ ...message, content: "New" });
        if (change === "account") userId = "second";
        reads[0]();
        await pending;
        assert.equal(settled, true);
        assert.deepEqual(created, change === "none" ? ["Old"] : []);
        if (change === "replace") {
            reads[1]();
            await replacement;
            assert.deepEqual(created, ["New"]);
        }
    }
});

test("scheduled queue serializes reloads and edits across scheduler stops", async () => {
    const reads: ((value: { id: string; scheduledTime: number; }[]) => void)[] = [];
    const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": { get: () => new Promise(resolve => reads.push(resolve)), set: async () => {} },
        "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, FluxDispatcher: { dispatch() {} } }, ".": { settings: { store: {} } }
    });
    const older = module.loadScheduledMessages();
    const newer = module.loadScheduledMessages();
    await setImmediate();
    assert.equal(reads.length, 1);
    reads[0]([scheduledEntry({ id: "old", scheduledTime: 1 })]);
    await older;
    await setImmediate();
    reads[1]([scheduledEntry({ id: "new", scheduledTime: 2 })]);
    await newer;
    assert.equal(module.getScheduledMessages()[0].id, "new");
    const beforeClear = module.loadScheduledMessages();
    const clearing = module.clearAllScheduledMessages();
    await setImmediate();
    reads[2]([scheduledEntry({ id: "deleted", scheduledTime: 0 })]);
    await beforeClear;
    await clearing;
    assert.equal(module.getScheduledMessages().length, 0);
    const beforeStop = module.loadScheduledMessages();
    module.stopScheduler();
    await setImmediate();
    reads[3]([scheduledEntry({ id: "stopped", scheduledTime: 0 })]);
    await beforeStop;
    assert.equal(module.getScheduledMessages()[0].id, "stopped");
});

test("signed-out scheduled messages wait between checks without changing the queue", async () => {
    const delays: number[] = [];
    const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": { get: async () => [scheduledEntry({ id: "queued", scheduledTime: 0 })], set: () => assert.fail("No signed-out queue write") },
        "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => null } },
        ".": { settings: { store: { checkIntervalSeconds: 10 } } }
    }, { setTimeout: (_callback: unknown, delay: number) => { delays.push(delay); return 1; } });
    await module.loadScheduledMessages();
    module.startScheduler();
    await setImmediate();
    assert.deepEqual(delays, [10000]);
    assert.equal(module.getScheduledMessages()[0].attemptedAt, undefined);
});

test("scheduled interval changes only replace an active timer", async () => {
    let delay = 10;
    const timers: number[] = [];
    const cleared: number[] = [];
    const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": { get: async () => [scheduledEntry({ id: "future", scheduledTime: Date.now() + 100000 })] },
        "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) },}, ".": { settings: { store: { get checkIntervalSeconds() { return delay; } } } }
    }, { setTimeout: (_callback: unknown, ms: number) => { timers.push(ms); return timers.length; },
        clearTimeout: (id: number) => cleared.push(id) });
    await module.loadScheduledMessages();
    module.scheduleNextCheck();
    assert.deepEqual(timers, []);
    module.startScheduler();
    assert.deepEqual(timers, [10000]);
    delay = 5;
    module.scheduleNextCheck();
    assert.deepEqual(timers, [10000, 5000]);
    assert.deepEqual(cleared, [1]);
    module.stopScheduler();
    module.scheduleNextCheck();
    assert.deepEqual(timers, [10000, 5000]);
    assert.deepEqual(cleared, [1, 2]);
});

test("scheduling dialogs ignore account changes before and during saves", async () => {
    for (const scenario of ["before", "during", "unchanged", "edited", "new-upload", "replaced-upload", "removed-upload", "failed", "failed-after-account"]) {
        const before = scenario === "before";
        const stale = before || scenario === "during" || scenario === "failed-after-account";
        const failed = scenario.startsWith("failed");
        const errors: unknown[] = [];
        const cleared: string[] = [];
        const clearedUploads: string[] = [];
        let userId = "first";
        let writes = 0;
        let finish: () => void = () => {};
        let schedule: () => Promise<void> = async () => assert.fail("Missing schedule action");
        const Modal = Symbol("Modal");
        const React = { createElement: (type: unknown, props: { actions: { onClick: () => Promise<void>; }[]; }) => {
            if (type === Modal) schedule = props.actions[0].onClick;
            return null;
        } };
        const component = loadSource("src/equicordplugins/scheduledMessages/components/ScheduleTimeModal.tsx", {
            "@components/Button": {}, "@components/Heading": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
            "@utils/css": { classNameFactory: () => () => "" }, "@webpack": { findByPropsLazy: () => ({ dispatchToLastSubscribed: () => assert.fail("No stale clear") }) },
            "@webpack/common": { Modal, useRef: (value: unknown) => ({ current: value }), DraftType: { ChannelMessage: 0 },
                DraftStore: { getDraft: () => scenario === "edited" ? "New text" : "Text" },
                DraftActions: { clearDraft: (channelId: string) => cleared.push(channelId) }, Toasts: { Type: {} }, UserStore: { getCurrentUser: () => ({ id: userId }) },
                ChannelStore: { getChannel: () => ({ isPrivate: () => true }) }, useState: (value: unknown) => [value, (next: unknown) => errors.push(next)],
                showToast: () => { assert.equal(stale || failed, false); }, UploadAttachmentStore: { getUploads: () => (scenario === "new-upload" ? ["original", "new"] : scenario === "replaced-upload" ? ["new"] : scenario === "removed-upload" ? [] : ["original"]).map(id => ({ id })) },
                UploadManager: { clearAll: (channelId: string) => { assert.equal(stale || failed, false); clearedUploads.push(channelId); } } },
            "../utils": { getChannelDisplayInfo: () => ({ name: "DM" }), addScheduledMessage: async () => {
                writes++; await new Promise<void>(resolve => { finish = resolve; });
                if (failed) throw new Error("Private storage failure details");
                return { success: true };
            } }, "./Icons": {}
        }, { React }, "ScheduleTimeModalInner");
        component({ userId: "first", uploadIds: ["original"], channelId: "channel", content: "Text", close: () => { assert.equal(stale || failed, false); } });
        if (before) userId = "second";
        const pending = schedule();
        await schedule();
        assert.equal(writes, before ? 0 : 1);
        if (!before) { if (scenario === "during" || scenario === "failed-after-account") userId = "second"; finish(); }
        await pending;
        assert.equal(writes, before ? 0 : 1);
        assert.deepEqual(cleared, !stale && !failed && scenario !== "edited" ? ["channel"] : []);
        if (failed) assert.deepEqual(errors, stale ? [] : ["Could not save the scheduled message. Try again."]);
        assert.deepEqual(clearedUploads, scenario === "unchanged" || scenario === "edited" ? ["channel"] : []);
        if (scenario === "failed") {
            const retry = schedule();
            finish();
            await retry;
            assert.equal(writes, 2);
        }
    }
});

test("scheduled composer discards attachment reads after account change or stop", async () => {
    for (const change of ["account", "stop"]) {
        let userId = "first";
        let reader: Reader | undefined;
        class Reader {
            result = "data:text/plain;base64,ZmlsZQ==";
            onload: () => void = () => {};
            constructor() { reader = this; }
            readAsDataURL() {}
        }
        const { default: plugin } = loadSource("src/equicordplugins/scheduledMessages/index.tsx", {
            "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, showToast: () => assert.fail("No stale toast") },
            "./components/ChatBarButton": { isScheduleModeEnabled: true, setScheduleModeEnabled() {} },
            "./components/Icons": {}, "./components/MessageAccessory": {}, "./components/ViewScheduledModal": {},
            "./components/ScheduleTimeModal": { openScheduleTimeModal: () => assert.fail("No stale dialog") },
            "./utils": { stopScheduler() {}, cleanupAllPhantomMessages() {} }
        }, { FileReader: Reader });
        const pending = plugin.onBeforeMessageSend("channel", { content: "Text" }, { uploads: [{ item: { file: {} }, filename: "file.txt" }] });
        if (change === "account") userId = "second";
        else plugin.stop();
        assert.ok(reader);
        reader.onload();
        assert.equal((await pending).cancel, true);
    }
});

test("scheduled composer keeps read failures out of the scheduling dialog", async () => {
    let notices = 0;
    class Reader {
        onerror: () => void = () => {};
        error = new Error("Read failed");
        readAsDataURL() { this.onerror(); }
    }
    const { default: plugin } = loadSource("src/equicordplugins/scheduledMessages/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, showToast: () => notices++, Toasts: { Type: {} } },
        "./components/ChatBarButton": { isScheduleModeEnabled: true, setScheduleModeEnabled() {} },
        "./components/Icons": {}, "./components/MessageAccessory": {}, "./components/ViewScheduledModal": {},
        "./components/ScheduleTimeModal": { openScheduleTimeModal: () => assert.fail("Do not schedule partial attachments") }, "./utils": {}
    }, { FileReader: Reader });
    const result = await plugin.onBeforeMessageSend("channel", { content: "Text" }, { uploads: [{ item: { file: {} }, filename: "file.txt" }] });
    assert.equal(result.cancel, true);
    assert.equal(notices, 1);
});

test("scheduled startup ignores completion after stop or a newer start", async () => {
    const reads: (() => void)[] = [];
    let starts = 0;
    let phantoms = 0;
    const { default: plugin } = loadSource("src/equicordplugins/scheduledMessages/index.tsx", {
        "@webpack/common": {},
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "./components/ChatBarButton": {}, "./components/Icons": {}, "./components/MessageAccessory": {},
        "./components/ScheduleTimeModal": {}, "./components/ViewScheduledModal": {},
        "./utils": { loadScheduledMessages: () => new Promise<void>(resolve => reads.push(resolve)),
            startScheduler: () => starts++, recreatePhantomMessages: () => phantoms++,
            stopScheduler() {}, cleanupAllPhantomMessages() {} }
    });
    const old = plugin.start();
    plugin.stop();
    reads[0]();
    await old;
    assert.equal(starts, 0);
    assert.equal(phantoms, 0);
    const previous = plugin.start();
    plugin.stop();
    const current = plugin.start();
    reads[2]();
    await current;
    reads[1]();
    await previous;
    assert.equal(starts, 1);
    assert.equal(phantoms, 1);
});

test("scheduled attempts remain saved on failure and do not automatically replay", async () => {
    for (const outcome of ["success", "request", "channel", "storage"]) {
        let saved = [{ id: "queued", userId: "account", channelId: "channel", content: "Text", scheduledTime: 0, createdAt: 0, attemptedAt: undefined as number | undefined }];
        let posts = 0;
        let release: () => void = () => {};
        const pendingPost = new Promise<void>(resolve => { release = resolve; });
        const module = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => structuredClone(saved), set: async (_key: string, value: typeof saved) => {
                if (outcome === "storage") throw new Error("Storage failed");
                saved = structuredClone(value);
            } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, ChannelStore: { getChannel: () => outcome === "channel" ? null : {} },
                FluxDispatcher: { dispatch() {} }, Constants: { Endpoints: { MESSAGES: (id: string) => id } },
                SnowflakeUtils: { fromTimestamp: () => "nonce" }, RestAPI: { post: async () => {
                    posts++;
                    assert.equal(typeof saved[0].attemptedAt, "number");
                    await pendingPost;
                    if (outcome === "request") throw new Error("Request failed");
                    return { body: { id: "sent" } };
                } } },
            ".": { settings: { store: { showNotifications: false } } }
        }, {}, "({ ...exports, checkAndSendMessages })");
        await module.loadScheduledMessages();
        const first = module.sendScheduledMessageNow("queued");
        const overlap = await module.sendScheduledMessageNow("queued");
        assert.equal(overlap.success, false);
        await module.checkAndSendMessages();
        release();
        assert.equal((await first).success, outcome === "success");
        assert.equal(saved.length, outcome === "success" ? 0 : 1);
        await module.checkAndSendMessages();
        assert.equal(posts, outcome === "success" || outcome === "request" ? 1 : 0);
        if (outcome !== "storage") {
            await module.loadScheduledMessages();
            await module.checkAndSendMessages();
            assert.equal(posts, outcome === "success" || outcome === "request" ? 1 : 0);
        }
    }
});

test("scheduled messages require every attachment upload before posting", async () => {
    for (const failedIndex of [-3, -2, -1, 0, 1]) {
        let userId = "account";
        const uploads: Uploader[] = [];
        const posts: { attachments: { id: string; filename: string; }[]; }[] = [];
        let errors = 0;
        class Uploader {
            filename: string;
            uploadedFilename: string;
            callbacks = new Map<string, () => void>();
            constructor({ file }: { file: File; }) {
                this.filename = file.name;
                this.uploadedFilename = `uploaded/${file.name}`;
                uploads.push(this);
            }
            on(event: string, callback: () => void) { this.callbacks.set(event, callback); }
            upload() { }
        }
        const send = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
            "@vencord/discord-types/enums": { CloudUploadPlatform: {} },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) },
                CloudUploader: Uploader, ChannelStore: { getChannel: () => ({ isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false }) },
                GuildStore: { getGuild: () => null }, FluxDispatcher: { dispatch() {} },
                Constants: { Endpoints: { MESSAGES: (id: string) => id } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
                RestAPI: { post: async ({ body }: { body: typeof posts[number]; }) => { posts.push(body); return { body: { id: "sent" } }; } },
                showToast: (_message: string, type: string) => { if (type === "failure") errors++; },
                Toasts: { Type: { FAILURE: "failure" } }
            },
            ".": { settings: { store: { showNotifications: true } } }
        }, { File, atob }, "Object.assign(sendScheduledMessage, { stop: exports.stopScheduler })");
        const pending = send({ id: "scheduled", channelId: "channel", content: "Text", attachments: [
            { filename: "first.txt", type: "text/plain", data: btoa("one") },
            { filename: "second.txt", type: "text/plain", data: btoa("two") }
        ] });
        assert.equal(uploads.length, 2);
        if (failedIndex === -2) send.stop();
        if (failedIndex === -3) userId = "other";
        assert.equal(posts.length, 0);
        uploads[1].callbacks.get(failedIndex === 1 ? "error" : "complete")?.();
        await Promise.resolve();
        assert.equal(posts.length, 0);
        uploads[0].callbacks.get(failedIndex === 0 ? "error" : "complete")?.();
        assert.equal(await pending, failedIndex === -1);
        assert.equal(posts.length, failedIndex === -1 ? 1 : 0);
        assert.equal(errors, failedIndex < 0 ? 0 : 1);
        if (posts.length) assert.deepEqual(Array.from(posts[0].attachments, item => [item.id, item.filename]), [["0", "first.txt"], ["1", "second.txt"]]);
    }
});

test("scheduled reactions target the message returned by the send request", async () => {
    const reactions: string[] = [];
    const send = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
        "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, ChannelStore: { getChannel: () => ({}) }, FluxDispatcher: { dispatch() {} },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
            MessageStore: { getMessages: () => assert.fail("Must not guess from message history") },
            RestAPI: { post: async () => ({ body: { id: "sent-id" } }), put: async ({ url }: { url: string; }) => reactions.push(url) } },
        ".": { settings: { store: { showNotifications: false } } }
    }, { setTimeout: (callback: () => void) => callback() }, "sendScheduledMessage");
    assert.equal(await send({ id: "scheduled", channelId: "channel", content: "Repeated text", reactions: [{ emoji: { name: "hello", id: "emoji" }, count: 1 }] }), true);
    assert.deepEqual(reactions, ["/channels/channel/messages/sent-id/reactions/hello:emoji/@me"]);
});

test("GIF export reports the save result once", async () => {
    const notices: { body: string; }[] = [];
    let fail = true;
    const save = loadSource("src/equicordplugins/saveFavoriteGIFs/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {} },
        "@api/Notifications": { showNotification: (notice: { body: string; }) => notices.push(notice) },
        "@api/PluginManager": {}, "@api/Settings": { definePluginSettings: () => ({}) },
        "@equicordplugins/equicordToolbox": { __esModule: true, default: {} },
        "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} }, "@utils/web": {},
        "@webpack/common": { UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { getCurrentValue: () => ({ favoriteGifs: { gifs: { "https://example.com/gif": {} } } }) } } }
    }, { IS_DISCORD_DESKTOP: true, TextEncoder, fetch: async () => ({ ok: true }),
        DiscordNative: { fileManager: { saveWithDialog: async () => { if (fail) throw new Error("Save failed"); } } }
    }, "saveWorkingGifs");
    await save();
    assert.equal(notices.length, 2);
    assert.equal(notices[1].body, "Failed to save GIFs");
    notices.length = 0;
    fail = false;
    await save();
    assert.equal(notices.length, 2);
    assert.match(notices[1].body, /^Saved GIFs successfully/);
});

test("RPC editor asset placeholders read the original values", async () => {
    const { default: plugin } = loadSource("src/equicordplugins/rpcEditor/index.tsx", {
        "@api/index": { DataStore: { get: async () => [{ appId: "app", enabled: true, newActivityType: 0, newLargeImageText: "Changed", newSmallImageText: ":large_text:" }] } },
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/constants": { Devs: {} }, "@utils/react": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, STREAMING: 1 } },
        "@webpack/common": {}, "./ReplaceSettings": {}
    });
    await plugin.start();
    const activity = { application_id: "app", assets: { large_text: "Original", small_text: "Small" } };
    plugin.patchActivity(activity);
    assert.equal(activity.assets.large_text, "Changed");
    assert.equal(activity.assets.small_text, "Original");
});

test("Jellyfin privacy mode omits all identifying media fields", async () => {
    const store = { jf_serverUrl: "https://media.example", jf_apiKey: "key", jf_userId: "user", jf_privacyMode: true, jf_showPausedState: true, jf_overrideType: "off", jf_nameDisplay: "default", jf_customName: "{name} {name} {series} {album}" };
    let mediaType = "Episode";
    let paused = false;
    const getActivity = loadSource("src/equicordplugins/richPresence/services/jellyfin.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/text": {}, "@webpack/common": {}, "../settings": { settings: { store } },
        "./assetCache": { getCachedApplicationAsset: () => assert.fail("Private presence requested artwork") }
    }, { fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [
        { UserId: "user", NowPlayingItem: { Name: "Private title", SeriesName: "Private series", Album: "Private album", Artists: ["Private artist"], Type: mediaType, ImageTags: { Primary: "image" }, RunTimeTicks: 900000000, IndexNumber: 3, ParentIndexNumber: 2 }, PlayState: { PositionTicks: 50000000, IsPaused: paused } }
    ] }) }, "getActivity");
    for (const mode of ["default", "full", "custom"]) {
        store.jf_nameDisplay = mode;
        for (const type of ["Episode", "Audio", "Movie"]) {
            mediaType = type;
            for (const isPaused of [false, true]) {
                paused = isPaused;
                const activity = await getActivity();
                assert.deepEqual(JSON.parse(JSON.stringify(activity)), {
                    application_id: "1381368130164625469", name: "Jellyfin",
                    details: type === "Audio" ? "Listening to music" : "Watching media",
                    ...(paused ? { state: "Paused" } : {}), type: type === "Audio" ? 2 : 3, flags: 1
                });
            }
        }
    }
});

test("Jellyfin preserves zero playback position and omits missing position", async () => {
    let position: number | undefined = 0;
    const fetchMediaData = loadSource("src/equicordplugins/richPresence/services/jellyfin.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/text": {}, "@webpack/common": {},
        "../settings": { settings: { store: { jf_serverUrl: "https://media.example", jf_apiKey: "key", jf_userId: "user" } } },
        "./assetCache": {}
    }, { fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [
        { UserId: "user", NowPlayingItem: { Name: "Track", Type: "Audio" }, PlayState: { PositionTicks: position } }
    ] }) }, "fetchMediaData");
    assert.equal((await fetchMediaData()).position, 0);
    position = undefined;
    assert.equal((await fetchMediaData()).position, undefined);
    position = 25_000_000;
    assert.equal((await fetchMediaData()).position, 2);
});

test("audiobook authorization failures end the current update", async () => {
    const requests: string[] = [];
    const fetchMediaData = loadSource("src/equicordplugins/richPresence/services/audiobookshelf.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@webpack/common": {},
        "../settings": { settings: { store: { abs_serverUrl: "https://books.example", abs_username: "reader", abs_password: "password" } } },
        "./assetCache": {}
    }, { fetch: async (url: string) => {
        requests.push(url);
        assert.ok(requests.length <= 4, "Unexpected recursive retry");
        return url.endsWith("/login")
            ? { ok: true, json: async () => ({ user: { token: "token" } }) }
            : { ok: false, status: 401, statusText: "Unauthorized" };
    } }, "fetchMediaData");
    assert.equal(await fetchMediaData(), null);
    assert.equal(requests.length, 2);
    assert.equal(await fetchMediaData(), null);
    assert.equal(requests.length, 4);
});

test("an evicted asset rejection preserves its replacement request", async () => {
    let rejectOld: (reason: Error) => void = () => {};
    let requests = 0;
    const { getCachedApplicationAsset } = loadSource("src/equicordplugins/richPresence/services/assetCache.ts", {
        "@webpack/common": { ApplicationAssetUtils: { fetchAssetIds: () => {
            requests++;
            if (requests === 1) return new Promise<string[]>((_resolve, reject) => { rejectOld = reject; });
            return Promise.resolve(["asset"]);
        } } }
    });
    const old = getCachedApplicationAsset("app", "first");
    const rejection = assert.rejects(old, /failed/);
    for (let i = 0; i < 150; i++) await getCachedApplicationAsset("app", String(i));
    const replacement = getCachedApplicationAsset("app", "first");
    rejectOld(new Error("failed"));
    await rejection;
    assert.equal(getCachedApplicationAsset("app", "first"), replacement);
    assert.equal(requests, 152);
});

test("magnet filenames decode once and preserve literal punctuation", () => {
    const { default: plugin } = loadSource("src/equicordplugins/richMagnetLinks/index.tsx", {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }, { URLSearchParams });
    const rule = plugin.magnetLink(1);
    for (const filename of ["a+b", "literal%20name", "100% complete", "what?now", "Café album"]) {
        const link = `magnet:?xt=urn:btih:abc&dn=${encodeURIComponent(filename)}`;
        assert.equal(rule.parse(rule.match(link), null, { messageId: "message" }).filename, filename);
    }
    assert.equal(rule.parse(rule.match("magnet:?xt=abc"), null, { messageId: "message" }).filename, "unknown filename");
});

test("remix releases its canvas after React detaches the ref", () => {
    const effects: (() => (() => void) | undefined)[] = [];
    const context = { drawImage() {} };
    const firstCanvas = { width: 0, height: 0, getContext: () => context };
    const secondCanvas = { ...firstCanvas };
    const ref: { current: typeof firstCanvas | null; } = { current: firstCanvas };
    const images: { onload: (() => void) | null; }[] = [];
    const revoked: string[] = [];
    let cleanups = 0;
    const module = loadSource("src/equicordplugins/remix/editor/components/Canvas.tsx", {
        "@equicordplugins/remix/editor/input": { initInput: () => () => cleanups++ },
        "@equicordplugins/remix/editor/tools/crop": {},
        "@equicordplugins/remix/editor/utils/canvas": {},
        "@webpack/common": { useRef: () => ref, useEffect: (effect: () => (() => void) | undefined) => effects.push(effect) }
    }, {
        React: { createElement: () => null },
        document: { createElement: () => ({ getContext: () => ({ canvas: {} }) }) },
        Image: class {
            width = 100;
            height = 100;
            onload: (() => void) | null = null;
            constructor() { images.push(this); }
        },
        URL: { createObjectURL: () => "blob:remix", revokeObjectURL: (url: string) => revoked.push(url) }
    });
    module.Canvas({ file: {} });
    const cleanup = effects[0]();
    images[0].onload?.();
    assert.equal(module.canvas, firstCanvas);
    ref.current = null;
    cleanup?.();
    assert.equal(module.canvas, null);
    assert.equal(module.ctx, null);
    assert.equal(cleanups, 1);
    assert.deepEqual(revoked, ["blob:remix"]);

    ref.current = firstCanvas;
    const oldCleanup = effects[0]();
    images[1].onload?.();
    ref.current = secondCanvas;
    const newCleanup = effects[0]();
    images[2].onload?.();
    oldCleanup?.();
    assert.equal(module.canvas, secondCanvas);
    ref.current = null;
    newCleanup?.();
    assert.equal(module.canvas, null);
});

test("recent DM cleanup closes an overlay after its setting changes", () => {
    const closed: string[] = [];
    const plugin = loadSource("src/equicordplugins/recentDMSwitcher/index.tsx", {
        "@api/DataStore": {}, "@api/Settings": { definePluginSettings: () => ({ store: { visualStyle: "off" } }) },
        "@utils/constants": { EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, makeRange: () => [] },
        "@webpack/common": { closeModal: (key: string) => closed.push(key) }
    }, { document: { removeEventListener() {} } },
    '({ finish: endCycleSession, stop: exports.default.stop, open: () => { overlayModalKey = "overlay"; isCyclingSessionActive = true; } })');
    plugin.open();
    plugin.finish();
    assert.deepEqual(closed, ["overlay"]);
    plugin.open();
    plugin.stop();
    plugin.stop();
    assert.deepEqual(closed, ["overlay", "overlay"]);
});


test("secure key reviews from a stopped session cannot change the new session gate", async () => {
    const pending: Array<(result: { status: string; }) => void> = [];
    const mocks: Record<string, object> = {};
    for (const name of ["@api/ChatButtons", "@api/MessageEvents", "@components/BaseText", "@components/Button", "@components/Heading", "@components/Span", "@utils/clipboard", "@utils/discord", "./attachments", "./attachmentUploads", "./conversationSelection", "./wireAuthorizations"])
        mocks[name] = {};
    mocks["@utils/constants"] = { EquicordDevs: { creations: {} } };
    mocks["@utils/types"] = { __esModule: true, default: (plugin: object) => plugin };
    mocks["@webpack/common"] = {
        UserStore: { getCurrentUser: () => ({ id: "local" }) },
        ChannelStore: { getChannel: () => undefined },
        CloudUploader: { prototype: {} }, RestAPI: {},
    };
    mocks["./attachmentCache"] = { clearEncryptedAttachmentCache() {} };
    mocks["./embedCache"] = { clearEncryptedEmbedCache() {} };
    mocks["./wireAuthorizations"] = { clearWirePayloadAuthorizations() {} };
    mocks["./keyReviewGate"] = loadSource("src/equicordplugins/secureMessaging.desktop/keyReviewGate.ts", {});
    mocks["./messageMetadata"] = { discordEditedTimestamp: () => null };
    mocks["./protocol"] = { isKeyAnnouncement: () => true };
    const source = loadSource("src/equicordplugins/secureMessaging.desktop/index.tsx", mocks, {
        VencordNative: { pluginHelpers: { SecureMessaging: {
            reviewAnnouncement: () => new Promise(resolve => pending.push(resolve)),
            setScreenCaptureProtection: async () => ({ status: "applied" }),
        } } },
    }, "({ plugin: exports.default, blocked: () => keyReviewGate.isBlocked('local', 'peer') })");
    const dispatch = () => source.plugin.flux.MESSAGE_CREATE({ message: { author: { id: "peer" }, channel_id: "channel", id: "message", content: "announcement" } });
    dispatch();
    source.plugin.stop();
    dispatch();
    pending[0]({ status: "trusted" });
    await setImmediate();
    assert.equal(source.blocked(), true, "old completion must not finish the new pending review");
    pending[1]({ status: "trusted" });
    await setImmediate();
    assert.equal(source.blocked(), false);
    dispatch();
    source.plugin.stop();
    dispatch();
    pending[3]({ status: "trusted" });
    await setImmediate();
    pending[2]({ status: "failed" });
    await setImmediate();
    assert.equal(source.blocked(), false, "old failure must not poison the new gate");
});


test("Sekai sticker images survive rerenders and exports keep their original channel", () => {
    const states: unknown[] = [];
    let stateIndex = 0;
    const effects: Array<() => () => void> = [];
    const ref = { current: null as unknown };
    const images: Array<{ onload: (() => void) | null; width: number; height: number; }> = [];
    class TestImage {
        onload: (() => void) | null = null;
        width = 296;
        height = 256;
        constructor() { images.push(this); }
    }
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        useState: (initial: unknown) => {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: unknown) => { states[index] = value; }];
        },
        useRef: () => ref,
        useEffect: (effect: () => () => void) => effects.push(effect),
    };
    let selectedChannel = "original";
    let uploadedChannel: unknown;
    let closed = 0;
    const { default: Editor } = loadSource("src/equicordplugins/sekaiStickers/Components/SekaiStickersModal.tsx", {
        "@components/Flex": { Flex: "flex" }, "@components/FormSwitch": {}, "@components/Heading": {},
        "@equicordplugins/sekaiStickers/characters.json": { characters: Array.from({ length: 51 }, () => ({ character: "fixture", img: "fixture.png", defaultText: { x: 1, y: 1, r: 0, s: 20 } })) },
        "@webpack/common": { React, Modal: "modal", SelectedChannelStore: { getChannelId: () => selectedChannel }, ChannelStore: { getChannel: (id: string) => id }, UploadHandler: { promptToUpload: (_files: unknown, channel: unknown) => { uploadedChannel = channel; } } },
        "./Canvas": { __esModule: true, default: "canvas" }, "./Picker": {},
    }, { React, Image: TestImage, File, document: { fonts: { check: () => true } } });
    const render = () => {
        stateIndex = 0;
        return Editor({ modalProps: { onClose: () => closed++ }, settings: { store: { AutoCloseModal: true } } });
    };
    let tree = render();
    const cleanup = effects[0]();
    assert.equal(tree.props.actions[1].disabled, true);
    images[0].onload?.();
    tree = render();
    assert.equal(images.length, 1, "a render reuses the loaded image");
    const callbacks: Array<(blob: Blob | null) => void> = [];
    const canvas = { toBlob: (callback: (blob: Blob | null) => void) => callbacks.push(callback) };
    let drawnImage: unknown;
    const context = { canvas, clearRect() {}, drawImage: (image: unknown) => { drawnImage = image; }, save() {}, restore() {}, translate() {}, rotate() {}, strokeText() {}, fillText() {} };
    tree.props.children[0].props.children[0].props.children[0].props.draw(context);
    assert.equal(drawnImage, images[0]);
    tree.props.actions[1].onClick();
    callbacks[0](null);
    assert.equal(closed, 0, "failed encoding preserves the editor");
    tree.props.actions[1].onClick();
    selectedChannel = "different";
    callbacks[1](new Blob(["png"]));
    assert.equal(uploadedChannel, "original");
    assert.equal(closed, 1);
    cleanup();
    assert.equal(images[0].onload, null, "cleanup detaches the obsolete load handler");
    states[1] = 50;
    tree = render();
    assert.equal(tree.props.actions[1].disabled, true, "a new character cannot export the previous image");
});


test("chat badge layout ignores foreign drops and preserves previous state", () => {
    let state: Array<{ key: string; position: number; shown: boolean; }> = [];
    let updates = 0;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { BadgeSettings } = loadSource("src/equicordplugins/showBadgesInChat/settings.tsx", {
        "@api/Settings": { definePluginSettings: (def: Record<string, { default?: unknown; }>) => ({ store: Object.fromEntries(Object.entries(def).map(([key, value]) => [key, value.default])) }) },
        "@components/BaseText": {}, "@utils/types": { OptionType: {} },
        "@webpack/common": {
            useEffect() {}, UserStore: { getCurrentUser: () => null },
            useState: (initial: typeof state) => { state = initial; return [state, (next: typeof state) => { state = next; updates++; }]; },
        },
    }, { React }, "({ BadgeSettings })");
    const tree = BadgeSettings();
    const items = tree.props.children[1].props.children[1];
    const previous = state;
    previous.forEach(Object.freeze);
    Object.freeze(previous);
    for (const value of ["", "other", "-1", "1.5", "6", "999999999999999999999999"])
        items[0].props.onDrop({ dataTransfer: { getData: () => value } });
    assert.equal(updates, 0);
    items[0].props.onDrop({ dataTransfer: { getData: () => "2" } });
    assert.equal(state[0].key, previous[2].key);
    assert.equal(state[0].position, 0);
    assert.equal(previous[2].position, 4);
    items[0].props.onClick();
    assert.equal(state[0].shown, false);
    assert.equal(previous[0].shown, true);
});


test("failed embed requests report once without updating the message", async () => {
    const toasts: string[] = [];
    const { unfurlEmbed } = loadSource("src/equicordplugins/showMessageEmbeds/index.tsx", {
        "@api/ContextMenu": {}, "@api/MessageUpdater": { updateMessage: () => assert.fail("failed requests cannot update embeds") },
        "@components/Icons": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": { parseUrl: () => ({}) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findByCodeLazy: () => () => assert.fail("failed requests cannot convert embeds") },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "channel" }) },
            Constants: { Endpoints: { UNFURL_EMBED_URLS: "/unfurl" } },
            RestAPI: { post: async () => { throw new Error("offline"); } },
            showToast: (message: string) => toasts.push(message), Toasts: { Type: {}, Position: {} },
        },
    }, {}, "({ unfurlEmbed })");
    await unfurlEmbed("https://example.com", { channel_id: "channel", id: "message" });
    assert.deepEqual(toasts, ["Failed to get embed"]);
});


test("sidebar DM lookups cannot override newer navigation or a closed sidebar", async () => {
    const pending: Array<(id: string) => void> = [];
    let handlers: Record<string, (payload?: object) => Promise<void> | void> = {};
    const { SidebarStore } = loadSource("src/equicordplugins/sidebarChat/store.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/lazy": { proxyLazy: (factory: () => object) => factory() },
        "@utils/types": { OptionType: {} },
        "@webpack/common": {
            Flux: { PersistedStore: class {
                constructor(_dispatcher: unknown, events: typeof handlers) { handlers = events; }
                emitChange() {}
            } },
            ChannelActionCreators: { getOrEnsurePrivateChannel: () => new Promise(resolve => pending.push(resolve)) },
        },
    });
    const first = handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "first-user" });
    handlers.VC_SIDEBAR_CHAT_CLOSE();
    pending[0]("first-dm");
    await first;
    assert.equal(SidebarStore.getState().channelId, "", "close invalidates pending DM navigation");
    const second = handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "second-user" });
    await handlers.VC_SIDEBAR_CHAT_NEW({ guildId: "guild", id: "newer-channel" });
    pending[1]("second-dm");
    await second;
    assert.equal(SidebarStore.getState().guildId, "guild");
    assert.equal(SidebarStore.getState().channelId, "newer-channel");
});


test("SongLink waits for command delivery and reports rejected sends", async () => {
    const replies: string[] = [];
    const delivery = Promise.withResolvers<void>();
    const { default: plugin } = loadSource("src/equicordplugins/songLink.desktop/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, findOption: () => "https://example.com/song", sendBotMessage: (_id: string, message: { content: string; }) => replies.push(message.content) },
        "@api/Settings": { definePluginSettings: () => ({ store: { servicesSettings: { spotify: { enabled: true } } } }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": { sendMessage: () => delivery.promise },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack/common": {}, "./Providers": { Providers: { spotify: { name: "Spotify" } } }, "./Settings": {}, "./SongLinker": {},
    }, { VencordNative: { pluginHelpers: { SongLink: { getTrackData: async () => ({ links: { spotify: { url: "https://example.com/song" } } }) } } } });
    let finished = false;
    const command = plugin.commands[0].execute([], { channel: { id: "channel" } }).then(() => { finished = true; });
    await setImmediate();
    const returnedBeforeDelivery = finished;
    delivery.reject(new Error("delivery failed"));
    await command;
    assert.equal(returnedBeforeDelivery, false, "command stays pending until delivery settles");
    assert.equal(replies.at(-1), "Failed to resolve or send the music link.");
});

test("Navidrome never shares server credentials through artwork", async () => {
    const assets: string[] = [];
    const store = { nd_serverUrl: "https://music.example", nd_username: "private-user", nd_password: "private-password", nd_albumArtMode: "instance" };
    const { getActivity } = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
        "@webpack/common": {},
        "./assetCache": loadSource("src/equicordplugins/richPresence/services/assetCache.ts", {
            "@webpack/common": { ApplicationAssetUtils: { fetchAssetIds: async (_app: string, keys: string[]) => { assets.push(...keys); return keys; } } },
        }),
        "md5": { __esModule: true, default: () => "authentication-token" },
        "../settings": { settings: { store } },
    }, { fetch: async (url: string) => {
        assert.equal(new URL(url).origin, "https://music.example");
        assert.equal(new URL(url).pathname, "/rest/getNowPlaying");
        return response({ "subsonic-response": { nowPlaying: { entry: [{ id: "track", username: "private-user", coverArt: "cover" }] } } });
    } }, "({ getActivity })");
    assert.ok(await getActivity());
    assert.deepEqual(assets, ["navidrome"]);
});

test("Navidrome removes retired artwork selection even after earlier migrations", () => {
    const store = { _migrated: true, nd_albumArtMode: "instance" };
    const { migrateOldSettings } = loadSource("src/equicordplugins/richPresence/migration.ts", {
        "@api/Settings": { Settings: { plugins: { RichPresence: store } } },
        "@utils/Logger": { Logger: class {} },
        "./settings": { settings: { store } },
    });
    migrateOldSettings();
    assert.equal(store.nd_albumArtMode, "none");
    for (const mode of ["none", "lastfm"]) {
        store.nd_albumArtMode = mode;
        migrateOldSettings();
        assert.equal(store.nd_albumArtMode, mode);
    }
});

test("Navidrome refreshes track metadata and expires unchanged now-playing entries", async () => {
    let now = 100_000;
    let assetRequests = 0;
    const store = { nd_serverUrl: "https://music.example", nd_username: "listener", nd_password: "password", nd_detailsString: "{song}" };
    const track = { id: "track", username: "listener", title: "First title", duration: 10, minutesAgo: 0 };
    const { getActivity } = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
        "@webpack/common": {},
        "./assetCache": loadSource("src/equicordplugins/richPresence/services/assetCache.ts", {
            "@webpack/common": { ApplicationAssetUtils: { fetchAssetIds: async (_app: string, keys: string[]) => { assetRequests++; return keys; } } },
        }),
        "md5": { __esModule: true, default: () => "token" },
        "../settings": { settings: { store } },
    }, { Date: { now: () => now }, fetch: async () => response({ "subsonic-response": { nowPlaying: { entry: [track] } } }) }, "({ getActivity })");
    assert.equal((await getActivity()).details, "First title");
    track.title = "Corrected title";
    assert.equal((await getActivity()).details, "Corrected title");
    assert.equal(assetRequests, 1, "metadata refresh reuses the artwork lookup");
    now += 1000;
    store.nd_serverUrl = "https://other.example";
    assert.equal((await getActivity()).timestamps.start, now);
    now += 1000;
    store.nd_username = track.username = "other-listener";
    assert.equal((await getActivity()).timestamps.start, now);
    assert.equal(assetRequests, 1);
    now += 10_000;
    assert.equal(await getActivity(), null);
});


test("Navidrome format substitutions preserve literal metadata", () => {
    const format = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
        "@utils/Logger": { Logger: class {} }, "@utils/misc": {},
        "@vencord/discord-types/enums": {}, "@webpack/common": {},
        "md5": {}, "../settings": {}, "./assetCache": {},
    }, {}, "customFormat");
    assert.equal(format("{song} / {artist} / {song} / {unknown}", { title: "$& {artist}", artist: "Singer" }), "$& {artist} / Singer / $& {artist} / {unknown}");
    assert.equal(format("{album} {year} {quality}", { album: "Album", year: 2026, suffix: "flac", bitRate: 800 }), "Album 2026 FLAC 800kbps");
    assert.equal(format("{song}{artist}{album}{year}{quality}", {}), "");
    assert.equal(format(undefined, {}), "");
});


test("Navidrome retries failed Last.fm artwork requests", async () => {
    for (const failure of ["network", "http", "api", "missing"]) {
        let requests = 0;
        const track = { id: "track", username: "listener", artist: "Artist", album: "Album", title: "Song" };
        const getActivity = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
            "@utils/Logger": { Logger: class { error() {} warn() {} } },
            "@utils/misc": { parseUrl: (value: string) => new URL(value) },
            "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
            "@webpack/common": {}, "md5": { __esModule: true, default: () => "token" },
            "./assetCache": { getCachedApplicationAsset: async (_app: string, key: string) => key },
            "../settings": { settings: { store: { nd_serverUrl: "https://music.example", nd_username: "listener", nd_password: "password", nd_albumArtMode: "lastfm" } } },
        }, { fetch: async (url: string) => {
            if (new URL(url).origin === "https://music.example")
                return response({ "subsonic-response": { nowPlaying: { entry: [track] } } });
            requests++;
            if ((failure === "api" || failure === "missing") && requests <= 2)
                return response(failure === "api" ? { error: 11, message: "Service offline" } : {});
            if (requests === 1) {
                if (failure === "network") throw new Error("offline");
                return response({}, 503);
            }
            return response({ album: { image: [{ "#text": "https://images.example/cover.png" }] } });
        } }, "getActivity");
        assert.equal((await getActivity()).assets.large_image, "navidrome");
        assert.equal((await getActivity()).assets.large_image, "https://images.example/cover.png");
        await getActivity();
        assert.equal(requests, failure === "api" || failure === "missing" ? 3 : 2, "successful artwork stays cached after fallback and retry");
        for (const key of ["artist", "album", "title"] as const) {
            track[key] += " changed";
            const previous = requests;
            await getActivity();
            assert.equal(requests, previous + 1, `${key} changes invalidate artwork`);
        }
        track.id = "another-server-track-id";
        const previous = requests;
        await getActivity();
        assert.equal(requests, previous, "identical metadata reuses artwork across track IDs");
    }
});


test("Navidrome ignores invalid artwork URLs without caching them", async () => {
    for (const image of [42, {}, "invalid", "javascript:alert(1)", "data:image/png;base64,a", "https://user:password@images.example/cover.png"]) {
        let requests = 0;
        const assets: string[] = [];
        const getActivity = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
            "@utils/Logger": { Logger: class { error() {} warn() {} } },
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
            "@webpack/common": {}, "md5": { __esModule: true, default: () => "token" },
            "./assetCache": { getCachedApplicationAsset: async (_app: string, key: string) => { assets.push(key); return key; } },
            "../settings": { settings: { store: { nd_serverUrl: "https://music.example", nd_username: "listener", nd_password: "password", nd_albumArtMode: "lastfm" } } },
        }, { fetch: async (url: string) => {
            if (new URL(url).origin === "https://music.example")
                return response({ "subsonic-response": { nowPlaying: { entry: [{ id: "track", username: "listener", artist: "Artist", album: "Album" }] } } });
            requests++;
            return response({ album: { image: [{ "#text": image }] } });
        } }, "getActivity");
        await getActivity();
        await getActivity();
        assert.deepEqual(assets, ["navidrome", "navidrome"]);
        assert.equal(requests, 2);
    }
});

test("cancelled Navidrome artwork cannot refill caches or resolve assets", async () => {
    const artwork = Promise.withResolvers<Response>();
    const controller = new AbortController();
    let assetRequests = 0;
    const module = loadSource("src/equicordplugins/richPresence/services/navidrome.ts", {
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
        "@webpack/common": {}, "md5": { __esModule: true, default: () => "token" },
        "./assetCache": { getCachedApplicationAsset: async () => { assetRequests++; return "logo"; } },
        "../settings": { settings: { store: { nd_serverUrl: "https://music.example", nd_username: "listener", nd_password: "password", nd_albumArtMode: "lastfm" } } },
    }, { fetch: async (url: string) => new URL(url).origin === "https://music.example"
        ? response({ "subsonic-response": { nowPlaying: { entry: [{ id: "track", username: "listener", artist: "Artist", album: "Album" }] } } })
        : artwork.promise,
    }, "({ getActivity, cacheSize: () => lastFmCache.size })");
    const pending = module.getActivity(controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await setImmediate();
    controller.abort();
    artwork.resolve(response({ album: { image: [{ "#text": "https://images.example/cover.png" }] } }));
    await rejected;
    assert.equal(module.cacheSize(), 0);
    assert.equal(assetRequests, 0);
});

test("SongSpotlight settings reject stale account actions", async () => {
    let userId = "first";
    const calls: string[] = [];
    const effects: (() => (() => void) | void)[] = [];
    let confirm: () => Promise<void> = async () => {};
    const prefix = "@equicordplugins/songSpotlight.desktop/";
    const mocks: Record<string, object> = {};
    for (const name of ["@components/ErrorBoundary", "@components/Flex", "@utils/clipboard", prefix + "lib/oauth2", prefix + "service", prefix + "ui/common", prefix + "ui/settings/SongList", "@song-spotlight/api/structs"])
        mocks[name] = {};
    mocks["@components/Button"] = { Button: "button" };
    mocks["@utils/discord"] = {};
    mocks["@song-spotlight/api/util"] = { sid: JSON.stringify };
    mocks[prefix + "lib/utils"] = { cl: () => "" };
    mocks[prefix + "lib/api"] = { saveData: async () => calls.push("save"), deleteData: async () => calls.push("delete") };
    mocks[prefix + "lib/stores/AuthorizationStore"] = { useAuthorizationStore: () => ({ isAuthorized: () => true, deleteTokens: () => calls.push("logout") }) };
    mocks[prefix + "lib/stores/SongStore"] = { useSongStore: () => ({ users: { first: { data: [{ id: "song" }] }, second: { data: [] } }, self: { data: [{ id: "wrong-mirror" }] } }) };
    const module = loadComponent("src/equicordplugins/songSpotlight.desktop/ui/settings/index.tsx", {
        UserStore: { getCurrentUser: () => ({ id: userId }) }, useStateFromStores: (_stores: unknown[], select: () => unknown) => select(),
        useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}],
        useMemo: (fn: () => unknown) => fn(), useEffect: (effect: () => (() => void) | void) => effects.push(effect),
        Parser: { parse: () => "" }, Toasts: { Type: {} }, showToast() {},
        Alerts: { show: (options: { onConfirm(): Promise<void>; }) => { confirm = options.onConfirm; } },
    }, mocks);
    const wrapper = module.default({});
    const tree = wrapper.type(wrapper.props);
    const nodes: { props: { children?: unknown[]; onClick?(): unknown; }; }[] = [];
    const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value && typeof value === "object" && "props" in value) {
            const node = value as typeof nodes[number]; nodes.push(node); visit(node.props.children);
        }
    };
    visit(tree);
    const action = (label: string) => nodes.find(node => node.props.children?.includes(label))?.props.onClick;
    for (const label of ["Delete songs", "Save", "Sign out"]) assert.equal(typeof action(label), "function");
    await action("Save")?.();
    assert.deepEqual(calls, ["save"]);
    calls.length = 0;
    action("Delete songs")?.();
    userId = "second";
    await confirm();
    await action("Save")?.();
    action("Sign out")?.();
    assert.deepEqual(calls, []);
    assert.equal(module.default({}).props.userId, "second");
    assert.equal(module.default({}).props.key, "second");
    userId = "first";
    for (const effect of effects) effect()?.();
    await confirm();
    assert.deepEqual(calls, [], "unmounted editor cannot act after switching back");
});

test("SongSpotlight parsed songs preserve account and concurrent list updates", async () => {
    const source = readFileSync("src/equicordplugins/songSpotlight.desktop/ui/songs/index.tsx", "utf8");
    const start = source.indexOf("action={async () => {") + "action={async () => {".length;
    const end = source.indexOf("\n                            }}", start);
    assert.ok(start > 0 && end > start);
    for (const switched of [true, false]) {
        let userId = "first";
        const parsed = Promise.withResolvers<object>();
        const users = { first: { data: [{ id: "existing" }] }, second: { data: [] } };
        const opened: unknown[] = [];
        const action = runInNewContext(`(async () => {${source.slice(start, end)}})`, {
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            useSongStore: { getState: () => ({ users, self: { data: [{ id: "stale-mirror" }] } }) },
            Native: { parseLink: () => parsed.promise }, entry: { link: "https://example.com/song" },
            apiConstants: { songLimit: 6 }, sid: (song: { id: string }) => song.id,
            showToast() {}, Toasts: { Type: {} }, openSettingsModal: (songs: unknown[]) => opened.push(Array.from(songs)),
        });
        const pending = action();
        users.first.data.push({ id: "concurrent" });
        if (switched) userId = "second";
        parsed.resolve({ id: "parsed" });
        await pending;
        assert.deepEqual(opened, switched ? [] : [[{ id: "existing" }, { id: "concurrent" }, { id: "parsed" }]]);
    }
});


test("SongSpotlight failed loads can retry without creating an empty draft", async () => {
    const source = readFileSync("src/equicordplugins/songSpotlight.desktop/ui/settings/index.tsx", "utf8");
    const start = source.indexOf("    async function loadData() {");
    const end = source.indexOf("\n    useEffect", start);
    assert.ok(start >= 0 && end > start);
    let current = true;
    let pending = false;
    let data: unknown;
    let result = Promise.withResolvers<unknown>();
    const load = runInNewContext(`(${source.slice(start, end).trim()})`, {
        isCurrentAccount: () => current, setPending: (value: boolean) => { pending = value; },
        setLocalData: (value: unknown) => { data = value; }, getData: () => result.promise,
    });
    const failed = load();
    assert.equal(pending, true);
    result.reject(new Error("offline"));
    await failed;
    assert.equal(pending, false);
    assert.equal(data, undefined);
    result = Promise.withResolvers();
    const retry = load();
    const songs = [{ id: "saved" }];
    result.resolve(songs);
    await retry;
    assert.equal(data, songs);
    assert.equal(pending, false);
    result = Promise.withResolvers();
    const stale = load();
    current = false;
    result.resolve([]);
    await stale;
    assert.equal(data, songs);
    assert.match(source, /<Button onClick=\{loadData\}>Retry loading songs<\/Button>/);
});


test("SongSpotlight sends conditional headers only for cached timestamps", async () => {
    let responseData: unknown = [];
    let updates = 0;
    const users: Record<string, { at?: string; }> = {};
    const headers: Headers[] = [];
    const token = { access: "token" };
    const api = loadSource("src/equicordplugins/songSpotlight.desktop/lib/api.ts", {
        "@song-spotlight/api/structs": await import("@song-spotlight/api/structs"),
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, showToast() {}, Toasts: { Type: {} } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => token }) } },
        "./stores/SongStore": { useSongStore: { getState: () => ({ users, update() { updates++; } }) } },
    }, { URL, Headers, fetch: async (_url: URL, options: RequestInit) => {
        headers.push(new Headers(options.headers)); return response(responseData);
    } });
    await api.getData();
    await api.listData("other");
    assert.equal(headers[0].has("If-Modified-Since"), false);
    assert.equal(headers[1].has("If-Modified-Since"), false);
    users.self = { at: "Mon, 01 Jan 2024 00:00:00 GMT" };
    users.other = { at: "Tue, 02 Jan 2024 00:00:00 GMT" };
    await api.getData();
    await api.listData("other");
    assert.equal(headers[2].get("If-Modified-Since"), users.self.at);
    assert.equal(headers[3].get("If-Modified-Since"), users.other.at);
    responseData = null;
    assert.deepEqual(Array.from(await api.getData()), []);
    assert.deepEqual(Array.from(await api.listData("other")), []);
    for (const invalid of [{}, ["invalid"], [{ service: "unknown", type: "track", id: "id" }], Array.from({ length: 7 }, () => ({ service: "spotify", type: "track", id: "id" }))]) {
        responseData = invalid;
        await assert.rejects(api.getData());
        await assert.rejects(api.listData("other"));
    }
    assert.equal(updates, 6, "invalid responses never replace cached data");
});


test("SongSpotlight saves use only server modification timestamps", async () => {
    let at: string | undefined;
    const updates: { at?: string; }[] = [];
    const token = { access: "token" };
    const api = loadSource("src/equicordplugins/songSpotlight.desktop/lib/api.ts", {
        "@song-spotlight/api/structs": await import("@song-spotlight/api/structs"),
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, showToast() {}, Toasts: { Type: {} } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => token }) } },
        "./stores/SongStore": { useSongStore: { getState: () => ({ update: (value: { at?: string; }) => updates.push(value) }) } },
    }, { URL, Headers, fetch: async () => new Response("true", { headers: at ? { "Last-Modified": at } : {} }) });
    await api.saveData([]);
    assert.equal(updates[0].at, undefined);
    at = "Mon, 01 Jan 2024 00:00:00 GMT";
    await api.saveData([]);
    assert.equal(updates[1].at, at);
});


test("SongSpotlight requires write acknowledgement before changing local state", async () => {
    let result: unknown;
    const changes: string[] = [];
    const token = { access: "token" };
    const api = loadSource("src/equicordplugins/songSpotlight.desktop/lib/api.ts", {
        "@song-spotlight/api/structs": await import("@song-spotlight/api/structs"),
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, showToast() {}, Toasts: { Type: {} } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => token, deleteTokens: () => changes.push("logout") }) } },
        "./stores/SongStore": { useSongStore: { getState: () => ({ update: () => changes.push("save"), delete: () => changes.push("delete") }) } },
    }, { URL, Headers, fetch: async () => response(result) });
    for (const invalid of [false, null, {}, "true", []]) {
        result = invalid;
        await assert.rejects(api.saveData([]), /did not confirm the save/);
        await assert.rejects(api.deleteData(), /did not confirm the deletion/);
    }
    assert.deepEqual(changes, []);
    result = true;
    assert.equal(await api.saveData([]), true);
    assert.equal(await api.deleteData(), true);
    assert.deepEqual(changes, ["save", "delete", "logout"]);
});


test("new scheduled entries retain their initiating account across persistence", async () => {
    for (const scenario of ["signed-out", "same", "switched", "stopped"]) {
        let userId: string | undefined = scenario === "signed-out" ? undefined : "first";
        let saved: { userId: string; }[] = [];
        let previewChecks = 0;
        let finish: () => void = () => {};
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => undefined, set: async (_key: string, entries: { userId: string; }[]) => {
                saved = structuredClone(entries);
                await new Promise<void>(resolve => { finish = resolve; });
            } },
            "@utils/Logger": { Logger: class {} },
            "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined } },
            ".": { settings: { store: { maxMessagesPerMinute: 5, get showPhantomMessages() { previewChecks++; return false; } } } }
        });
        const pending = api.addScheduledMessage("channel", "Text", Date.now() + 60_000);
        await setImmediate();
        if (scenario === "switched") userId = "second";
        if (scenario === "stopped") api.stopScheduler();
        finish();
        const result = await pending;
        assert.equal(result.success, scenario !== "signed-out");
        assert.deepEqual(saved.map(entry => entry.userId), scenario === "signed-out" ? [] : ["first"]);
        assert.equal(previewChecks, scenario === "same" ? 1 : 0);
    }
});


test("scheduled sends reject unowned and foreign entries without marking them attempted", async () => {
    for (const owner of [undefined, "other"]) {
        const entry = scheduledEntry({ id: "queued", userId: owner, scheduledTime: 0 });
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [structuredClone(entry)], set: () => assert.fail("Rejected sends must not change storage") },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) },
                ChannelStore: { getChannel: () => assert.fail("Rejected sends must not enter the sender") } },
            ".": { settings: { store: {} } }
        }, {}, "({ ...exports, checkAndSendMessages })");
        await api.loadScheduledMessages();
        assert.equal((await api.sendScheduledMessageNow("queued")).success, false);
        await api.checkAndSendMessages();
        assert.equal(api.getScheduledMessages().length, 1);
        assert.equal(api.getScheduledMessages()[0].attemptedAt, undefined);
        assert.equal(api.getScheduledMessages()[0].userId, owner);
    }
});


test("scheduled previews reject missing and foreign owners before loading history", async () => {
    const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": {}, "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) },
            MessageStore: { hasPresent: () => assert.fail("Do not load history for another account") },
            FluxDispatcher: { dispatch: () => assert.fail("Do not insert a foreign preview") } },
        ".": { settings: { store: { showPhantomMessages: true } } }
    });
    for (const userId of [undefined, "other"]) {
        await api.createPhantomMessage({ id: "queued", userId, channelId: "channel" });
        assert.equal(api.phantomMessageMap.size, 0);
    }
});


test("scheduling rejects invalid dates without mutating saved messages", async () => {
    const originalTime = Date.now() + 60_000;
    const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@api/DataStore": { get: async () => [scheduledEntry({ id: "queued", userId: "account", scheduledTime: originalTime })],
            set: () => assert.fail("Invalid dates must not be persisted") },
        "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) },
            FluxDispatcher: { dispatch: () => assert.fail("Invalid dates must not remove previews") } },
        ".": { settings: { store: {} } }
    });
    await api.loadScheduledMessages();
    for (const time of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 0, Date.now() - 1]) {
        assert.equal((await api.addScheduledMessage("channel", "Text", time)).success, false);
        assert.equal(api.getScheduledMessages().length, 1);
        assert.equal(api.getScheduledMessages()[0].scheduledTime, originalTime);
    }
});


test("scheduled account events defer cleanup and cannot restart after stop", async () => {
    for (const scenario of ["logout", "connect", "stop-wait", "stop-load"]) {
        const events: string[] = [];
        let flush: () => void = () => {};
        let load: () => void = () => {};
        const { default: plugin } = loadSource("src/equicordplugins/scheduledMessages/index.tsx", {
            "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": { FluxDispatcher: { wait: (callback: () => void) => { flush = callback; } } },
            "./components/ChatBarButton": { setScheduleModeEnabled: (value: boolean) => { assert.equal(value, false); } },
            "./components/Icons": {}, "./components/MessageAccessory": {}, "./components/ViewScheduledModal": {},
            "./components/ScheduleTimeModal": {},
            "./utils": { stopScheduler: () => events.push("stop"), cleanupAllPhantomMessages: () => events.push("cleanup"),
                loadScheduledMessages: () => { events.push("load"); return new Promise<void>(resolve => { load = resolve; }); },
                startScheduler: () => events.push("start"), recreatePhantomMessages: async () => { events.push("preview"); } }
        });
        const pending = scenario === "logout" ? plugin.flux.LOGOUT() : plugin.flux.CONNECTION_OPEN();
        assert.deepEqual(events, ["stop"]);
        if (scenario === "stop-wait") plugin.stop();
        flush();
        await setImmediate();
        if (scenario === "stop-load") plugin.stop();
        load();
        await pending;
        assert.deepEqual(events, scenario === "logout" ? ["stop", "cleanup"]
            : scenario === "connect" ? ["stop", "cleanup", "load", "start", "preview"]
                : scenario === "stop-wait" ? ["stop", "stop", "cleanup"] : ["stop", "cleanup", "load", "stop", "cleanup"]);
    }
});


test("a newer account connection supersedes pending logout and connection work", async () => {
    for (const delayedLoad of [false, true]) {
        const waits: (() => void)[] = [];
        const loads: (() => void)[] = [];
        let starts = 0;
        let previews = 0;
        const { default: plugin } = loadSource("src/equicordplugins/scheduledMessages/index.tsx", {
            "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
            "@webpack/common": { FluxDispatcher: { wait: (callback: () => void) => waits.push(callback) } },
            "./components/ChatBarButton": { setScheduleModeEnabled() {} }, "./components/Icons": {},
            "./components/MessageAccessory": {}, "./components/ViewScheduledModal": {}, "./components/ScheduleTimeModal": {},
            "./utils": { stopScheduler() {}, cleanupAllPhantomMessages() { assert.equal(starts, 0, "Stale cleanup must not remove current previews"); },
                loadScheduledMessages: () => new Promise<void>(resolve => loads.push(resolve)),
                startScheduler: () => starts++, recreatePhantomMessages: async () => { previews++; } }
        });
        const old = plugin.flux.CONNECTION_OPEN();
        if (delayedLoad) { waits[0](); await setImmediate(); }
        const logout = plugin.flux.LOGOUT();
        const current = plugin.flux.CONNECTION_OPEN();
        waits[2]();
        await setImmediate();
        assert.equal(loads.length, delayedLoad ? 2 : 1);
        loads[loads.length - 1]();
        await current;
        assert.equal(starts, 1);
        assert.equal(previews, 1);
        waits[1]();
        if (delayedLoad) loads[0]();
        else waits[0]();
        await Promise.all([old, logout]);
        assert.equal(starts, 1);
        assert.equal(previews, 1);
    }
});


test("scheduled minute limits count only the initiating account", async () => {
    for (const owner of ["account", "other", undefined]) {
        const scheduledTime = Date.now() + 120_000;
        let writes = 0;
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [scheduledEntry({ id: "saved", userId: owner, channelId: "channel", scheduledTime })],
                set: async () => { writes++; } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) } },
            ".": { settings: { store: { maxMessagesPerMinute: 1, showPhantomMessages: false } } }
        });
        await api.loadScheduledMessages();
        assert.equal((await api.addScheduledMessage("channel", "Text", scheduledTime)).success, owner !== "account");
        assert.equal(writes, owner === "account" ? 0 : 1);
        assert.equal(api.getScheduledMessages()[0].userId, owner);
        assert.equal(api.getScheduledMessages().length, owner === "account" ? 1 : 2);
    }
});


test("clearing scheduled messages preserves other accounts and does nothing signed out", async () => {
    for (const userId of ["account", undefined]) {
        const removed: string[] = [];
        let writes = 0;
        const entries = [{ id: "mine", userId: "account" }, { id: "theirs", userId: "other" }, { id: "legacy" }].map(scheduledEntry);
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => structuredClone(entries), set: async () => { writes++; } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
                FluxDispatcher: { dispatch: ({ id }: { id: string; }) => removed.push(id) } },
            ".": { settings: { store: {} } }
        });
        await api.loadScheduledMessages();
        await api.clearAllScheduledMessages();
        assert.deepEqual(Array.from(api.getScheduledMessages(), (entry: { id: string; }) => entry.id), userId ? ["theirs"] : ["mine", "theirs", "legacy"]);
        assert.deepEqual(removed, userId ? ["scheduled-mine", "scheduled-legacy"] : []);
        assert.equal(writes, userId ? 1 : 0);
    }
});

test("scheduled message lists only render the current account and legacy entries", () => {
    for (const userId of ["account", "other", undefined]) {
        const rendered: string[] = [];
        const entries = [{ id: "mine", userId: "account" }, { id: "theirs", userId: "other" }, { id: "legacy" }].map(entry => ({ ...entry, channelId: entry.id, content: "Text", scheduledTime: 0 }));
        const component = loadSource("src/equicordplugins/scheduledMessages/components/ViewScheduledModal.tsx", {
            "@components/Button": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
            "@utils/css": { classNameFactory: () => () => "" },
            "@webpack/common": { useState: (value: unknown) => [value, () => {}], useStateFromStores: (_stores: unknown, selector: () => unknown) => selector(),
                UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined }, ChannelStore: { getChannel: () => undefined } },
            "../utils": { getScheduledMessages: () => entries, getChannelDisplayInfo: (id: string) => { rendered.push(id); return { name: id }; } }, "./Icons": {}
        }, { React: { createElement: () => null } }, "ViewScheduledModalInner");
        component({});
        assert.deepEqual(rendered, userId ? [userId === "account" ? "mine" : "theirs", "legacy"] : []);
    }
});


test("scheduled additions commit in order and failed additions never enter later saves", async () => {
    for (const failFirst of [false, true]) {
        const writes: { entries: { content: string; }[]; resolve: () => void; reject: (error: Error) => void; }[] = [];
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => undefined, set: (_key: string, entries: { content: string; }[]) => new Promise<void>((resolve, reject) => writes.push({ entries: structuredClone(entries), resolve, reject })) },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) } },
            ".": { settings: { store: { maxMessagesPerMinute: 1, showPhantomMessages: false } } }
        });
        const time = Date.now() + 120_000;
        const first = api.addScheduledMessage("channel", "First", time);
        const rejected = failFirst ? assert.rejects(first, /Storage failed/) : undefined;
        const second = api.addScheduledMessage("channel", "Second", time);
        await setImmediate();
        assert.equal(writes.length, 1);
        assert.equal(api.getScheduledMessages().length, 0);
        if (failFirst) writes[0].reject(new Error("Storage failed"));
        else writes[0].resolve();
        if (rejected) await rejected;
        else assert.equal((await first).success, true);
        await setImmediate();
        if (failFirst) {
            assert.equal(api.getScheduledMessages().length, 0);
            assert.deepEqual(writes[1].entries.map(entry => entry.content), ["Second"]);
            writes[1].resolve();
        }
        assert.equal((await second).success, failFirst);
        assert.equal(writes.length, failFirst ? 2 : 1);
        assert.equal(api.getScheduledMessages()[0].content, failFirst ? "Second" : "First");
    }
});

test("failed scheduled deletion preserves the queue and previews", async () => {
    for (const clear of [false, true]) {
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [scheduledEntry({ id: "saved", userId: "account" })], set: async () => { throw new Error("Storage failed"); } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) },
                FluxDispatcher: { dispatch: () => assert.fail("Do not remove previews before committing") } },
            ".": { settings: { store: {} } }
        });
        await api.loadScheduledMessages();
        await assert.rejects(clear ? api.clearAllScheduledMessages() : api.removeScheduledMessage("saved"), /Storage failed/);
        assert.equal(api.getScheduledMessages()[0].id, "saved");
    }
});


test("scheduled reaction writes preserve committed counts on failure and ignore removed previews", async () => {
    for (const scenario of ["success", "failure", "removed"]) {
        let writes = 0;
        let warnings = 0;
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => [scheduledEntry({ id: "saved", reactions: [{ emoji: { id: null, name: "hello" }, count: 1 }] })],
                set: async () => { writes++; if (scenario === "failure") throw new Error("Storage failed"); } },
            "@utils/Logger": { Logger: class { warn() { warnings++; } } }, "@vencord/discord-types/enums": {}, "@webpack/common": {},
            ".": { settings: { store: {} } }
        }, { setTimeout: () => 1 });
        await api.loadScheduledMessages();
        const original = api.getScheduledMessages()[0];
        api.phantomMessageMap.set("scheduled-saved", { messageId: "saved" });
        api.handleReactionAdd("scheduled-saved", "channel", { id: null, name: "hello" });
        if (scenario === "removed") api.phantomMessageMap.clear();
        await setImmediate();
        assert.equal(original.reactions[0].count, 1);
        assert.equal(api.getScheduledMessages()[0].reactions[0].count, scenario === "success" ? 2 : 1);
        assert.equal(writes, scenario === "removed" ? 0 : 1);
        assert.equal(warnings, scenario === "failure" ? 1 : 0);
    }
});


test("scheduled queue controls report failures without stale account feedback", async () => {
    for (const action of ["delete", "clear"]) for (const timing of ["current", "before", "during"]) {
        let userId = "account";
        let writes = 0;
        const notices: string[] = [];
        let reject: (error: Error) => void = () => {};
        let remove: () => Promise<void> = async () => assert.fail("Missing delete action");
        let clear: () => Promise<void> = async () => assert.fail("Missing clear action");
        const Button = Symbol("Button");
        const Modal = Symbol("Modal");
        const write = () => { writes++; return new Promise<void>((_resolve, fail) => { reject = fail; }); };
        const component = loadSource("src/equicordplugins/scheduledMessages/components/ViewScheduledModal.tsx", {
            "@components/Button": { Button }, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
            "@utils/css": { classNameFactory: () => () => "" },
            "@webpack/common": { Modal, useState: (value: unknown) => [value, () => assert.fail("Failed saves must not replace the list")],
                useStateFromStores: (_stores: unknown, selector: () => unknown) => selector(),
                UserStore: { getCurrentUser: () => ({ id: userId }) }, ChannelStore: { getChannel: () => undefined }, Toasts: { Type: { FAILURE: "failure" } },
                showToast: (message: string, type: string) => { assert.equal(type, "failure"); notices.push(message); } },
            "../utils": { getScheduledMessages: () => [{ id: "saved", userId: "account", content: "Text", scheduledTime: 0 }],
                getChannelDisplayInfo: () => ({ name: "Channel" }), removeScheduledMessage: write, clearAllScheduledMessages: write }, "./Icons": {}
        }, { React: { createElement: (type: unknown, props: { onClick: () => Promise<void>; actions: { text: string; onClick: () => Promise<void>; }[]; }) => {
            if (type === Button) remove = props.onClick;
            if (type === Modal) clear = props.actions[0].onClick;
            return null;
        } } }, "ViewScheduledModalInner");
        component({});
        if (timing === "before") userId = "other";
        const pending = action === "delete" ? remove() : clear();
        if (timing === "during") userId = "other";
        reject(new Error("Private storage details"));
        await pending;
        assert.equal(writes, timing === "before" ? 0 : 1);
        assert.deepEqual(notices, timing === "current" ? [action === "delete" ? "Could not remove the scheduled message. Try again." : "Could not clear scheduled messages. Try again."] : []);
    }
});


test("scheduled delays use the complete numeric input without truncating it", async () => {
    for (const [input, minutes] of [["1.5", 1.5], ["1e2", 100], ["5", 5], ["2oops", null], ["Infinity", null], ["0", null], ["", null]] as const) {
        const times: number[] = [];
        const Modal = Symbol("Modal");
        let schedule: () => Promise<void> = async () => assert.fail("Missing schedule action");
        const component = loadSource("src/equicordplugins/scheduledMessages/components/ScheduleTimeModal.tsx", {
            "@components/Button": {}, "@components/Heading": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
            "@utils/css": { classNameFactory: () => () => "" },
            "@webpack/common": { Modal, useRef: (value: unknown) => ({ current: value }),
                useState: (value: unknown) => [value === "5" ? input : value, () => {}], UserStore: { getCurrentUser: () => ({ id: "account" }) },
                ChannelStore: { getChannel: () => ({ isPrivate: () => true }) }, DraftType: { ChannelMessage: 0 }, DraftStore: { getDraft: () => "" },
                UploadAttachmentStore: { getUploads: () => [] }, UploadManager: { clearAll() {} }, showToast() {}, Toasts: { Type: {} } },
            "../utils": { getChannelDisplayInfo: () => ({ name: "Channel" }), addScheduledMessage: async (_channel: string, _content: string, time: number) => { times.push(time); return { success: true }; } }, "./Icons": {}
        }, { Date: class extends Date { static now() { return 100_000; } }, React: { createElement: (type: unknown, props: { actions: { onClick: () => Promise<void>; }[]; }) => {
            if (type === Modal) schedule = props.actions[0].onClick;
            return null;
        } } }, "ScheduleTimeModalInner");
        component({ userId: "account", uploadIds: [], channelId: "channel", content: "Text", close() {} });
        await schedule();
        assert.deepEqual(times, minutes === null ? [] : [100_000 + minutes * 60_000]);
    }
});


function scheduledEntry(overrides: Partial<import("../src/equicordplugins/scheduledMessages/types").ScheduledMessage>) {
    return { id: "queued", channelId: "channel", content: "Text", scheduledTime: 0, createdAt: 0, ...overrides };
}


test("invalid scheduled storage is preserved and blocks mutations until a valid reload", async () => {
    const row = scheduledEntry({ userId: "account" });
    const invalid: unknown[] = [null, {}, [null], new Array(1), [{ ...row, attachments: new Array(1) }], [{ ...row, reactions: new Array(1) }], [row, row], [{ ...row, content: 7 }], [{ ...row, scheduledTime: NaN }],
        [{ ...row, scheduledTime: Infinity }], [{ ...row, createdAt: Number.MAX_VALUE }], [{ ...row, attemptedAt: NaN }],
        [{ ...row, userId: "" }], [{ ...row, attachments: [{ filename: "file", data: 1, type: "text/plain" }] }],
        [{ ...row, reactions: [{ emoji: { id: null, name: "hello" }, count: -1 }] }], [{ ...row, reactions: [null] }]];
    for (let stored of invalid) {
        let writes = 0;
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => structuredClone(stored), set: async () => { writes++; } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, FluxDispatcher: { dispatch() {} } },
            ".": { settings: { store: { maxMessagesPerMinute: 3, showPhantomMessages: false } } }
        }, { setTimeout: () => assert.fail("Invalid entries must not reach a timer") });
        await assert.rejects(api.loadScheduledMessages(), /stored data has been preserved/);
        assert.equal(api.getScheduledMessages().length, 0);
        await assert.rejects(api.addScheduledMessage("channel", "Text", Date.now() + 60_000), /recovered/);
        await assert.rejects(api.clearAllScheduledMessages(), /recovered/);
        await assert.rejects(api.removeScheduledMessage("queued"), /recovered/);
        api.startScheduler();
        await setImmediate();
        api.stopScheduler();
        assert.equal(writes, 0);
        stored = [scheduledEntry({})];
        await api.loadScheduledMessages();
        assert.equal(api.getScheduledMessages().length, 1);
        assert.equal((await api.addScheduledMessage("channel", "Text", Date.now() + 60_000)).success, true);
        assert.equal(writes, 1);
    }
});

test("scheduled writes await initial storage validation and preserve existing entries", async () => {
    for (const mode of ["valid", "invalid", "failed", "implicit"] as const) {
        const original = mode === "invalid" ? { unexpected: true } : [scheduledEntry({})];
        let stored: unknown = original;
        let finish: (value: unknown) => void = () => assert.fail("Read not started");
        let fail: (error: Error) => void = () => assert.fail("Read not started");
        let writes = 0;
        let reads = 0;
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: () => {
                reads++;
                return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
            }, set: async (_key: string, value: unknown) => { writes++; stored = value; } },
            "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) }, FluxDispatcher: { dispatch() {} } },
            ".": { settings: { store: { maxMessagesPerMinute: 3, showPhantomMessages: false } } }
        });
        const loading = mode === "implicit" ? Promise.resolve() : api.loadScheduledMessages();
        const adding = api.addScheduledMessage("channel", "New", Date.now() + 60_000);
        const settled = Promise.allSettled([loading, adding]);
        await setImmediate();
        assert.equal(reads, 1);
        assert.equal(writes, 0);
        if (mode === "failed") fail(new Error("Read failed"));
        else finish(stored);
        const results = await settled;
        if (mode === "valid" || mode === "implicit") {
            assert.equal(results[1].status, "fulfilled");
            assert.equal(writes, 1);
            assert.deepEqual(Array.from(api.getScheduledMessages(), (entry: { content: string; }) => entry.content), ["Text", "New"]);
        } else {
            assert.equal(results[0].status, "rejected");
            assert.equal(results[1].status, "rejected");
            assert.equal(writes, 0);
            assert.equal(stored, original);
            await assert.rejects(api.clearAllScheduledMessages(), /recovered/);
            const recovery = api.loadScheduledMessages();
            await setImmediate();
            finish([]);
            await recovery;
            assert.equal((await api.addScheduledMessage("channel", "Recovered", Date.now() + 60_000)).success, true);
            assert.equal(writes, 1);
        }
    }
});

test("scheduled video previews draw the loaded frame and release media on every outcome", async () => {
    for (const mode of ["loaded", "decode", "timeout", "canvas", "draw", "encode"] as const) {
        let timeout: () => void = () => assert.fail("Missing timeout");
        let cleared = 0;
        let released = 0;
        let drawn = 0;
        const video = { src: "", videoWidth: 64, videoHeight: 32,
            onloadeddata: null as (() => void) | null, onerror: null as (() => void) | null,
            set currentTime(_value: number) { assert.fail("The loaded frame does not need a seek"); },
            removeAttribute(name: string) { assert.equal(name, "src"); this.src = ""; },
            load() { released++; }
        };
        const canvas = { getContext: () => mode === "canvas" ? null : {
            drawImage() { drawn++; if (mode === "draw") throw new Error("Frame unavailable"); },
            beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}
        }, toDataURL() { if (mode === "encode") throw new Error("Encoding failed"); return "data:image/png;base64,fixture"; } };
        const preview = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": {}, "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
            "@vencord/discord-types/enums": {}, "@webpack/common": {}, ".": { settings: { store: {} } }
        }, { document: { createElement: (tag: string) => tag === "video" ? video : canvas },
            setTimeout(callback: () => void, delay: number) { assert.equal(delay, 5000); timeout = callback; return 7; },
            clearTimeout(id: number) { assert.equal(id, 7); cleared++; }
        }, "getVideoPreview");
        const pending = preview("data:video/webm;base64,fixture");
        if (mode === "timeout") timeout();
        else if (mode === "decode") video.onerror?.();
        else video.onloadeddata?.();
        const result = await pending;
        if (mode === "loaded") {
            assert.equal(result.width, 64);
            assert.equal(result.height, 32);
            assert.equal(result.previewUrl, "data:image/png;base64,fixture");
            assert.equal(drawn, 1);
        } else assert.equal(result, null);
        assert.equal(cleared, 1);
        assert.equal(released, 1);
        assert.equal(video.src, "");
        assert.equal(video.onloadeddata, null);
        assert.equal(video.onerror, null);
    }
});

test("delayed scheduled reaction previews use committed entries and cannot revive removed previews", async () => {
    for (const mode of ["current", "edited", "deleted", "replaced", "stopped"] as const) {
        let stored = [scheduledEntry({ id: "saved", reactions: [{ emoji: { id: null, name: "hello" }, count: 1 }] })];
        const timers: (() => void)[] = [];
        const counts: number[] = [];
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@api/DataStore": { get: async () => structuredClone(stored), set: async () => {} },
            "@utils/Logger": { Logger: class { warn() {} } }, "@vencord/discord-types/enums": {},
            "@webpack/common": { FluxDispatcher: { dispatch() {} } }, ".": { settings: { store: {} } }
        }, { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; } },
        "({ ...exports, doRecreatePhantomMessage, setPreview: callback => { createPhantomMessage = callback; } })");
        await api.loadScheduledMessages();
        api.setPreview((entry: { reactions: { count: number; }[]; }) => counts.push(entry.reactions[0].count));
        api.phantomMessageMap.set("scheduled-saved", { messageId: "saved" });
        api.doRecreatePhantomMessage("scheduled-saved", "channel");
        assert.equal(timers.length, 1);
        if (mode === "edited") {
            stored = [scheduledEntry({ id: "saved", reactions: [{ emoji: { id: null, name: "hello" }, count: 2 }] })];
            await api.loadScheduledMessages();
        } else if (mode === "deleted") await api.removeScheduledMessage("saved");
        else if (mode === "replaced") api.phantomMessageMap.set("scheduled-saved", { messageId: "saved" });
        else if (mode === "stopped") api.cleanupAllPhantomMessages();
        timers[0]();
        assert.deepEqual(counts, mode === "current" ? [1] : mode === "edited" ? [2] : []);
        if (mode === "edited") assert.equal(api.getScheduledMessages()[0].reactions[0].count, 2);
    }
});

test("scheduled image dimensions fall back on timeout and release their source", async () => {
    for (const mode of ["loaded", "error", "timeout"] as const) {
        let timeout: () => void = () => assert.fail("Missing timeout");
        let cleared = 0;
        const img = { src: "", naturalWidth: 64, naturalHeight: 32,
            onload: null as (() => void) | null, onerror: null as (() => void) | null,
            removeAttribute(name: string) { assert.equal(name, "src"); this.src = ""; }
        };
        const dimensions = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": {}, "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
            "@vencord/discord-types/enums": {}, "@webpack/common": {}, ".": { settings: { store: {} } }
        }, { Image: function () { return img; },
            setTimeout(callback: () => void, delay: number) { assert.equal(delay, 5000); timeout = callback; return 3; },
            clearTimeout(id: number) { assert.equal(id, 3); cleared++; }
        }, "getImageDimensions");
        const pending = dimensions("data:image/png;base64,fixture");
        if (mode === "loaded") img.onload?.();
        else if (mode === "error") img.onerror?.();
        else timeout();
        const result = await pending;
        assert.equal(result.width, mode === "loaded" ? 64 : 400);
        assert.equal(result.height, mode === "loaded" ? 32 : 300);
        assert.equal(cleared, 1);
        assert.equal(img.src, "");
        assert.equal(img.onload, null);
        assert.equal(img.onerror, null);
    }
});

test("removed scheduled previews do not decode remaining attachments", async () => {
    for (const change of ["account", "removed", "replaced"] as const) {
        let userId = "account";
        const images: { onload: (() => void) | null; }[] = [];
        const api = loadSource("src/equicordplugins/scheduledMessages/utils.ts", {
            "@utils/misc": {}, "@api/DataStore": {}, "@utils/Logger": { Logger: class {} },
            "@vencord/discord-types/enums": {},
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) } },
            ".": { settings: { store: { showPhantomMessages: true } } }
        }, { Image: class {
            onload: (() => void) | null = null;
            constructor() { images.push(this); }
            removeAttribute() {}
        }, setTimeout: () => 1, clearTimeout() {} });
        const pending = api.createPhantomMessage(scheduledEntry({ userId: "account", attachments: [
            { filename: "first.png", type: "image/png", data: "first" },
            { filename: "second.png", type: "image/png", data: "second" }
        ] }));
        assert.equal(images.length, 1);
        if (change === "account") userId = "other";
        else if (change === "removed") api.phantomMessageMap.clear();
        else api.phantomMessageMap.set("scheduled-queued", { messageId: "queued" });
        images[0].onload?.();
        await pending;
        assert.equal(images.length, 1);
    }
});

test("theme downloads validate required IPC fields and scrub native failures", async () => {
    let failWrite = false;
    let requests = 0;
    let writes = 0;
    const api = loadSource("src/equicordplugins/themeLibrary/native.ts", {
        "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => file.includes("../") ? null : file },
        "@main/utils/constants": { THEMES_DIR: "themes" }, path,
        fs: { mkdtempSync: () => "temporary", renameSync() {}, rmSync() {}, rmdirSync() {}, writeFileSync() { if (failWrite) throw new Error("EACCES private/home/themes"); writes++; }, existsSync: () => true }
    }, { Buffer, AbortSignal, fetch: async () => { requests++; return new Response(".theme {}"); } });
    for (const theme of [null, {}, { id: "1" }, { id: "1", name: 7 }, { id: NaN, name: "Theme" }, { id: 1.5, name: "Theme" }, { id: -1, name: "Theme" }, { id: "", name: "Theme" }, { id: "1", name: "../outside" }]) {
        await assert.rejects(api.downloadTheme(null, theme), /Invalid theme details/);
    }
    assert.equal(requests, 0);
    assert.equal(writes, 0);
    assert.equal(await api.themeExists(null, { name: 7 }), false);
    await api.downloadTheme(null, { id: 91, name: "Theme" });
    assert.equal(writes, 1);
    failWrite = true;
    await assert.rejects(api.downloadTheme(null, { id: "1", name: "Theme" }), (error: Error) => error.message === "Theme download failed.");
    assert.equal(writes, 1);
});

test("theme downloads bound streamed responses before replacing the installed file", async () => {
    for (const mode of ["valid", "declared", "streamed", "broken", "timeout"] as const) {
        let writes = 0;
        let cancelled = 0;
        let deadline = 0;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                if (mode === "broken") { controller.error(new Error("Disconnected")); return; }
                controller.enqueue(new Uint8Array(mode === "streamed" ? 10 * 1024 * 1024 + 1 : 4));
                if (mode === "valid") controller.close();
            }, cancel() { cancelled++; }
        });
        const api = loadSource("src/equicordplugins/themeLibrary/native.ts", {
            "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => file },
            "@main/utils/constants": { THEMES_DIR: "themes" }, path, fs: { mkdtempSync: () => "temporary", renameSync() {}, rmSync() {}, rmdirSync() {}, writeFileSync() { writes++; } }
        }, { Buffer, AbortSignal: { timeout(ms: number) { deadline = ms; return new AbortController().signal; } },
            fetch: async (_url: string, options: RequestInit) => {
                assert.equal(options.redirect, "error");
                assert.ok(options.signal);
                if (mode === "timeout") throw new Error("Timed out");
                return new Response(body, { headers: mode === "declared" ? { "content-length": String(10 * 1024 * 1024 + 1) } : {} });
            }
        });
        const pending = api.downloadTheme(null, { name: "Theme", id: "1" });
        if (mode === "valid") await pending;
        else await assert.rejects(pending, /Theme download failed/);
        assert.equal(writes, mode === "valid" ? 1 : 0);
        assert.equal(cancelled, mode === "declared" || mode === "streamed" ? 1 : 0);
        assert.equal(deadline, 30_000);
    }
});

test("theme replacement preserves real installed files after partial writes and rename failures", async () => {
    const fs = await import("node:fs");
    for (const mode of ["success", "partial", "rename"] as const) {
        const root = fs.mkdtempSync(path.join(tmpdir(), "theme-replacement-"));
        const installed = path.join(root, "Existing.theme.css");
        const original = ".existing { color: red; }";
        const replacement = ".replacement { color: blue; }";
        fs.writeFileSync(installed, original);
        try {
            const api = loadSource("src/equicordplugins/themeLibrary/native.ts", {
                "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => path.join(root, file) },
                "@main/utils/constants": { THEMES_DIR: root }, path,
                fs: { ...fs, writeFileSync(file: string, content: string) {
                    assert.notEqual(file, installed);
                    assert.equal(path.dirname(path.dirname(file)), root);
                    fs.writeFileSync(file, mode === "partial" ? content.slice(0, 4) : content);
                    if (mode === "partial") throw new Error("Disk failed after a partial write");
                }, renameSync(source: string, destination: string) {
                    assert.equal(fs.readFileSync(installed, "utf8"), original);
                    if (mode === "rename") throw new Error("Replacement denied");
                    fs.renameSync(source, destination);
                } }
            }, { Buffer, AbortSignal, fetch: async () => new Response(replacement) });
            const pending = api.downloadTheme(null, { id: "1", name: "Existing" });
            if (mode === "success") await pending;
            else await assert.rejects(pending, /Theme download failed/);
            assert.equal(fs.readFileSync(installed, "utf8"), mode === "success" ? replacement : original);
            assert.deepEqual(fs.readdirSync(root), ["Existing.theme.css"]);
        } finally {
            fs.unlinkSync(installed);
            fs.rmdirSync(root);
        }
    }
});

test("theme names cannot traverse directories or address file streams", async () => {
    let pathChecks = 0;
    const api = loadSource("src/equicordplugins/themeLibrary/native.ts", {
        "@main/ipcMain": { ensureSafePath: (_root: string, file: string) => { pathChecks++; return file; } },
        "@main/utils/constants": { THEMES_DIR: "themes" }, path,
        fs: { existsSync: () => true }
    }, { fetch: () => assert.fail("Invalid names must not start a download") });
    for (const name of ["../outside", "folder/theme", "folder\\theme", "theme:stream", "bad\0name"]) {
        assert.equal(await api.themeExists(null, { name }), false);
        await assert.rejects(api.downloadTheme(null, { id: "1", name }), /Invalid theme details/);
    }
    assert.equal(pathChecks, 0);
    for (const name of ["Material Discord", "日本語", "Dots.in.name"]) {
        assert.equal(await api.themeExists(null, { name }), true);
    }
    assert.equal(pathChecks, 3);
});

test("theme filters follow enabled links immediately without sorting source state", () => {
    const statuses = { ALL: 0, ENABLED: 1, DISABLED: 2, LIKED: 3 };
    const themes = Object.freeze([
        { id: 1, name: "Older", description: "", author: { discord_name: "Author" }, tags: [], likes: 10, release_date: "2024-01-01" },
        { id: 2, name: "Newer", description: "", author: { discord_name: "Author" }, tags: [], likes: 1, release_date: "2025-01-01" }
    ]);
    let links: string[] = [];
    let status = statuses.ALL;
    let cursor = 0;
    let cards: { theme: { id: number; }; removePreview?: boolean; }[] = [];
    const Card = {};
    const React = { createElement(type: unknown, props: { theme: { id: number; }; removePreview?: boolean; } | null) {
        if (type === Card && props) cards.push(props);
        return null;
    } };
    const component = loadSource("src/equicordplugins/themeLibrary/components/ThemeTab.tsx", {
        "@api/DataStore": {}, "@api/Settings": { Settings: { themeLinks: links, plugins: { ThemeLibrary: { hideWarningCard: true } } } },
        "@components/ErrorCard": {}, "@components/Heading": {}, "@components/Icons": {}, "@components/Paragraph": {},
        "@components/settings": { wrapTab: (value: unknown) => value },
        "@equicordplugins/themeLibrary/types": { SearchStatus: statuses },
        "@utils/Logger": { Logger: class {} }, "@utils/margins": { Margins: {} }, "@utils/misc": { classes: () => "" },
        "@webpack": { findCssClassesLazy: () => ({}) }, "./ThemeCard": { ThemeCard: Card },
        "@webpack/common": { React, useEffect() {}, useState: () => [
            [themes, links, undefined, { value: "", status }, true, false, false][cursor++], () => {}
        ] }
    }, {}, "ThemeTab");
    const render = () => { cursor = 0; cards = []; component(); return cards.filter(card => !card.removePreview).map(card => card.theme.id); };
    assert.deepEqual(render(), [2, 1]);
    status = statuses.ENABLED;
    assert.deepEqual(render(), []);
    links = ["https://themes.equicord.org/api/1"];
    assert.deepEqual(render(), [1]);
    status = statuses.DISABLED;
    assert.deepEqual(render(), [2]);
    status = statuses.LIKED;
    assert.deepEqual(render(), [1, 2]);
    assert.deepEqual(cards.filter(card => card.removePreview).map(card => card.theme.id), [1, 2]);
    assert.deepEqual(themes.map(theme => theme.id), [1, 2]);
});

test("theme tab cleanup aborts catalog work and suppresses late token requests", async () => {
    let effect: () => (() => void) = () => { throw new Error("Missing effect"); };
    let token: (value: string) => void = () => {};
    let finish: (value: Response) => void = () => {};
    let updates = 0;
    let errors = 0;
    const requests: { url: string; signal?: AbortSignal | null; }[] = [];
    const api = loadSource("src/equicordplugins/themeLibrary/components/ThemeTab.tsx", {
        "@api/DataStore": { get: () => new Promise<string>(resolve => { token = resolve; }) },
        "@api/Settings": { Settings: { themeLinks: [], plugins: { ThemeLibrary: { hideWarningCard: true } } } },
        "@components/ErrorCard": {}, "@components/Heading": {}, "@components/Icons": {}, "@components/Paragraph": {},
        "@components/settings": { wrapTab: (value: unknown) => value },
        "@equicordplugins/themeLibrary/types": { SearchStatus: { ALL: 0, LIKED: 1 } },
        "@utils/Logger": { Logger: class { error() { errors++; } } }, "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: () => "" }, "@webpack": { findCssClassesLazy: () => ({}) }, "./ThemeCard": {},
        "@webpack/common": { React: { createElement: () => null },
            useState: (initial: unknown) => [initial, () => { updates++; }],
            useEffect: (callback: () => (() => void)) => { effect = callback; } }
    }, { AbortController, fetch: (url: string, options: RequestInit) => {
        requests.push({ url, signal: options.signal });
        return new Promise<Response>(resolve => { finish = resolve; });
    } }, "({ ThemeTab, fetchAllThemes })");
    api.ThemeTab();
    const cleanup = effect();
    assert.equal(requests.length, 1);
    cleanup();
    assert.equal(requests[0].signal?.aborted, true);
    token("late-token");
    finish(new Response("[]"));
    await setImmediate();
    assert.equal(requests.length, 1);
    assert.equal(updates, 0);
    assert.equal(errors, 0);
    const failed = api.fetchAllThemes();
    finish(new Response("[]", { status: 503 }));
    await assert.rejects(failed, /Could not fetch the theme list/);
});

test("theme like requests lock before authorization and unlock after denied authorization", async () => {
    let authorize: (value: boolean) => void = () => {};
    let checks = 0;
    let posts = 0;
    let click: () => Promise<void> = async () => {};
    const Button = {};
    const api = loadSource("src/equicordplugins/themeLibrary/components/LikesComponent.tsx", {
        "@components/Button": { Button }, "@components/margins": { Margins: {} },
        "@equicordplugins/themeLibrary/utils/auth": {
            isAuthorized: () => { checks++; return new Promise<boolean>(resolve => { authorize = resolve; }); },
            getThemeLibraryToken: async () => "fixture-token"
        }, "@equicordplugins/themeLibrary/utils/Icons": { LikeIcon: () => null },
        "@webpack/common": { useEffect() {}, useRef: () => ({ current: false }), useState: (initial: unknown) => {
            return [initial, () => {}];
        } }, "./ThemeTab": { logger: { error() {} }, themeRequest: async (_endpoint: string, options?: RequestInit) => {
            if (options?.method === "POST") posts++;
            return new Response(JSON.stringify({ likes: [] }));
        } }
    }, { React: { createElement(type: unknown, props: { onClick: () => Promise<void>; }) {
        if (type === Button) click = props.onClick;
        return null;
    } } });
    api.LikesComponent({ themeId: 91, likedThemes: { likes: [] } });
    const first = click();
    await click();
    assert.equal(checks, 1);
    authorize(false);
    await first;
    assert.equal(posts, 0);
    const second = click();
    await click();
    assert.equal(checks, 2);
    authorize(true);
    await second;
    assert.equal(posts, 1);
});

test("theme authorization rejects every unsuccessful HTTP response", async () => {
    let status = 200;
    const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
        "@api/DataStore": { get: async () => "fixture-token" },
        "@api/Notifications": {}, "@webpack/common": {},
        "@equicordplugins/themeLibrary/components/ThemeTab": { logger: {}, themeRequest: async (endpoint: string) => {
            assert.equal(endpoint, "/user/findUserByToken");
            return new Response("{}", { status });
        } }
    });
    for (const code of [200, 400, 401, 403, 404, 429, 500, 503]) {
        status = code;
        assert.equal(await api.getAuthorization(), code === 200 ? "fixture-token" : false);
    }
});

test("theme token reads observe replacements and cannot repopulate a stale cache", async () => {
    const reads: ((token: string | undefined) => void)[] = [];
    const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
        "@api/DataStore": { get: () => new Promise<string | undefined>(resolve => reads.push(resolve)) },
        "@api/Notifications": {}, "@webpack/common": {},
        "@equicordplugins/themeLibrary/components/ThemeTab": { logger: {} }
    });
    const older = api.getThemeLibraryToken();
    const newer = api.getThemeLibraryToken();
    assert.equal(reads.length, 2);
    reads[1]("new-token");
    assert.equal(await newer, "new-token");
    reads[0]("old-token");
    assert.equal(await older, "old-token");
    const deleted = api.getThemeLibraryToken();
    reads[2](undefined);
    assert.equal(await deleted, null);
    const replacement = api.getThemeLibraryToken();
    reads[3]("replacement-token");
    assert.equal(await replacement, "replacement-token");
});

test("theme revocation cannot clear a token saved while the request was pending", async () => {
    for (const newer of [false, true]) for (const status of [200, 503]) {
        let stored: string | undefined = "old-token";
        let finish: (value: Response) => void = () => {};
        let notices = 0;
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@api/DataStore": { get: async () => stored,
                update: async (_key: string, mutate: (token: string | undefined) => string | undefined) => { stored = mutate(stored); } },
            "@api/Notifications": { showNotification: () => { notices++; } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) } },
            "@equicordplugins/themeLibrary/components/ThemeTab": { logger: {}, themeRequest: (endpoint: string, options: RequestInit) => {
                assert.equal(endpoint, "/user/revoke");
                assert.equal((options.headers as Record<string, string>).Authorization, "Bearer old-token");
                return new Promise<Response>(resolve => { finish = resolve; });
            } }
        });
        const pending = api.deauthorizeUser();
        await setImmediate();
        if (newer) stored = "new-token";
        finish(new Response("{}", { status }));
        await pending;
        assert.equal(stored, newer ? "new-token" : undefined);
        assert.equal(notices, !newer && status === 200 ? 1 : 0);
    }
});

test("theme authorization checks the provider once before offering a dialog", async () => {
    for (const valid of [false, true]) for (const triggerModal of [false, true]) {
        let requests = 0;
        let dialogs = 0;
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@api/DataStore": { get: async () => "fixture-token" }, "@api/Notifications": {},
            "@webpack/common": { openModal: () => { dialogs++; } },
            "@equicordplugins/themeLibrary/components/ThemeTab": { logger: {}, themeRequest: async () => {
                requests++; return new Response("{}", { status: valid ? 200 : 401 });
            } }
        });
        assert.equal(await api.isAuthorized(triggerModal), valid);
        assert.equal(requests, 1);
        assert.equal(dialogs, !valid && triggerModal ? 1 : 0);
    }
});

test("theme authorization only saves string tokens from successful responses", async () => {
    for (const value of [undefined, null, {}, [], 7, "", "valid-token"]) {
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@api/DataStore": { get: async () => value }, "@api/Notifications": {}, "@webpack/common": {},
            "@equicordplugins/themeLibrary/components/ThemeTab": {}
        });
        assert.equal(await api.getThemeLibraryToken(), value === "valid-token" ? value : null);
    }
    for (const body of [null, { token: {} }, { token: 7 }, { token: "" }, { token: "valid-token" }]) for (const status of [200, 503]) {
        const saved: unknown[] = [];
        const notices: string[] = [];
        let callback: (result: { location: string; }) => Promise<void> = async () => {};
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@api/DataStore": { get: async () => undefined, set: async (_key: string, value: unknown) => { saved.push(value); } },
            "@api/Notifications": { showNotification: (notice: { body: string; }) => notices.push(notice.body) },
            "@webpack/common": { openModal: (render: (props: object) => unknown) => render({}) },
            "@equicordplugins/themeLibrary/components/ThemeTab": { logger: { error() {} } }
        }, { React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; return null; } },
            fetch: async () => new Response(JSON.stringify(body), { status }) });
        await api.authorizeUser();
        await callback({ location: "https://themes.equicord.org/api/user/auth?code=fixture" });
        const valid = status === 200 && body?.token === "valid-token";
        assert.deepEqual(saved, valid ? ["valid-token"] : []);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].startsWith("Successfully"), valid);
    }
});

test("theme OAuth callbacks only fetch the declared authorization endpoint", async () => {
    const locations = ["https://themes.equicord.org/api/user/auth?code=fixture", "http://themes.equicord.org/api/user/auth", "https://other.example/api/user/auth",
        "https://themes.equicord.org/api/other", "https://user:pass@themes.equicord.org/api/user/auth", "not a URL"];
    for (const location of locations) {
        let callback: (result: { location: string; }) => Promise<void> = async () => {};
        let requests = 0;
        let writes = 0;
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
            "@api/DataStore": { get: async () => undefined, set: async () => { writes++; } },
            "@api/Notifications": { showNotification() {} },
            "@webpack/common": { openModal: (render: (props: object) => unknown) => render({}) },
            "@equicordplugins/themeLibrary/components/ThemeTab": { logger: { error() {} } }
        }, { React: { createElement: (_type: unknown, props: { callback: typeof callback; }) => { callback = props.callback; return null; } },
            fetch: async (url: string, options: RequestInit) => {
                requests++; assert.equal(url, locations[0]); assert.equal(options.redirect, "error");
                return new Response(JSON.stringify({ token: "fixture-token" }));
            } });
        await api.authorizeUser();
        await callback({ location });
        assert.equal(requests, location === locations[0] ? 1 : 0);
        assert.equal(writes, requests);
    }
});

test("theme revocation reports storage and network failures without clearing authorization", async () => {
    for (const failure of ["storage", "network"]) {
        let notices = 0;
        let errors = 0;
        const api = loadSource("src/equicordplugins/themeLibrary/utils/auth.tsx", {
            "@utils/misc": {},
            "@api/DataStore": { get: async () => { if (failure === "storage") throw new Error("Read failed"); return "fixture-token"; },
                update: () => assert.fail("Do not clear the token when no revoke response was received") },
            "@api/Notifications": { showNotification: (notice: { body: string; }) => { notices++; assert.ok(notice.body.startsWith("Failed")); } },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) } },
            "@equicordplugins/themeLibrary/components/ThemeTab": { logger: { error: () => { errors++; } },
                themeRequest: async () => { throw new Error("Network failed"); } }
        });
        await api.deauthorizeUser();
        assert.equal(notices, 1);
        assert.equal(errors, 1);
    }
});

test("installer rejects unsafe clone names and malformed links before any side effects", async () => {
    let allowDialog = false;
    const mocks: Record<string, object> = {
        child_process: { spawn: () => assert.fail("No clone") },
        electron: { dialog: { showMessageBox: () => { if (!allowDialog) assert.fail("No dialog"); return Promise.resolve({ response: 0 }); } } },
        fs: {}, "fs/promises": { rm: () => assert.fail("No cleanup") }, path, "yaml-js": {}
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") });
    for (const repo of [".", "..", "", "x".repeat(256)]) {
        await assert.rejects(api.initPluginInstall(null, `https://github.com/owner/${repo}`, "github.com", "owner", repo), /Invalid link/);
    }
    for (const link of [null, 7, "not a repository", "https://github.com/owner/repo extra", "x".repeat(8193)]) {
        await assert.rejects(api.initPluginInstall(null, link, "github.com", "owner", "repo"), /Invalid link/);
    }
    await assert.rejects(api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "other", "repo"), /Invalid link/);
    allowDialog = true;
    await assert.rejects(api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo"), /Rejected by user/);
});

test("plugin cloning settles launch failures and unsuccessful exits without deleting source", async () => {
    for (const stage of ["launch", "exit", "success"]) {
        let clones = 0;
        const mocks: Record<string, object> = {
            child_process: { spawn: () => {
                clones++;
                const proc = new EventEmitter();
                queueMicrotask(() => {
                    if (stage === "launch") proc.emit("error", new Error("Private executable path"));
                    proc.emit("close", stage === "success" ? 0 : 1);
                });
                return proc;
            } }, electron: {}, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") }, "({ cloneRepo })");
        const pending = api.cloneRepo("https://github.com/owner/repo", ".install-fixture");
        if (stage === "success") await pending;
        else await assert.rejects(pending, stage === "launch" ? /Could not start Git/ : /Failed to clone the plugin/);
        assert.equal(clones, 1);
    }
});

test("plugin metadata stops at missing entries and rejects malformed declarations", async () => {
    for (const entry of [null, "index.ts", "index.tsx", "index.js", "index.jsx"]) {
        for (const valid of [false, true]) {
            let reads = 0;
            const mocks: Record<string, object> = {
                child_process: {}, electron: {}, "fs/promises": {}, path, "yaml-js": {},
                fs: { existsSync: (file: string) => file === path.join("fixture", "native/index.ts"), readdirSync: () => entry ? [entry, "native"] : ["README.md"],
                    readFileSync: (filename: string) => {
                        reads++;
                        if (filename.endsWith("meta.yml") || filename.endsWith("config")) throw new Error("Optional file missing");
                        assert.ok(entry && filename.endsWith(entry));
                        return valid ? 'export default definePlugin({ authors: [], description: "A fixture.", tags: [], name: "Fixture", onBeforeMessageSend() {} });' : "export default {};";
                    } }
            };
            for (const name of ["pluginValidate", "updateValidate"])
                mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
            const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") }, "({ getPluginMeta })");
            const pending = api.getPluginMeta("fixture", { directory: "fixture" });
            if (!entry) {
                await assert.rejects(pending, /Plugin entry file is missing/);
                assert.equal(reads, 0);
            } else if (!valid) await assert.rejects(pending, /Plugin metadata is invalid/);
            else {
                const meta = await pending;
                assert.equal(meta.name, "Fixture");
                assert.equal(meta.description, "A fixture.");
                assert.equal(meta.usesNative, true);
                assert.equal(meta.usesPreSend, true);
                assert.equal(meta.directory, "fixture");
                assert.equal(meta.remote, "");
            }
        }
    }
});

test("plugin updates reject preparation failures before opening a review window", async () => {
    for (const stage of ["metadata", "target", "history", "success"]) {
        let commands = 0;
        let windows = 0;
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => "abortInstall" };
            constructor() { super(); windows++; }
            async loadURL(url: string) { assert.ok(url.startsWith("data:text/html;base64,")); }
            close() { this.emit("closed"); }
            show() { queueMicrotask(() => this.emit("page-title-updated")); }
        }
        const mocks: Record<string, object> = {
            child_process: { exec: (command: string, options: { cwd: string; }, callback: (error: Error | null, stdout: string) => void) => {
                if (command === "git rev-parse origin/HEAD") return callback(null, stage === "target" ? "invalid; command" : "a".repeat(40));
                commands++;
                assert.ok(command.startsWith("git log HEAD.." + "a".repeat(40) + " "));
                assert.equal(options.cwd, "fixture");
                callback(stage === "history" ? new Error("Private Git path") : null, "");
            } },
            electron: { BrowserWindow: ReviewWindow }, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "%PLUGINNAME%" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), Buffer },
            "({ ...exports, setup(metadata) { getPluginDirectory = () => 'fixture'; getPluginMeta = metadata; } })");
        api.setup(async () => {
            if (stage === "metadata") throw new Error("Private metadata path");
            return { name: "Fixture", description: "A fixture.", remote: "https://github.com/owner/repo" };
        });
        await assert.rejects(api.updatePlugin(null, "fixture"), (error: unknown) => stage === "success" ? error === "Rejected by user"
            : (error as Error).message === (stage === "metadata" ? "Could not read the plugin metadata." : stage === "target" ? "Could not resolve the plugin update." : "Could not read the plugin update history."));
        assert.equal(commands, stage === "metadata" || stage === "target" ? 0 : 1);
        assert.equal(windows, stage === "success" ? 1 : 0);
    }
});

test("plugin updates build only after Git succeeds and report build failures", async () => {
    for (const failure of ["git", "build", "none"]) {
        const commands: string[] = [];
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => "install" };
            async loadURL() {}
            close() { this.emit("closed"); }
            show() { queueMicrotask(() => this.emit("page-title-updated")); }
        }
        const mocks: Record<string, object> = {
            child_process: { exec: (command: string, _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
                if (command === "git rev-parse origin/HEAD") return callback(null, "a".repeat(40), "");
                commands.push(command);
                const fails = failure === "git" && command.startsWith("git rebase") || failure === "build" && command.startsWith("pnpm");
                callback(fails ? new Error("Private path") : null, "", "Success is not an exit status");
            } },
            electron: { BrowserWindow: ReviewWindow }, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks,
            { __dirname: path.resolve("fixture/dist"), Buffer, process: { env: {} } },
            "({ ...exports, setup() { let reads = 0; getPluginDirectory = () => 'fixture'; getPluginMeta = async () => ({ name: 'Fixture', description: '', remote: '', usesNative: ++reads > 1 }); } })");
        api.setup();
        const pending = api.updatePlugin(null, "fixture");
        if (failure === "none") assert.deepEqual({ ...await pending }, { name: "Fixture", native: true });
        else await assert.rejects(pending, /Could not update the plugin/);
        assert.equal(commands.length, failure === "git" ? 2 : 3);
        assert.equal(commands[1], "git rebase " + "a".repeat(40));
        if (failure !== "git") assert.equal(commands[2], "pnpm build --dev");
    }
});

test("closed or failed plugin reviews reject and prevent later install actions", async () => {
    for (const [operation, failure] of [["initPluginInstall", "close"], ["updatePlugin", "close"], ["initPluginInstall", "load"], ["updatePlugin", "load"]]) {
        let commands = 0;
        let closed = 0;
        let removals = 0;
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => "install" };
            async loadURL() { if (failure === "load") throw new Error("Private load error"); }
            close() { closed++; this.emit("closed"); this.emit("page-title-updated"); }
            show() { if (failure === "close") queueMicrotask(() => this.close()); }
        }
        const mocks: Record<string, object> = {
            child_process: { exec: (_command: string, _options: object, callback: (error: null, stdout: string) => void) => { if (_command === "git rev-parse origin/HEAD") return callback(null, "a".repeat(40)); commands++; callback(null, ""); } },
            electron: { BrowserWindow: ReviewWindow, dialog: { showMessageBox: async () => ({ response: 1 }) } },
            fs: {}, "fs/promises": { mkdtemp: async (prefix: string) => prefix + "fixture", rename: async () => {}, rm: async (directory: string) => { assert.equal(directory, "fixture"); removals++; } }, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), Buffer },
            "({ ...exports, setup() { cloneRepo = async () => {}; getPluginDirectory = () => 'fixture'; getPluginMeta = async () => ({ name: 'Fixture', description: '', remote: '' }); } })");
        api.setup();
        const pending = operation === "updatePlugin" ? api.updatePlugin(null, "fixture")
            : api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo");
        await assert.rejects(pending, failure === "close" ? /Review window closed/ : /Could not load the plugin review/);
        assert.equal(closed, 1);
        assert.equal(removals, operation === "initPluginInstall" ? 1 : 0);
        assert.equal(commands, operation === "updatePlugin" ? 1 : 0);
    }
});

test("cancelled plugin installs validate cleanup paths and settle removal failures", async () => {
    for (const failure of ["path", "remove", "none"]) {
        let validations = 0;
        let removals = 0;
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => "abortInstall" };
            async loadURL() {}
            close() { this.emit("closed"); }
            show() { queueMicrotask(() => this.emit("page-title-updated")); }
        }
        const mocks: Record<string, object> = {
            child_process: {}, electron: { BrowserWindow: ReviewWindow, dialog: { showMessageBox: async () => ({ response: 1 }) } },
            fs: {}, "fs/promises": { mkdtemp: async (prefix: string) => prefix + "fixture", rename: async () => {}, rm: async (directory: string) => {
                removals++; assert.equal(directory, "validated-fixture");
                if (failure === "remove") throw new Error("Private filesystem path");
            } }, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), Buffer },
            "({ ...exports, setup(validate) { getPluginDirectory = validate; cloneRepo = async () => {}; getPluginMeta = async () => ({ name: 'Fixture', description: '' }); } })");
        api.setup((name: string) => {
            validations++; assert.equal(name, ".install-fixture");
            if (failure === "path" && validations === 2) throw new Error("Invalid plugin directory.");
            return "validated-fixture";
        });
        await assert.rejects(api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo"),
            (error: unknown) => failure === "none" ? error === "Rejected by user" : (error as Error).message === "Could not remove the cancelled plugin installation.");
        assert.equal(validations, 2);
        assert.equal(removals, failure === "path" ? 0 : 1);
    }
});

test("plugin clones use the exact metadata directory including Git suffixes", async () => {
    for (const repo of ["repo", "repo.git", "-repo"]) {
        const link = `https://github.com/owner/${repo}`;
        const mocks: Record<string, object> = {
            child_process: { spawn: (command: string, args: string[], options: { cwd: string; }) => {
                assert.equal(command, "git");
                assert.deepEqual(Array.from(args), ["clone", "--", link, path.join(options.cwd, repo)]);
                assert.equal(options.cwd, path.resolve("fixture/src/userplugins"));
                const proc = new EventEmitter();
                queueMicrotask(() => proc.emit("close", 0));
                return proc;
            } }, electron: {}, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") }, "({ cloneRepo })");
        await api.cloneRepo(link, repo);
    }
});

test("update link completion cannot become an install action or read a closed window", async () => {
    for (const failure of [false, true, "file:///private", "https://other.example/commit/" + "a".repeat(40), "https://github.com/owner/repo/commit/not-a-hash"]) {
        let title = "openLink:https://github.com/owner/repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (typeof failure === "string") title = `openLink:${failure}`;
        let opened = 0;
        let commands = 0;
        let reads = 0;
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => { reads++; return title; } };
            async loadURL() {}
            close() { this.emit("closed"); }
            show() { queueMicrotask(() => this.emit("page-title-updated")); }
        }
        const mocks: Record<string, object> = {
            child_process: { exec: (_command: string, _options: object, callback: (error: null, stdout: string) => void) => { if (_command === "git rev-parse origin/HEAD") return callback(null, "a".repeat(40)); commands++; callback(null, ""); } },
            electron: { BrowserWindow: ReviewWindow, shell: { openExternal: async () => {
                opened++;
                title = "install";
                if (failure) throw new Error("Private browser path");
            } } }, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        let window: ReviewWindow | undefined;
        mocks.electron = { ...mocks.electron, BrowserWindow: class extends ReviewWindow { constructor() { super(); window = this; } } };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), Buffer, URL },
            "({ ...exports, setup() { getPluginDirectory = () => 'fixture'; getPluginMeta = async () => ({ name: 'Fixture', description: '', remote: 'https://github.com/owner/repo' }); } })");
        api.setup();
        const pending = api.updatePlugin(null, "fixture");
        const rejected = assert.rejects(pending, failure ? /Could not open the update link/ : /Review window closed/);
        await setImmediate();
        if (!failure) window?.close();
        await rejected;
        assert.equal(commands, 1);
        assert.equal(reads, 1);
        assert.equal(opened, typeof failure === "string" ? 0 : 1);
    }
});

test("plugin metadata does not trust literals overwritten by dynamic properties", async () => {
    for (const override of ['name: getName()', 'get name() { throw new Error("Do not execute"); }', '...other', '[key]: "other"', 'description: `Value ${getValue()}`']) {
        const mocks: Record<string, object> = {
            child_process: {}, electron: {}, "fs/promises": {}, path, "yaml-js": {},
            fs: { readdirSync: () => ["index.ts"], readFileSync: (file: string) => {
                if (!file.endsWith("index.ts")) throw new Error("Optional file missing");
                return `export default definePlugin({ name: "Earlier", description: "Earlier description", ${override} });`;
            } }
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") }, "({ getPluginMeta })");
        await assert.rejects(api.getPluginMeta("fixture"), /Plugin metadata is invalid/);
    }
});

test("plugin update checks use Git reference resolution and stop after fetch failure", async () => {
    for (const result of ["fetch-error", "refs-error", "same", "different"]) {
        const commands: string[] = [];
        const mocks: Record<string, object> = {
            child_process: { exec: (command: string, options: { cwd: string; env?: Record<string, string>; }, callback: (error: Error | null, stdout: string) => void) => {
                commands.push(command); assert.equal(options.cwd, "fixture");
                if (command === "git fetch") {
                    assert.equal(options.env?.GIT_TERMINAL_PROMPT, "0");
                    assert.equal(options.env?.GCM_INTERACTIVE, "false");
                    assert.equal(options.env?.PATH, "fixture-path");
                }
                callback(result === "fetch-error" || result === "refs-error" && commands.length === 2 ? new Error("Git failed") : null,
                    result === "different" ? "2\n" : "0\n");
            } }, electron: {}, fs: {}, "fs/promises": {}, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), process: { env: { PATH: "fixture-path", GCM_INTERACTIVE: "true" } } },
            "({ ...exports, setup() { getPluginDirectory = () => 'fixture'; } })");
        api.setup();
        assert.equal(await api.isUpdateAvailableForPlugin(null, "fixture"), result === "different");
        assert.deepEqual(commands, result === "fetch-error" ? ["git fetch"] : ["git fetch", "git rev-list --count HEAD..origin/HEAD"]);
    }
});

test("plugin directory setup reports filesystem failure without leaking its path", async () => {
    for (const enabled of [false, true]) {
        let calls = 0;
        const mocks: Record<string, object> = {
            child_process: {}, electron: {}, fs: {}, path, "yaml-js": {},
            "fs/promises": { mkdir: async () => { calls++; throw new Error("Private directory path"); } }
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist"), IS_DEV: enabled });
        if (enabled) await assert.rejects(api.ensurePluginsDirectory(), /Could not create the userplugins directory/);
        else await api.ensurePluginsDirectory();
        assert.equal(calls, enabled ? 1 : 0);
    }
});

test("installer setup failures reject the caller without exposing native errors", async () => {
    for (const stage of ["dialog", "clone", "metadata", "browser"]) {
        let removals = 0;
        const fail = async () => { throw new Error("Private filesystem path"); };
        const mocks: Record<string, object> = {
            child_process: {},
            electron: { dialog: { showMessageBox: stage === "dialog" ? fail : async () => ({ response: stage === "browser" ? 2 : 1 }) }, shell: { openExternal: fail } },
            fs: {}, "fs/promises": { mkdtemp: async (prefix: string) => prefix + "fixture", rename: async () => {}, rm: async (directory: string) => { assert.equal(directory, "fixture"); removals++; } }, path, "yaml-js": {}
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") },
            "({ ...exports, setup(clone, metadata) { cloneRepo = clone; getPluginMeta = metadata; getPluginDirectory = () => 'fixture'; } })");
        api.setup(stage === "clone" ? fail : async () => {}, fail);
        const messages = { dialog: "Could not open the clone confirmation.", clone: "Could not clone the plugin.", metadata: "Could not read the plugin metadata.", browser: "Could not open the repository." };
        await assert.rejects(api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo"),
            (error: Error) => error.message === messages[stage]);
        assert.equal(removals, stage === "metadata" || stage === "clone" ? 1 : 0);
    }
});

test("installer mutation guard remains held through review closure and build settlement", async () => {
    for (const failBuild of [false, true]) for (const previousNative of [false, true]) {
        let openReview: (window: ReviewWindow) => void = () => {};
        const reviewOpened = new Promise<ReviewWindow>(resolve => { openReview = resolve; });
        let finishBuild: () => void = () => {};
        const pendingBuild = new Promise<void>((resolve, reject) => {
            finishBuild = () => failBuild ? reject(new Error("Build failed")) : resolve();
        });
        let builds = 0;
        let clones = 0;
        class ReviewWindow extends EventEmitter {
            static getAllWindows() { return []; }
            webContents = { getTitle: () => "install" };
            async loadURL() {}
            show() { openReview(this); }
            close() { this.emit("closed"); }
        }
        const mocks: Record<string, object> = {
            "child_process": {},
            "electron": { BrowserWindow: ReviewWindow, dialog: { showMessageBox: async () => ({ response: 1 }) } },
            "fs": { existsSync: (file: string) => previousNative && (path.basename(file) === "repo" || file.endsWith("native.ts")) }, "fs/promises": { mkdtemp: async (prefix: string) => prefix + "fixture", rename: async () => {}, rm: async () => {},}, path, "yaml-js": {},
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const native = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, {
            __dirname: path.resolve("fixture/dist"), Buffer,
            onClone: async () => { clones++; },
            onBuild: () => { builds++; return pendingBuild; },
        }, "({ ...exports, setup() { getPluginDirectory = () => 'fixture'; cloneRepo = onClone; build = onBuild; getPluginMeta = async () => ({ name: 'Fixture', description: 'Fixture', usesNative: false }); } })");
        native.setup();
        const installation = native.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo");
        const settled = installation.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
        const review = await reviewOpened;
        for (const action of [
            () => native.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo"),
            () => native.updatePlugin(null, "repo"),
            () => native.rmPlugin(null, "repo"),
        ]) await assert.rejects(action(), /Another plugin operation/);
        review.emit("page-title-updated");
        await setImmediate();
        assert.equal(builds, 1);
        await assert.rejects(native.rmPlugin(null, "repo"), /Another plugin operation/);
        assert.equal(clones, 1);
        finishBuild();
        const result = await settled;
        if (failBuild) assert.match(String(result.error), /Build failed/);
        else assert.deepEqual({ ...result.value }, { name: "Fixture", native: previousNative });
        await assert.rejects(native.initPluginInstall(null, "invalid", "", "", ""), /Invalid link/);
    }
});

test("installer background fetches wait for mutations and prevent deletion until settled", async () => {
    let finishFetch: () => void = () => {};
    let commands = 0;
    const mocks: Record<string, object> = {
        child_process: { exec: (command: string, options: unknown, callback: (error: Error | null, output: string) => void) => {
            commands++;
            if (command === "git fetch") finishFetch = () => callback(null, "");
            else callback(null, "0");
        } }, electron: {}, fs: {}, "fs/promises": {}, path, "yaml-js": {},
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") },
        "({ ...exports, hold: runPluginMutation, setup() { getPluginDirectory = () => 'fixture'; } })");
    api.setup();
    let finishMutation: () => void = () => {};
    const mutation = api.hold(() => new Promise<void>(resolve => { finishMutation = resolve; }));
    const scan = api.isUpdateAvailableForPlugin(null, "fixture");
    assert.equal(commands, 0);
    finishMutation();
    await mutation;
    assert.equal(commands, 1);
    await assert.rejects(api.rmPlugin(null, "fixture"), /Another plugin operation/);
    finishFetch();
    assert.equal(await scan, false);
    assert.equal(commands, 2);
    assert.equal(await api.hold(async () => "released"), "released");
});

test("installer scans only ignore missing children, not root or permission failures", async () => {
    for (const stage of ["root", "child"]) for (const code of ["ENOENT", "EACCES"]) {
        let calls = 0;
        let commands = 0;
        const mocks: Record<string, object> = {
            child_process: { exec: () => { commands++; } }, electron: {},
            fs: { realpathSync: (value: string) => {
                calls++;
                if (calls === (stage === "root" ? 1 : 2)) throw Object.assign(new Error("Private filesystem path"), { code });
                return path.resolve(value);
            } }, "fs/promises": {}, path, "yaml-js": {},
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") });
        const scan = api.isUpdateAvailableForPlugin(null, "example");
        if (stage === "child" && code === "ENOENT") assert.equal(await scan, false);
        else await assert.rejects(scan, { message: "Invalid plugin directory." });
        assert.equal(commands, 0);
    }
});

test("installer metadata normalizes clone suffixes before building repository links", async () => {
    for (const suffix of ["", "/", ".git", ".git/"]) for (const ending of ["\n", "\r\n", ""]) {
        const remote = `https://github.com/owner/repo${suffix}`;
        const mocks: Record<string, object> = {
            child_process: { execFile: (command: string, args: string[], options: { cwd: string; }, callback: (error: Error | null, stdout: string) => void) => {
                assert.equal(command, "git");
                assert.deepEqual([...args], ["config", "--local", "--get", "remote.origin.url"]);
                assert.equal(options.cwd, "fixture");
                callback(null, remote + ending);
            } }, electron: {}, "fs/promises": {}, path, "yaml-js": {},
            fs: {
                readdirSync: () => ["index.ts", ".git"],
                readFileSync: (file: string) => {
                    if (file.endsWith("index.ts")) return 'export default definePlugin({name:"Fixture",description:"Fixture"});';
                    throw new Error("Missing metadata");
                },
            },
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") }, "({ getPluginMeta, formatCommitMessages })");
        const meta = await api.getPluginMeta("fixture");
        assert.equal(meta.remote, "https://github.com/owner/repo");
        const sha = "a".repeat(40);
        assert.ok(api.formatCommitMessages(`Author////////aaaaaaa////////${sha}////////Message`, meta.remote).includes(`href="https://github.com/owner/repo/commit/${sha}"`));
    }
});

test("installer holds ownership until failed-install cleanup settles", async () => {
    for (const failCleanup of [false, true]) {
        let finishCleanup: () => void = () => {};
        let cleanupStarted: () => void = () => {};
        const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
        const mocks: Record<string, object> = {
            child_process: {}, electron: { dialog: { showMessageBox: async () => ({ response: 1 }) } },
            fs: {}, "fs/promises": { mkdtemp: async (prefix: string) => prefix + "fixture", rename: async () => {}, rm: () => new Promise<void>((resolve, reject) => {
                finishCleanup = () => failCleanup ? reject(new Error("Private cleanup error")) : resolve();
                cleanupStarted();
            }) }, path, "yaml-js": {},
        };
        for (const name of ["pluginValidate", "updateValidate"])
            mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
        const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, { __dirname: path.resolve("fixture/dist") },
            "({ ...exports, setup() { cloneRepo = async () => {}; getPluginDirectory = () => 'fixture'; getPluginMeta = async () => { throw new Error('Invalid metadata'); }; } })");
        api.setup();
        const installation = api.initPluginInstall(null, "https://github.com/owner/repo", "github.com", "owner", "repo");
        const rejection = assert.rejects(installation, failCleanup ? /Could not remove the cancelled plugin installation/ : /Could not read the plugin metadata/);
        await started;
        await assert.rejects(api.rmPlugin(null, "fixture"), /Another plugin operation/);
        finishCleanup();
        await rejection;
        await assert.rejects(api.initPluginInstall(null, "invalid", "", "", ""), /Invalid link/);
    }
});

test("installer inventory excludes hidden folders and files before reading metadata", async () => {
    const reads: string[] = [];
    const mocks: Record<string, object> = {
        child_process: {}, electron: {}, fs: {}, path, "yaml-js": {},
        "fs/promises": { readdir: async () => ["visible", ".staged", "_disabled", "file", "invalid"].map(name => ({ name, parentPath: "fixture", isDirectory: () => name !== "file" })) },
    };
    for (const name of ["pluginValidate", "updateValidate"])
        mocks[`file://misc/${name}.txt?trim=false`] = { __esModule: true, default: "" };
    const api = loadSource("src/equicordplugins/userpluginInstaller.dev/native.ts", mocks, {
        __dirname: path.resolve("fixture/dist"),
        metadata: async (directory: string, extra: { directory: string; }) => {
            reads.push(directory);
            if (extra.directory === "invalid") throw new Error("Invalid metadata");
            return { name: "Visible", ...extra };
        },
    }, "({ ...exports, setup() { getPluginMeta = metadata; } })");
    api.setup();
    const plugins = await api.getUserplugins();
    assert.deepEqual(reads, [path.join("fixture", "visible"), path.join("fixture", "invalid")]);
    assert.deepEqual(Array.from(plugins, (plugin: { name: string; directory: string; }) => ({ ...plugin })), [{ name: "Visible", directory: "visible" }]);
});


test("narrator preserves combining marks in multilingual names", () => {
    const store = { latinOnly: false };
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": {}, "./settings": { settings: { store } }
    }, {}, "({ clean })");
    for (const name of ["अमित", "مُحَمَّد", "José", "李明"])
        assert.equal(api.clean(name), name.normalize("NFKC"));
    assert.equal(api.clean("  Alice___💡  "), "Alice_");
    store.latinOnly = true;
    assert.equal(api.clean("Alice 李明"), "Alice");
});

test("narrator starts from the existing voice channel and resets across restarts", () => {
    let channelId: string | undefined = "existing";
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": { SelectedChannelStore: { getVoiceChannelId: () => channelId } },
        "./settings": { settings: {} }
    }, {}, "({ plugin: exports.default, getTypeAndChannelId })");
    api.plugin.start?.();
    assert.equal(api.getTypeAndChannelId({ channelId: "existing", oldChannelId: "existing" }, true)[0], "");
    assert.equal(api.getTypeAndChannelId({ channelId: "next", oldChannelId: "next" }, true)[0], "move");
    assert.equal(api.getTypeAndChannelId({}, true)[0], "leave");
    api.plugin.stop();
    channelId = undefined;
    api.plugin.start?.();
    assert.equal(api.getTypeAndChannelId({ channelId: "fresh", oldChannelId: "fresh" }, true)[0], "join");
    api.plugin.flux.LOGOUT?.();
    assert.equal(api.getTypeAndChannelId({ channelId: "another-account", oldChannelId: "another-account" }, true)[0], "join");
});

test("narrator tracks silent stage visits before returning to a voice channel", () => {
    let channelId = "voice";
    const spoken: string[] = [];
    const { default: plugin } = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": {
            SelectedChannelStore: { getVoiceChannelId: () => channelId },
            ChannelStore: { getChannel: (id: string) => ({ name: id, type: id === "stage" ? 13 : 2 }) },
            UserStore: { getCurrentUser: () => ({ id: "me" }) },
            AuthenticationStore: { getSessionId: () => "session" }
        },
        "./settings": { settings: { store: { moveMessage: "Moved to {{CHANNEL}}" } }, getCurrentVoice() {} }
    }, { window: { speechSynthesis: { speak: ({ text }: { text: string; }) => spoken.push(text) } }, SpeechSynthesisUtterance: class { constructor(public text: string) {} } });
    plugin.start();
    const event = () => plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "me", channelId, oldChannelId: channelId, sessionId: "session" }] });
    channelId = "stage";
    event();
    assert.deepEqual(spoken, []);
    channelId = "voice";
    event();
    assert.deepEqual(spoken, ["Moved to voice"]);
    event();
    assert.deepEqual(spoken, ["Moved to voice"]);
});

test("narrator uses the announced voice channel guild for nicknames", () => {
    const spoken: { text: string; }[] = [];
    const guildReads: string[] = [];
    let guildId: string | undefined = "voice-guild";
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": {
            SelectedGuildStore: { getGuildId: () => "browsed-guild" },
            SelectedChannelStore: { getVoiceChannelId: () => "voice" },
            ChannelStore: { getChannel: () => ({ guild_id: guildId, name: "General", type: 2 }) },
            UserStore: { getCurrentUser: () => ({ id: "me" }), getUser: () => ({ username: "Username", globalName: "Display" }) },
            AuthenticationStore: { getSessionId: () => "session" },
            GuildMemberStore: { getNick: (guild: string) => { guildReads.push(guild); return guild === "voice-guild" ? "Voice nickname" : "Wrong nickname"; } }
        },
        "./settings": { settings: { store: { joinMessage: "{{NICKNAME}} joined {{CHANNEL}}", leaveMessage: "{{NICKNAME}} left {{CHANNEL}}" } }, getCurrentVoice() {} }
    }, { window: { speechSynthesis: { speak: (speech: { text: string; }) => spoken.push(speech) } }, SpeechSynthesisUtterance: class { constructor(public text: string) {} } });
    api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", channelId: "voice" }] });
    api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", oldChannelId: "voice" }] });
    guildId = undefined;
    api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", channelId: "voice" }] });
    assert.deepEqual(spoken.map(speech => speech.text), ["Voice nickname joined General", "Voice nickname left General", "Display joined General"]);
    assert.deepEqual(guildReads, ["voice-guild", "voice-guild"]);
});

test("narrator settings offer samples without requiring English voices or a speech API", () => {
    const Button = Symbol("Button");
    let buttons = 0;
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": { Margins: {} }, "@utils/text": { wordsToTitle: (words: string[]) => words.join(" ") },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": { Button, useMemo: (read: () => unknown) => read() },
        "./settings": { settings: { def: { joinMessage: {}, leaveMessage: {}, volume: {} } } }
    }, { window: {}, React: { createElement: (type: unknown) => { if (type === Button) buttons++; return {}; } } });
    api.default.settingsAboutComponent();
    assert.equal(buttons, 2);
});

test("narrator speech tolerates an unavailable API and uses the browser default voice", () => {
    const window: { speechSynthesis?: { speak: (speech: unknown) => void; }; __OVERLAY__?: boolean; } = {};
    const spoken: unknown[] = [];
    let selectedVoice: object | undefined;
    class Utterance {
        voice: object | null = null;
        constructor(public text: string) {}
    }
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/ErrorCard": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/Logger": {}, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": {}, "./settings": { settings: { store: { volume: 0.5, rate: 1.5 } }, getCurrentVoice: () => selectedVoice }
    }, { window, SpeechSynthesisUtterance: Utterance }, "({ speak })");
    api.speak("Unavailable");
    window.speechSynthesis = { speak: speech => spoken.push(speech) };
    api.speak("Default");
    assert.equal((spoken[0] as Utterance).voice, null);
    selectedVoice = { voiceURI: "chosen" };
    api.speak("Selected");
    assert.equal((spoken[1] as Utterance).voice, selectedVoice);
    assert.equal((spoken[1] as Utterance).text, "Selected");
    assert.equal(Reflect.get(spoken[1] as object, "volume"), 0.5);
    assert.equal(Reflect.get(spoken[1] as object, "rate"), 1.5);
    api.speak("");
    window.__OVERLAY__ = true;
    api.speak("Overlay");
    assert.equal(spoken.length, 2);
});

test("narrator formatting preserves placeholder text inside names", () => {
    const api = loadSource("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} },
        "@components/ErrorCard": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/Logger": {}, "@utils/margins": {}, "@utils/text": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "@webpack/common": {}, "./settings": { settings: { store: { latinOnly: false } } }
    }, {}, "({ formatText })");
    assert.equal(api.formatText("{{USER}} joined {{CHANNEL}}", "Name {{CHANNEL}}", "General", "", ""), "Name {{CHANNEL}} joined General");
    assert.equal(api.formatText("{{CHANNEL}} {{DISPLAY_NAME}} {{NICKNAME}} {{USER}} {{USER}} {{OTHER}}", "Alice", "{{DISPLAY_NAME}}", "{{NICKNAME}}", "Nick"), "{{DISPLAY_NAME}} {{NICKNAME}} Nick Alice Alice {{OTHER}}");
    assert.equal(api.formatText("{{USER}}/{{CHANNEL}}/{{DISPLAY_NAME}}/{{NICKNAME}}", "", "", "💡", ""), "/channel/Someone/");
});

test("narrator voice lookup preserves the selected voice while voices load", () => {
    const store = { voice: "preferred" };
    const api = loadSource("src/plugins/vcNarrator/settings.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { OptionType: {} }, "./VoiceSetting": {}
    }, { window: {} });
    const fallback = { voiceURI: "fallback", default: true };
    const preferred = { voiceURI: "preferred", default: false };
    assert.equal(api.getCurrentVoice([]), undefined);
    assert.equal(store.voice, "preferred");
    assert.equal(api.getCurrentVoice([fallback]), fallback);
    assert.equal(store.voice, "preferred");
    assert.equal(api.getCurrentVoice([fallback, preferred]), preferred);
    assert.equal(api.getCurrentVoice(), undefined);
    assert.equal(store.voice, "preferred");
});


test("narrator language picker keeps voices with unrecognized language tags", () => {
    for (const language of ["not_a_language", "en"]) {
        const voices = Array.from({ length: 21 }, (_, id) => ({ lang: language, voiceURI: String(id), name: String(id) }));
        let grouped = 0;
        const api = loadSource("src/plugins/vcNarrator/VoiceSetting.tsx", {
            "@utils/constants": { IS_LINUX: false },
            "@components/Heading": {}, "@components/Paragraph": {},
            "@webpack/common": { lodash: { groupBy: (items: unknown, key: (voice: object) => string) => {
                grouped++;
                assert.equal(items, voices);
                assert.equal(key(voices[0]), language);
                return { [language]: voices };
            } }, useMemo: (read: () => unknown) => read(), useState: (read: () => unknown) => [read(), () => {}] },
            "./settings": { getCurrentVoice: (items: unknown) => { assert.equal(items, voices); }, settings: {} }
        }, { React: { createElement: (type: unknown, props: object) => ({ type, props }) }, Intl }, "({ ComplexPicker })");
        const picker = api.ComplexPicker({ voices, voice: "0" });
        assert.equal(grouped, 1);
        assert.equal(picker.props.voices, voices);
        assert.equal(picker.props.voice, "0");
    }
});


test("narrator voice picker observes voice loading and releases its listener", () => {
    class Voices extends EventTarget {
        available: { voiceURI: string; }[] = [];
        getVoices() { return this.available; }
    }
    const synthesis = new Voices();
    let value: unknown;
    let effect: () => (() => void) = () => assert.fail("Missing effect");
    const api = loadSource("src/plugins/vcNarrator/VoiceSetting.tsx", {
            "@utils/constants": { IS_LINUX: false },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@webpack/common": {
            useState: (initial: () => unknown) => { value ??= initial(); return [value, (next: unknown) => { value = next; }]; },
            useEffect: (callback: typeof effect) => { effect = callback; }
        },
        "./settings": { settings: { use: () => ({ voice: "preferred" }) } }
    }, { window: { speechSynthesis: synthesis }, React: { createElement: (type: unknown, props: object) => ({ type, props }) }, Intl }, "({ VoiceSetting })");
    api.VoiceSetting();
    const cleanup = effect();
    synthesis.available = [{ voiceURI: "preferred" }];
    synthesis.dispatchEvent(new Event("voiceschanged"));
    assert.equal(api.VoiceSetting().props.voices, synthesis.available);
    const previous = value;
    cleanup();
    synthesis.available = [];
    synthesis.dispatchEvent(new Event("voiceschanged"));
    assert.equal(value, previous);
});

test("narrator language picker falls back when its selected language disappears", () => {
    const english = [{ lang: "en", voiceURI: "english" }];
    const german = [{ lang: "de", voiceURI: "german" }];
    const api = loadSource("src/plugins/vcNarrator/VoiceSetting.tsx", {
            "@utils/constants": { IS_LINUX: false },
        "@components/Heading": {}, "@components/Paragraph": {},
        "@webpack/common": { lodash: { groupBy: () => ({ en: english, de: german }) }, useMemo: (read: () => unknown) => read(), useState: () => ["removed", () => {}] },
        "./settings": { settings: {} }
    }, { React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) }, Intl }, "({ ComplexPicker })");
    const picker = api.ComplexPicker({ voices: [...english, ...german], voice: "english" });
    assert.equal(picker.children[1].props.value, "en");
    assert.equal(picker.children[3].props.voices, english);
});

test("sticker blocking reads current settings without a startup cache", () => {
    const store = { blockedStickers: "first, second, first" };
    const subscriptions: unknown[] = [];
    const { plugin, toggleBlock } = loadSource("src/equicordplugins/stickerBlocker/index.tsx", {
        "@api/ContextMenu": {},
        "@api/Settings": { definePluginSettings: () => ({ store, use: (keys: unknown) => {
            subscriptions.push(keys);
            return store;
        } }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} }, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": {}
    }, {}, "({ plugin: exports.default, toggleBlock })");
    assert.equal(plugin.isBlocked("first"), true);
    toggleBlock("first");
    assert.equal(store.blockedStickers, "second");
    assert.equal(plugin.isBlocked("first"), false);
    store.blockedStickers = "third";
    assert.equal(plugin.isBlocked("second"), false);
    assert.equal(plugin.isBlocked("third"), true);
    toggleBlock("fourth");
    assert.equal(store.blockedStickers, "third, fourth");
    assert.deepEqual(Array.from(subscriptions[0] as string[]), ["blockedStickers"]);
    assert.ok(subscriptions.every(keys => keys === subscriptions[0]));
});

test("sticker block picker actions use sticker formats instead of CSS names", () => {
    let format: number | undefined;
    const { default: plugin } = loadComponent("src/equicordplugins/stickerBlocker/index.tsx", {
        Menu: { MenuItem: "item" },
        StickersStore: { getStickerById: () => format === undefined ? undefined : { format_type: format } }
    }, {
        "@api/ContextMenu": {},
        "@api/Settings": { definePluginSettings: () => ({ store: { blockedStickers: "" } }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}) }
    });
    for (format of [undefined, 1, 2, 3, 4]) {
        for (const className of ["renamed", "lottieCanvas_legacy"]) {
            const children: unknown[] = [];
            plugin.contextMenus["expression-picker"](children, { target: { dataset: { id: "sticker", type: "sticker" }, className } });
            assert.equal(children.length, format === undefined || format === 3 ? 0 : 1);
        }
    }
    const children: unknown[] = [];
    plugin.contextMenus["expression-picker"](children, { target: { dataset: { id: "emoji", type: "emoji" } } });
    assert.equal(children.length, 0);
});

test("sticker link menus share format support regardless of picker CSS", () => {
    type MenuTree = { props: { children: Array<{ props: { children: Array<{ props: { action(): void; }; }>; }; }>; }; };
    const copied: string[] = [];
    let sticker: { id: string; format_type: number; } | undefined;
    const { default: plugin } = loadComponent("src/plugins/copyStickerLinks/index.tsx", {
        Menu: { MenuGroup: "group", MenuItem: "item" },
        StickersStore: { getStickerById: () => sticker }
    }, {
        "@api/ContextMenu": {}, "@api/PluginManager": { isPluginEnabled: () => false },
        "@plugins/expressionCloner": { __esModule: true, default: { name: "ExpressionCloner" } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: (url: string) => copied.push(url) },
        "@utils/types": { __esModule: true, default: (value: object) => value }
    }, { window: { GLOBAL_ENV: { CDN_HOST: "cdn.fixture.invalid", MEDIA_PROXY_ENDPOINT: "//media.fixture.invalid" } } });
    for (const format of [1, 2, 3, 4]) {
        sticker = { id: "sticker", format_type: format };
        for (const className of ["renamed", "lottieCanvas_legacy"]) {
            const picker: MenuTree[] = [];
            const message: MenuTree[] = [];
            plugin.contextMenus["expression-picker"](picker, { target: { dataset: { id: sticker.id }, className } });
            plugin.contextMenus.message(message, { favoriteableId: sticker.id, favoriteableType: "sticker", message: { stickerItems: [sticker] } });
            assert.equal(picker.length, 1);
            assert.equal(message.length, 1);
            picker[0].props.children[0].props.children[0].props.action();
            message[0].props.children[0].props.children[0].props.action();
            const extension = format === 3 ? "json" : format === 4 ? "gif" : "png";
            const host = format === 4 ? "media.fixture.invalid" : "cdn.fixture.invalid";
            assert.equal(copied.at(-1), `https://${host}/stickers/sticker.${extension}?size=512&lossless=true`);
            assert.equal(copied.at(-2), copied.at(-1));
        }
    }
    sticker = undefined;
    const empty: unknown[] = [];
    plugin.contextMenus["expression-picker"](empty, { target: { dataset: { id: "missing" } } });
    assert.equal(empty.length, 0);
});

test("expression cloning filters picker stickers by format", () => {
    let format: number | undefined;
    const { default: plugin } = loadComponent("src/plugins/expressionCloner/index.tsx", {
        Menu: { MenuItem: "item" },
        StickersStore: { getStickerById: () => format === undefined ? undefined : { format_type: format } }
    }, {
        "@api/ContextMenu": {}, "@api/Settings": { migratePluginSettings() {} },
        "@components/CheckedTextInput": {}, "@components/Flex": {},
        "@components/Heading": {}, "@components/Paragraph": {}, "@components/Button": { Button: "button" },
        "@utils/constants": { Devs: {} }, "@utils/discord": {}, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
        "@webpack": { findByCodeLazy: () => () => {} }
    });
    for (format of [undefined, 1, 2, 3, 4]) {
        for (const className of ["renamed", "lottieCanvas_legacy"]) {
            const children: unknown[] = [];
            plugin.contextMenus["expression-picker"](children, { target: { dataset: { id: "sticker", type: "sticker" }, className } });
            assert.equal(children.length, format === undefined || format === 3 ? 0 : 1);
        }
    }
});

test("emoji cloning settles failed file reads without uploading", async () => {
    for (const mode of ["success", "error", "throw", "abort"]) {
        const uploads: unknown[] = [];
        let aborts = 0;
        const failure = new Error("Fixture read failed");
        const { cloneEmoji, plugin } = loadSource("src/plugins/expressionCloner/index.tsx", {
            "@api/ContextMenu": {}, "@api/Settings": { migratePluginSettings() {} },
            "@components/BaseText": {}, "@components/CheckedTextInput": {}, "@components/Flex": {},
            "@components/Heading": {}, "@components/Paragraph": {}, "@components/Button": { Button: "button" },
            "@utils/constants": { Devs: {} }, "@utils/discord": {}, "@utils/Logger": { Logger: class { error() {} } },
            "@utils/misc": {},
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
            "@webpack": { findByCodeLazy: () => (value: unknown) => uploads.push(value) },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) } }
        }, {
            AbortController, location: { protocol: "https:" }, window: { GLOBAL_ENV: { CDN_HOST: "fixture.invalid" } },
            fetch: async () => ({ ok: true, blob: async () => ({ size: 1 }) }),
            FileReader: class {
                result = "data:image/png;base64,fixture";
                error = failure;
                onload = () => {};
                onerror = () => {};
                onabort = () => {};
                abort() { aborts++; this.onabort(); }
                readAsDataURL() {
                    if (mode === "throw") throw failure;
                    if (mode === "abort") plugin.stop();
                    else if (mode === "error") this.onerror();
                    else this.onload();
                }
            }
        }, "(exports.default.start(), { cloneEmoji, plugin: exports.default })");
        const pending = cloneEmoji("guild", { t: "Emoji", id: "emoji", name: "name~2", isAnimated: false }, "me");
        if (mode === "success") {
            await pending;
            assert.deepEqual({ ...uploads[0] as object }, { guildId: "guild", name: "name", image: "data:image/png;base64,fixture" });
        } else {
            await assert.rejects(pending, mode === "abort" ? /cloning session ended/ : error => error === failure);
            assert.equal(uploads.length, 0);
        }
        assert.equal(aborts, mode === "abort" ? 1 : 0);
    }
});

test("expression cloning preserves valid server errors and falls back for malformed responses", async () => {
    for (const text of ["not json", "null", "{}", '{"message":42}', '{"message":"   "}', '{"message":"No slots available."}']) {
        const messages: string[] = [];
        let requests = 0;
        const logs: unknown[][] = [];
        const failure = { text };
        const { doClone, plugin } = loadSource("src/plugins/expressionCloner/index.tsx", {
            "@api/ContextMenu": {}, "@api/Settings": { migratePluginSettings() {} },
            "@components/BaseText": {}, "@components/CheckedTextInput": {}, "@components/Flex": {},
            "@components/Heading": {}, "@components/Paragraph": {}, "@components/Button": { Button: "button" },
            "@utils/constants": { Devs: {} }, "@utils/discord": {},
            "@utils/Logger": { Logger: class { error(...args: unknown[]) { logs.push(args); } } },
            "@utils/misc": {
                isObject: (value: unknown) => value !== null && typeof value === "object",
                tryOrElse: (fn: () => unknown, fallback: unknown) => { try { return fn(); } catch { return fallback; } }
            },
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
            "@webpack": { findByCodeLazy: () => () => assert.fail("Unexpected upload") },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) }, Toasts: { Type: { FAILURE: "failure" }, genId: () => "id", show: ({ message }: { message: string; }) => messages.push(message) } }
        }, {
            AbortController, location: { protocol: "https:" }, window: { GLOBAL_ENV: { CDN_HOST: "fixture.invalid" } },
            fetch: async () => { requests++; throw failure; }
        }, "(exports.default.start(), { doClone, plugin: exports.default })");
        await doClone("guild", { t: "Emoji", id: "emoji", name: "private-name", isAnimated: false });
        assert.deepEqual(messages, ["Failed to clone: " + (text.includes("No slots") ? "No slots available." : "Something went wrong.")]);
        assert.equal(logs.length, 1);
        assert.deepEqual(logs[0], ["Failed to clone expression.", failure]);
        plugin.stop();
        await doClone("guild", { t: "Emoji", id: "emoji", name: "name", isAnimated: false });
        assert.equal(requests, 1);
        assert.equal(messages.length, 1);
        assert.equal(logs.length, 1);
    }
});

test("cloning keeps the name selected when the request starts", async () => {
    const uploads: Array<{ name: string; }> = [];
    const busy: unknown[] = [];
    const cleanups: Array<() => void> = [];
    let userId: string | undefined = "me";
    let emojiCount = 0;
    let stickerCount = 0;
    let finishDownload: (value: unknown) => void = () => assert.fail("No download");
    const download = new Promise(resolve => { finishDownload = resolve; });
    let fetchResponse: (_url: string, options: { signal: AbortSignal; }) => Promise<unknown> = () => download;
    const React = {
        useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => () => void) => cleanups.push(effect()),
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        useState: (initial: unknown) => [initial, (value: unknown) => busy.push(value)]
    };
    const { CloneModal } = loadSource("src/plugins/expressionCloner/index.tsx", {
        "@api/ContextMenu": {}, "@api/Settings": { migratePluginSettings() {} },
        "@components/BaseText": {}, "@components/CheckedTextInput": {}, "@components/Flex": {},
        "@components/Heading": {}, "@components/Paragraph": {}, "@components/Button": { Button: "button" },
        "@utils/constants": { Devs: {} }, "@utils/discord": { getGuildAcronym: () => "G" },
        "@utils/Logger": { Logger: class { error() {} } }, "@utils/misc": { isObject: () => false },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
        "@webpack": { findByCodeLazy: (code: string) => code === ".additionalEmojiSlots" ? () => 50 : (value: { name: string; }) => uploads.push(value) },
        "@webpack/common": {
            React, lodash: { isEqual: Object.is },
            UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
            GuildStore: { getGuild: () => ({ name: "Guild" }), getGuilds: () => ({ guild: { id: "guild", name: "Guild", ownerId: "me", features: new Set(), premiumTier: 0 } }) },
            PermissionStore: { getGuildPermissions: () => 0n }, PermissionsBits: { CREATE_GUILD_EXPRESSIONS: 1n },
            EmojiStore: { getGuildEmoji: () => Array.from({ length: emojiCount }, () => ({ animated: false, managed: false })) },
            StickersStore: { getStickersByGuildId: () => Array.from({ length: stickerCount }) },
            useStateFromStores: (stores: unknown[], selector: () => unknown, deps: unknown[], equal: unknown) => {
                assert.equal(stores.length, 5);
                assert.ok(stores.every(Boolean));
                assert.equal(deps.length, 1);
                assert.equal(equal, Object.is);
                return selector();
            },
            Toasts: { Type: { SUCCESS: "success" }, genId: () => "id", show() {} } }
    }, {
        React, AbortController, location: { protocol: "https:" }, window: { GLOBAL_ENV: { CDN_HOST: "fixture.invalid" } },
        fetch: (url: string, options: { signal: AbortSignal; }) => fetchResponse(url, options),
        FileReader: class {
            result = "data:image/png;base64,fixture";
            onload = () => {};
            readAsDataURL() { this.onload(); }
        }
    }, "(exports.default.start(), { CloneModal })");
    const data = { t: "Emoji", id: "emoji", name: "original", isAnimated: false };
    for (const kind of ["Emoji", "Sticker"]) {
        for (const value of ["", "a", "aa", "aaa", "a".repeat(29), "a".repeat(30), "a".repeat(31), "a".repeat(32), "a".repeat(33), "a_b", "a b"]) {
            const rendered = CloneModal({ data: { ...data, t: kind, name: value } });
            const input = rendered.props.children[1].props;
            const valid = value.length >= 2 && value.length <= (kind === "Emoji" ? 32 : 30) && (kind === "Sticker" || !value.includes(" "));
            assert.equal(input.value, value);
            assert.equal(input.error === undefined, valid);
            const control = rendered.props.children[2].props.children[0][0].props.children[0]({});
            assert.equal(control.props.disabled, !valid);
        }
    }
    const suffixed = CloneModal({ data: { ...data, name: "original~2" } });
    assert.equal(suffixed.props.children[1].props.value, "original");
    const tree = CloneModal({ data });
    const tooltip = tree.props.children[2].props.children[0][0];
    const button = tooltip.props.children[0]({});
    assert.equal(button.type, "button");
    assert.equal(button.props.type, "button");
    assert.equal(button.props.disabled, false);
    assert.equal(button.props["aria-label"], "Clone to Guild");
    const pending = button.props.onClick();
    assert.equal(button.props.onClick(), undefined);
    tree.props.children[1].props.onChange("later");
    assert.equal(data.name, "original");
    finishDownload({ ok: true, blob: async () => ({ size: 1 }) });
    await pending;
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].name, "original");
    assert.deepEqual(busy, [true, "later", false]);
    for (userId of ["other", undefined]) {
        const changed = CloneModal({ data });
        assert.equal(changed.props.children[2].props.children[0].length, 0);
    }
    userId = "me";
    emojiCount = 50;
    assert.equal(CloneModal({ data }).props.children[2].props.children[0].length, 0);
    emojiCount = 49;
    assert.equal(CloneModal({ data }).props.children[2].props.children[0].length, 1);
    stickerCount = 5;
    assert.equal(CloneModal({ data: { ...data, t: "Sticker" } }).props.children[2].props.children[0].length, 0);
    stickerCount = 4;
    assert.equal(CloneModal({ data: { ...data, t: "Sticker" } }).props.children[2].props.children[0].length, 1);
    const requests: Array<{ signal: AbortSignal; resolve(value: unknown): void; }> = [];
    fetchResponse = (_url, { signal }) => new Promise((resolve, reject) => {
        requests.push({ signal, resolve });
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
    const first = CloneModal({ data });
    const closeFirst = cleanups.at(-1);
    assert.ok(closeFirst);
    const second = CloneModal({ data });
    const firstPending = first.props.children[2].props.children[0][0].props.children[0]({}).props.onClick();
    const secondPending = second.props.children[2].props.children[0][0].props.children[0]({}).props.onClick();
    assert.equal(requests.length, 2);
    closeFirst();
    await firstPending;
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    requests[1].resolve({ ok: true, blob: async () => ({ size: 1 }) });
    await secondPending;
    assert.equal(uploads.length, 2);
});

test("cloning stops before uploads and sticker publication after account changes", async () => {
    for (const kind of ["Emoji", "Sticker"]) {
        for (const phase of ["stable", "download", "logout", "stop", "restart", "relogin", ...(kind === "Sticker" ? ["response"] : [])]) {
            let userId: string | undefined = "owner";
            let uploads = 0;
            let publications = 0;
            const { cloneEmoji, cloneSticker, plugin } = loadSource("src/plugins/expressionCloner/index.tsx", {
                "@api/ContextMenu": {}, "@api/Settings": { migratePluginSettings() {} },
                "@components/BaseText": {}, "@components/Button": {}, "@components/Flex": {},
                "@components/Heading": {}, "@components/Paragraph": {},
                "@utils/constants": { Devs: {} }, "@utils/discord": {},
                "@utils/Logger": { Logger: class { error() {} } }, "@utils/misc": {},
                "@utils/types": { __esModule: true, default: (value: object) => value },
                "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
                "@webpack": { findByCodeLazy: () => () => { uploads++; } },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
                    Constants: { Endpoints: { GUILD_STICKER_PACKS: () => "fixture" } },
                    RestAPI: { post: async () => { uploads++; if (phase === "response") userId = "other"; return { body: {} }; } },
                    FluxDispatcher: { dispatch: () => publications++ }
                }
            }, {
                AbortController, location: { protocol: "https:" }, window: { GLOBAL_ENV: { CDN_HOST: "fixture.invalid", MEDIA_PROXY_ENDPOINT: "https://fixture.invalid" } },
                fetch: async (_url: string, { signal }: { signal: AbortSignal; }) => {
                    assert.ok(signal instanceof AbortSignal);
                    assert.equal(signal.aborted, false);
                    if (phase === "stop" || phase === "restart") plugin.stop();
                    if (phase === "restart") plugin.start();
                    if (phase === "relogin") plugin.flux.LOGOUT();
                    assert.equal(signal.aborted, ["stop", "restart", "relogin"].includes(phase));
                    if (phase === "download") userId = "other";
                    if (phase === "logout") userId = undefined;
                    return { ok: true, blob: async () => ({ size: 1 }) };
                },
                FormData: class { append() {} },
                FileReader: class {
                    result = "data:image/png;base64,fixture";
                    onload = () => {};
                    readAsDataURL() { this.onload(); }
                }
            }, "(exports.default.start(), { cloneEmoji, cloneSticker, plugin: exports.default })");
            const data = { t: kind, id: "expression", name: "name", format_type: 1, tags: "tag", description: "description" };
            const pending = (kind === "Emoji" ? cloneEmoji : cloneSticker)("guild", data, "owner");
            if (phase === "stable") await pending;
            else await assert.rejects(pending, /cloning session ended/);
            assert.equal(uploads, phase === "stable" || phase === "response" ? 1 : 0);
            assert.equal(publications, kind === "Sticker" && phase === "stable" ? 1 : 0);
        }
    }
});

test("status URL copying waits for clipboard completion and catches rejection", async () => {
    for (const fail of [false, true]) {
        let resolveCopy: () => void = () => {};
        let rejectCopy: (error: Error) => void = () => {};
        const copying = new Promise<void>((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; });
        const feedback: string[] = [];
        let logged = 0;
        const { default: plugin } = loadSource("src/equicordplugins/copyStatusUrls/index.ts", {
            "@utils/constants": { Devs: {} },
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@utils/discord": { copyWithToast: (url: string, message: string) => {
                assert.equal(url, "https://fixture.invalid/status");
                assert.equal(message, "Copied URL");
                return copying;
            } },
            "@utils/Logger": { Logger: class { error() { logged++; } } },
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@webpack": { findByCodeLazy: () => async () => ({ button_urls: ["https://fixture.invalid/status"] }) },
            "@webpack/common": { Toasts: { Type: { FAILURE: "failure" }, Position: { TOP: "top" }, genId: () => "id", show: ({ message }: { message: string; }) => feedback.push(message) } }
        });
        let settled = false;
        const pending = plugin.makeContextMenu({ user: { id: "user" }, activity: {} }, 0)().then(() => { settled = true; });
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(feedback.length, 0);
        if (fail) rejectCopy(new Error("Clipboard denied"));
        else resolveCopy();
        await pending;
        assert.equal(logged, fail ? 1 : 0);
        assert.deepEqual(feedback, fail ? ["Could not copy the status URL."] : []);
    }
});

test("status URL copying rejects malformed metadata without changing the clipboard", async () => {
    for (const metadata of [null, undefined, {}, { button_urls: "https://fixture.invalid" }, { button_urls: [] }, { button_urls: [42] }, { button_urls: [{}] }, { button_urls: [""] }, { button_urls: ["https://fixture.invalid"] }]) {
        const copied: string[] = [];
        let failures = 0;
        const { default: plugin } = loadSource("src/equicordplugins/copyStatusUrls/index.ts", {
            "@utils/constants": { Devs: {} },
            "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
            "@utils/discord": { copyWithToast: async (url: string) => { copied.push(url); } },
            "@utils/Logger": { Logger: class { error() {} } },
            "@utils/types": { __esModule: true, default: (value: object) => value },
            "@webpack": { findByCodeLazy: () => async () => metadata },
            "@webpack/common": { Toasts: { Type: { FAILURE: "failure" }, Position: { TOP: "top" }, genId: () => "id", show: () => failures++ } }
        });
        await plugin.makeContextMenu({ user: { id: "user" }, activity: {} }, 0)();
        const valid = Array.isArray(metadata?.button_urls) && metadata.button_urls[0] === "https://fixture.invalid";
        assert.deepEqual(copied, valid ? ["https://fixture.invalid"] : []);
        assert.equal(failures, valid ? 0 : 1);
    }
});


test("HTTP updater discards a pending download when a later check finds nothing or fails", async () => {
    for (const outcome of ["current", "release-error", "commit-error"]) {
        const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        let secondCheck = false;
        let downloads = 0;
        let writes = 0;
        loadSource("src/main/updater/http.ts", {
            "@main/utils/http": {
                fetchJson: async (url: string) => {
                    if (url.includes("/releases?")) {
                        if (secondCheck && outcome === "release-error") throw new Error("Release lookup failed");
                        return [{ tag_name: "tag", assets: [{ name: "fixture.asar", browser_download_url: "https://fixture.invalid/old" }] }];
                    }
                    if (secondCheck && outcome === "commit-error") throw new Error("Commit lookup failed");
                    return { sha: secondCheck ? "current" : "next" };
                },
                fetchBuffer: async (url: string) => { assert.equal(url, "https://fixture.invalid/old"); downloads++; return Buffer.from("fixture"); }
            },
            "@shared/IpcEvents": { IpcEvents: { GET_REPO: "repo", GET_UPDATES: "check", UPDATE: "update", BUILD: "build" } },
            "@shared/updateChannel": { normalizeUpdateChannel: () => "nightly" },
            "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "fixture" },
            electron: { ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers[name] = handler; } } },
            "original-fs": { mkdtempSync: () => "fixture-temp", renameSync() {}, rmSync() {}, writeFileSync: () => writes++ },
            path,
            "~git-hash": { __esModule: true, default: "current" },
            "~git-remote": { __esModule: true, default: "fixture/repo" },
            "./common": { ASAR_FILE: "fixture.asar", serializeErrors: (handler: unknown) => handler },
            "./releaseSelection": { selectUpdateRelease: (releases: unknown[]) => releases[0] }
        }, { __dirname: "fixture.asar" });
        assert.equal(await handlers.update(null, "nightly"), true);
        secondCheck = true;
        if (outcome === "current") assert.equal(await handlers.update(null, "nightly"), false);
        else await assert.rejects(handlers.update(null, "nightly"), /lookup failed/);
        assert.equal(await handlers.build(), true);
        assert.equal(downloads, 0);
        assert.equal(writes, 0);
        secondCheck = false;
        await handlers.update(null, "nightly");
        await handlers.build();
        await handlers.build();
        assert.equal(downloads, 1);
        assert.equal(writes, 1);
    }
});


test("HTTP updater ignores superseded checks and downloads even when their URLs match", async () => {
    for (const newest of ["current", "next"]) {
        const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        const commits: ReturnType<typeof Promise.withResolvers<{ sha: string }>>[] = [];
        let deferChecks = true;
        let download: ReturnType<typeof Promise.withResolvers<Buffer>> | undefined;
        let downloads = 0;
        let writes = 0;
        loadSource("src/main/updater/http.ts", {
            "@main/utils/http": {
                fetchJson: async (url: string) => {
                    if (url.includes("/releases?")) return [{ tag_name: "tag", assets: [{ name: "fixture.asar", browser_download_url: "https://fixture.invalid/same" }] }];
                    if (!deferChecks) return { sha: "next" };
                    const pending = Promise.withResolvers<{ sha: string }>();
                    commits.push(pending);
                    return pending.promise;
                },
                fetchBuffer: async () => { downloads++; return download ? download.promise : Buffer.from("fixture"); }
            },
            "@shared/IpcEvents": { IpcEvents: { GET_REPO: "repo", GET_UPDATES: "check", UPDATE: "update", BUILD: "build" } },
            "@shared/updateChannel": { normalizeUpdateChannel: () => "nightly" },
            "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "fixture" },
            electron: { ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers[name] = handler; } } },
            "original-fs": { mkdtempSync: () => "fixture-temp", renameSync() {}, rmSync() {}, writeFileSync: () => writes++ },
            path,
            "~git-hash": { __esModule: true, default: "current" },
            "~git-remote": { __esModule: true, default: "fixture/repo" },
            "./common": { ASAR_FILE: "fixture.asar", serializeErrors: (handler: unknown) => handler },
            "./releaseSelection": { selectUpdateRelease: (releases: unknown[]) => releases[0] }
        }, { __dirname: "fixture.asar" });
        const older = handlers.update(null, "nightly");
        await setImmediate();
        const newer = handlers.update(null, "nightly");
        await setImmediate();
        commits[1].resolve({ sha: newest });
        assert.equal(await newer, newest === "next");
        commits[0].resolve({ sha: "next" });
        assert.equal(await older, false);
        await handlers.build();
        assert.equal(downloads, newest === "next" ? 1 : 0);
        assert.equal(writes, downloads);
        deferChecks = false;
        await handlers.update(null, "nightly");
        download = Promise.withResolvers<Buffer>();
        const staleBuild = handlers.build();
        await handlers.update(null, "nightly");
        const before = writes;
        download.resolve(Buffer.from("old"));
        assert.equal(await staleBuild, false);
        assert.equal(writes, before);
        download = undefined;
        assert.equal(await handlers.build(), true);
        assert.equal(writes, before + 1);
        await handlers.update(null, "nightly");
        download = Promise.withResolvers<Buffer>();
        const firstBuild = handlers.build();
        const duplicateBuild = handlers.build();
        download.resolve(Buffer.from("current"));
        assert.deepEqual(await Promise.all([firstBuild, duplicateBuild]), [true, false]);
        assert.equal(writes, before + 2);
    }
});


test("renderer updater ignores check results and errors invalidated by reset or a newer check", async () => {
    for (const reset of [false, true]) {
        for (const failure of [false, true]) {
            const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
            const api = loadSource("src/utils/updater.ts", {
                "~git-hash": { __esModule: true, default: "current" },
                "./Logger": { Logger: class {} }, "./native": {}, "./updateClassification": {}
            }, { IS_STANDALONE: true, Vencord: { Settings: { updateChannel: "nightly" } }, VencordNative: { updater: { getUpdates: () => {
                const request = Promise.withResolvers<unknown>();
                pending.push(request);
                return request.promise;
            } } } });
            const old = api.checkForUpdates();
            if (reset) api.resetUpdateState();
            else {
                const current = api.checkForUpdates();
                pending[1].resolve({ ok: true, value: [{ hash: "new", author: "author", message: "new" }] });
                assert.equal(await current, true);
            }
            pending[0].resolve(failure ? { ok: false, error: "stale failure" } : { ok: true, value: [{ hash: "old" }] });
            assert.equal(await old, !reset);
            assert.equal(api.isOutdated, !reset);
            assert.equal(api.updateError, undefined);
            assert.equal(api.changes.length, reset ? 0 : 1);
            if (!reset) assert.equal(api.changes[0].hash, "new");
            const current = api.checkForUpdates();
            pending.at(-1)?.resolve({ ok: false, error: "current failure" });
            await assert.rejects(current, error => error === "current failure");
            assert.equal(api.updateError, "current failure");
        }
    }
});


test("renderer updater keeps a failed rebuild available for retry", async () => {
    for (const failure of ["false", "ipc", "transport"]) {
        let failing = true;
        let updates = 0;
        let builds = 0;
        const api = loadSource("src/utils/updater.ts", {
            "~git-hash": { __esModule: true, default: "current" },
            "./Logger": { Logger: class {} }, "./native": {}, "./updateClassification": {}
        }, { IS_STANDALONE: true, Vencord: { Settings: { updateChannel: "nightly" } }, VencordNative: { updater: {
            getUpdates: async () => ({ ok: true, value: failing ? [{ hash: "next", author: "author", message: "update" }] : [] }),
            update: async () => { updates++; return { ok: true, value: true }; },
            rebuild: async () => {
                builds++;
                if (failing && failure === "transport") throw new Error("Transport failed");
                if (failing && failure === "ipc") return { ok: false, error: new Error("Build failed") };
                return { ok: true, value: !failing };
            }
        } } });
        await api.checkForUpdates();
        await assert.rejects(api.update());
        assert.equal(api.isOutdated, true);
        assert.equal(updates, 1);
        assert.equal(builds, 1);
        failing = false;
        assert.equal(await api.checkForUpdates(), true);
        assert.equal(await api.update(), true);
        assert.equal(api.isOutdated, false);
        assert.equal(updates, 1);
        assert.equal(builds, 2);
        assert.equal(await api.update(), true);
        assert.equal(updates, 1);
        assert.equal(builds, 2);
    }
});


test("renderer updater shares active work and rejects completion after a reset", async () => {
    for (const resetAt of ["none", "update", "rebuild"]) {
        const updateResult = Promise.withResolvers<unknown>();
        const buildResult = Promise.withResolvers<unknown>();
        const oldCheck = Promise.withResolvers<unknown>();
        let deferCheck = false;
        let updates = 0;
        let builds = 0;
        const api = loadSource("src/utils/updater.ts", {
            "~git-hash": { __esModule: true, default: "current" },
            "./Logger": { Logger: class {} }, "./native": {}, "./updateClassification": {}
        }, { IS_STANDALONE: true, Vencord: { Settings: { updateChannel: "nightly" } }, VencordNative: { updater: {
            getUpdates: async () => deferCheck ? oldCheck.promise : { ok: true, value: [{ hash: "next" }] },
            update: () => { updates++; return updateResult.promise; },
            rebuild: () => { builds++; return buildResult.promise; }
        } } });
        await api.checkForUpdates();
        deferCheck = true;
        const obsoleteCheck = api.checkForUpdates();
        const first = api.update();
        const second = api.update();
        assert.equal(updates, 1);
        oldCheck.resolve({ ok: true, value: [] });
        assert.equal(await obsoleteCheck, true);
        assert.equal(await api.checkForUpdates(), true);
        if (resetAt === "update") api.resetUpdateState();
        updateResult.resolve({ ok: true, value: true });
        await setImmediate();
        assert.equal(builds, resetAt === "update" ? 0 : 1);
        if (resetAt === "rebuild") api.resetUpdateState();
        buildResult.resolve(resetAt === "rebuild" ? { ok: false, error: "stale build failure" } : { ok: true, value: true });
        assert.deepEqual(await Promise.all([first, second]), [resetAt === "none", resetAt === "none"]);
        assert.equal(api.isOutdated, false);
        assert.equal(api.updateError, undefined);
        assert.equal(await api.update(), true);
        assert.equal(updates, 1);
    }
});


test("update recovery prompt relaunches only after a successful update", async () => {
    for (const mode of ["declined", "unchanged", "success", "failed"]) {
        let relaunches = 0;
        let updates = 0;
        let builds = 0;
        let errors = 0;
        let alerts = 0;
        const api = loadSource("src/utils/updater.ts", {
            "~git-hash": { __esModule: true, default: "current" },
            "./Logger": { Logger: class { error() { errors++; } } },
            "./native": { relaunch: () => relaunches++ }, "./updateClassification": {}
        }, { IS_STANDALONE: true, IS_WEB: false, IS_UPDATER_DISABLED: false,
            confirm: () => mode !== "declined", alert: () => alerts++,
            Vencord: { Settings: { updateChannel: "nightly" } }, VencordNative: { updater: {
                getUpdates: async () => ({ ok: true, value: [{ hash: "next" }] }),
                update: async () => { updates++; return { ok: true, value: mode !== "unchanged" }; },
                rebuild: async () => { builds++; return { ok: true, value: mode !== "failed" }; }
            } }
        });
        await api.maybePromptToUpdate("Update now?");
        assert.equal(relaunches, mode === "success" ? 1 : 0);
        assert.equal(updates, mode === "declined" ? 0 : 1);
        assert.equal(builds, mode === "success" || mode === "failed" ? 1 : 0);
        assert.equal(errors, mode === "failed" ? 1 : 0);
        assert.equal(alerts, mode === "failed" ? 1 : 0);
    }
});


test("updater error dialog preserves ordinary error messages and command diagnostics", () => {
    const { getErrorMessage } = loadSource("src/components/settings/tabs/updater/runWithDispatch.tsx", {
        "@components/ErrorCard": {}, "@utils/updater": {}, "@webpack/common": {}
    }, {}, "({ getErrorMessage })");
    for (const error of [new Error("Download failed"), { message: "Download failed" }])
        assert.equal(getErrorMessage(error), "Download failed");
    for (const error of [null, undefined, {}, { message: "  " }, { message: 42 }])
        assert.match(getErrorMessage(error), /An unknown error occurred/);
    assert.match(getErrorMessage({ code: "ENOENT", cmd: "git pull", path: "git" }), /Command `git` not found/);
    assert.match(getErrorMessage({ code: 1, cmd: "git pull", stderr: "Local changes would be overwritten", message: "generic" }), /Local changes would be overwritten/);
    assert.match(getErrorMessage({ code: 1, cmd: "git pull" }), /Code `1`/);
});


test("relationship notifier skips user lookups for irrelevant or disabled removals", async () => {
    for (const type of [1, 2, 3, 4]) {
        for (const [friends, friendRequestCancels] of [[false, false], [true, false], [false, true], [true, true]]) {
            let lookups = 0;
            let notifications = 0;
            const { onRelationshipRemove } = loadSource("src/plugins/relationshipNotifier/functions.ts", {
                "@utils/discord": { getUniqueUsername: () => "User" },
                "@vencord/discord-types/enums": { RelationshipType: { FRIEND: 1, BLOCKED: 2, INCOMING_REQUEST: 3, OUTGOING_REQUEST: 4 } },
                "@webpack/common": { UserUtils: { getUser: async () => { lookups++; return { id: "user", getAvatarURL() {} }; } } },
                "./settings": { __esModule: true, default: { store: { friends, friendRequestCancels } } },
                "./utils": { notify: () => notifications++ }
            });
            await onRelationshipRemove({ relationship: { type, id: "user" } });
            const expected = (type === 1 && friends || type === 3 && friendRequestCancels) ? 1 : 0;
            assert.equal(lookups, expected);
            assert.equal(notifications, expected);
        }
    }
});


test("relationship notifier catches delayed startup failures and cancels its timer", async () => {
    const timers = new Map<number, () => void>();
    let timerId = 0;
    let calls = 0;
    const errors: unknown[] = [];
    const failure = new Error("Storage unavailable");
    const { default: plugin } = loadSource("src/plugins/relationshipNotifier/index.ts", {
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(_message: string, error: unknown) { errors.push(error); } } },
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "./settings": {}, "./functions": {},
        "./utils": { syncAndRunChecks: async () => { calls++; throw failure; } }
    }, {
        setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 5000); timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => timers.delete(id)
    });
    plugin.start();
    plugin.start();
    assert.equal(timers.size, 1);
    plugin.stop();
    assert.equal(timers.size, 0);
    assert.equal(calls, 0);
    plugin.start();
    for (const callback of timers.values()) callback();
    timers.clear();
    await setImmediate();
    assert.equal(calls, 1);
    assert.deepEqual(errors, [failure]);
});


test("relationship guild and group removals propagate storage failures to Flux", async () => {
    for (const kind of ["guild", "group"]) {
        for (const manual of [false, true]) {
            let removed = false;
            let notices = 0;
            const failure = new Error("Save failed");
            const settings = { __esModule: true, default: { store: { servers: true, groups: true } } };
            const enums = { ChannelType: { GROUP_DM: 3 }, RelationshipType: {} };
            const utils = loadSource("src/plugins/relationshipNotifier/utils.ts", {
                "@api/DataStore": { set: async () => { if (removed) throw failure; } },
                "@api/Notices": {}, "@api/Notifications": {}, "@utils/discord": {},
                "@vencord/discord-types/enums": enums,
                "@webpack": { findStoreLazy: () => ({ isUnavailable: () => false }) },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => ({ id: "owner" }) },
                    GuildStore: { getGuilds: () => removed ? {} : { item: { name: "Guild" } } },
                    GuildMemberStore: { isMember: () => true },
                    ChannelStore: { getSortedPrivateChannels: () => removed ? [] : [{ id: "item", name: "Group", type: 3, rawRecipients: [] }] }
                },
                "./settings": settings
            });
            await utils.syncGuilds();
            await utils.syncGroups();
            const handlers = loadSource("src/plugins/relationshipNotifier/functions.ts", {
                "@utils/discord": {}, "@vencord/discord-types/enums": enums,
                "@webpack/common": {}, "./settings": settings,
                "./utils": { ...utils, notify: () => notices++ }
            });
            if (manual) (kind === "guild" ? handlers.removeGuild : handlers.removeGroup)("item");
            removed = true;
            const pending = kind === "guild"
                ? handlers.onGuildDelete({ guild: { id: "item" } })
                : handlers.onChannelDelete({ channel: { id: "item", type: 3 } });
            await assert.rejects(pending, error => error === failure);
            assert.equal(notices, manual ? 0 : 1);
        }
    }
});


test("relationship persistence keeps each account snapshot while storage opens", async () => {
    let userId = "first";
    const saved = new Map<string, unknown>();
    const dataStore = loadSource("src/api/DataStore/index.ts", {});
    const utils = loadSource("src/plugins/relationshipNotifier/utils.ts", {
        "@api/DataStore": { set: (key: string, value: unknown) => dataStore.set(key, value, (_mode: string, callback: (store: object) => unknown) => Promise.resolve().then(() => {
            const transaction: { oncomplete?: () => void; } = {};
            const result = callback({ transaction, put: (data: unknown, id: string) => saved.set(id, structuredClone(data)) });
            queueMicrotask(() => transaction.oncomplete?.());
            return result;
        })) },
        "@api/Notices": {}, "@api/Notifications": {}, "@utils/discord": {},
        "@vencord/discord-types/enums": { ChannelType: { GROUP_DM: 3 }, RelationshipType: { FRIEND: 1, INCOMING_REQUEST: 3 } },
        "@webpack": { findStoreLazy: () => ({}) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: userId }) },
            GuildStore: { getGuilds: () => ({ [userId]: { name: userId } }) },
            GuildMemberStore: { isMember: () => true },
            ChannelStore: { getSortedPrivateChannels: () => [{ id: userId, name: userId, type: 3, rawRecipients: [] }] },
            RelationshipStore: { getMutableRelationships: () => new Map([[userId + "-friend", 1], [userId + "-request", 3]]) }
        },
        "./settings": {}
    });
    const first = [utils.syncGuilds(), utils.syncGroups(), utils.syncFriends()];
    userId = "second";
    await Promise.all([...first, utils.syncGuilds(), utils.syncGroups(), utils.syncFriends()]);
    for (const owner of ["first", "second"]) {
        for (const kind of ["guilds", "groups"]) {
            const snapshot = saved.get(`relationship-notifier-${kind}-${owner}`);
            assert.ok(snapshot instanceof Map);
            assert.deepEqual([...snapshot.keys()], [owner]);
        }
        assert.deepEqual(saved.get(`relationship-notifier-friends-${owner}`), { friends: [owner + "-friend"], requests: [owner + "-request"] });
    }
});
