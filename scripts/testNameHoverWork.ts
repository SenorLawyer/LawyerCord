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

function fixture() {
    let writes = 0;
    const effects: (() => void)[] = [];
    const dependencies: unknown[][] = [];
    const settingKeys: unknown[] = [];
    const selectors: { select: () => unknown; value: unknown; changes: number; }[] = [];
    const users = new Map<string, { id: string; username: string; }>();
    const messages = new Map<string, object>();
    let hovering = false;
    let saved: unknown;
    let nicknameValue = "";
    const nicknames = { saved: "Saved nickname" };
    const fluxStores = { relationship: { getNickname: () => "" }, streamer: { enabled: false }, accessibility: { useReducedMotion: false } };
    const storeSubscriptions: { stores: unknown[]; select: () => unknown; value: unknown; }[] = [];
    const settings = new Proxy<Record<string, unknown>>({}, { set(target, key: string, value: unknown) { writes++; target[key] = value; return true; } });
    const modules = {
        definePluginSettings: (defs: Record<string, { default: unknown; }>) => { for (const [key, value] of Object.entries(defs)) settings[key] = value.default; return { store: settings, use: (keys: unknown) => { settingKeys.push(keys); return settings; } }; },
        isPluginEnabled: () => false,
        default: (plugin: unknown) => plugin, OptionType: {}, Devs: {}, EquicordDevs: {},
        classNameFactory: () => () => "", findStoreLazy: (name: string) => name === "UserStore" ? { getUser: (id: string) => users.get(id) } : fluxStores.accessibility, findByCodeLazy: () => () => ({}),
        proxyLazy: (factory: () => unknown) => factory(),
        zustandCreate: (factory: () => object) => {
            let state = factory();
            const listeners = new Set<() => void>();
            const use = (selector: () => unknown) => {
                const entry = { select: selector, value: selector(), changes: 0 };
                selectors.push(entry);
                listeners.add(() => { const value = entry.select(); if (value !== entry.value) { entry.changes++; entry.value = value; } });
                return entry.value;
            };
            return Object.assign(use, { getState: () => state, setState: (next: object) => { state = { ...state, ...next }; listeners.forEach(fn => fn()); }, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } });
        },
        ChannelStore: { getChannel: () => ({ id: "channel", guild_id: "guild" }) },
        GuildMemberStore: { getMember: () => null }, MessageStore: { getMessage: (_channel: string, id: string) => messages.get(id) },
        RelationshipStore: fluxStores.relationship, StreamerModeStore: fluxStores.streamer,
        useStateFromStores: (stores: unknown[], select: () => unknown) => { const value = select(); storeSubscriptions.push({ stores, select, value }); return value; },
        useState: (initial: unknown) => typeof initial === "boolean" ? [hovering, (value: boolean) => hovering = value] : [nicknameValue || initial, () => {}],
        DataStore: { get: async () => nicknames, set: async (_key: string, value: unknown) => saved = value },
        useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => { dependencies.push(deps); const cleanup = effect(); if (cleanup) effects.push(cleanup); }
    };
    const source = readFileSync(process.env.AUDIT_NAME_SOURCE ?? "src/plugins/showMeYourName/index.tsx", "utf8");
    const { outputText } = transpileModule(source + "\nexport const audit = { hoveringMessageMap, hoveringRepliesMap, handleHoveringMessage, useReactionHover, hoveringReactionPopoutMap, getMessageNameElement, getMessageNameText, getMentionNameElement, CustomNicknameModal, renderUsername };", { fileName: "index.tsx", compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const result = runInNewContext(`${outputText}\n({ ...exports.audit, plugin: exports.default });`, { exports: {}, require: () => ({ ...modules, __esModule: true }),
        getComputedStyle: () => ({ getPropertyValue: () => "#ffffff" }),
        document: { createElement: () => ({ getContext: () => ({}) }) },
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) } }) as {
        hoveringMessageMap: Map<string, number>; hoveringRepliesMap: Map<string, number>;
        handleHoveringMessage(message: object, hovering: boolean): void;
        useReactionHover(id: string): { onMouseEnter(): void; onMouseLeave(): void; };
        hoveringReactionPopoutMap: Map<string, number>;
        renderUsername(...args: unknown[]): [unknown, { children: { props: { style?: { animation?: string; }; }; }[]; }];
        getMessageNameElement(props: object): unknown;
        getMessageNameText(props: object): unknown;
        getMentionNameElement(props: object): unknown;
        CustomNicknameModal(props: object): { props: { actions: { onClick(): Promise<void>; }[]; }; };
        plugin: { start(): Promise<void>; stop(): void; };
    };
    writes = 0;
    return { ...result, settings, dependencies, settingKeys, setNickname: (value: string) => nicknameValue = value, selectors, users, messages, fluxStores, storeSubscriptions, saved: () => saved, writes: () => writes, unmountOne: () => effects.shift()?.(), unmount: () => effects.splice(0).forEach(fn => fn()) };
}

test("Message and group hover writes no persistent settings and releases reply ownership on unmount", () => {
    const f = fixture();
    f.handleHoveringMessage({ id: "m", showMeYourNameGroupId: "g", messageReference: { message_id: "r" } }, true);
    assert.equal(f.hoveringMessageMap.get("m"), 1);
    assert.equal(f.hoveringMessageMap.get("g"), 1);
    assert.equal(f.hoveringRepliesMap.get("r"), 1);
    assert.equal(f.writes(), 0);
    f.unmount();
    assert.equal(f.hoveringMessageMap.size, 0);
    assert.equal(f.hoveringRepliesMap.size, 0);
});

test("Mounting an unhovered row does not decrement another row's group ownership", () => {
    const f = fixture();
    f.handleHoveringMessage({ id: "m1", showMeYourNameGroupId: "g" }, true);
    f.handleHoveringMessage({ id: "m2", showMeYourNameGroupId: "g" }, false);
    assert.equal(f.hoveringMessageMap.get("g"), 1);
    f.unmount();
    assert.equal(f.hoveringMessageMap.size, 0);
});



test("Hover selectors leave unrelated users unchanged", () => {
    const f = fixture();
    f.settings.messages = false;
    for (const id of ["m", "group-member", "unrelated"]) {
        const user = { id, username: id };
        f.users.set(id, user);
        f.messages.set(id, { showMeYourNameGroupId: id === "unrelated" ? "other" : "g" });
        f.getMessageNameElement({ message: { id, channel_id: "channel", author: user } });
    }
    f.handleHoveringMessage({ id: "m", showMeYourNameGroupId: "g" }, true);
    assert.deepEqual(f.selectors.map(entry => entry.changes), [0, 1, 0, 1, 0, 0]);
    f.unmount();
    assert.deepEqual(f.selectors.map(entry => entry.changes), [0, 2, 0, 2, 0, 0]);
});

test("Reaction hover owns its entry until leave or unmount and ignores repeated enters", () => {
    const f = fixture();
    f.useReactionHover("user").onMouseEnter();
    const handlers = f.useReactionHover("user");
    assert.equal(f.hoveringReactionPopoutMap.get("user"), 1);
    handlers.onMouseEnter();
    assert.equal(f.hoveringReactionPopoutMap.get("user"), 1);
    f.unmount();
    assert.equal(f.hoveringReactionPopoutMap.size, 0);
    assert.equal(f.writes(), 0);
});

test("Friend, streamer and reduced-motion subscriptions read the owning stores", () => {
    const f = fixture();
    f.settings.messages = false;
    const user = { id: "user", username: "user" };
    f.users.set(user.id, user);
    f.getMessageNameElement({ message: { id: "m", channel_id: "channel", author: user } });
    assert.deepEqual(f.storeSubscriptions.map(entry => entry.stores[0]), Object.values(f.fluxStores));
    f.fluxStores.relationship.getNickname = () => "Changed";
    f.fluxStores.streamer.enabled = true;
    f.fluxStores.accessibility.useReducedMotion = true;
    assert.deepEqual(f.storeSubscriptions.map(entry => entry.select()), ["Changed", true, true]);
});

test("Custom nickname save retains other users' saved names without settings writes", async () => {
    const f = fixture();
    await f.plugin.start();
    f.setNickname("New nickname");
    const modal = f.CustomNicknameModal({ modalProps: { onClose() {} }, user: { id: "new", username: "user" } });
    await modal.props.actions[0].onClick();
    assert.equal(JSON.stringify(f.saved()), JSON.stringify({ saved: "Saved nickname", new: "New nickname" }));
    assert.equal(f.writes(), 0);
});


test("Nested message mentions and replies select only their owning hover while text ignores it", () => {
    const f = fixture();
    Object.assign(f.settings, { messages: false, mentions: false, replies: false });
    const user = { id: "user", username: "user" };
    f.users.set(user.id, user);
    f.messages.set("m", { showMeYourNameGroupId: "g" });
    f.getMentionNameElement({ channelId: "channel", userId: user.id, props: { messageId: "m" } });
    f.getMessageNameElement({ message: { id: "reply", channel_id: "channel", author: user }, isRepliedMessage: true });
    f.getMessageNameText({ message: { id: "m", channel_id: "channel", author: user } });
    f.handleHoveringMessage({ id: "m", showMeYourNameGroupId: "g", messageReference: { message_id: "reply" } }, true);
    assert.deepEqual(f.selectors.map(entry => entry.changes), [0, 1, 0, 1, 0, 0]);
    f.unmount();
    assert.deepEqual(f.selectors.map(entry => entry.changes), [0, 2, 0, 2, 0, 0]);
});

test("Two mounted rows retain shared reply and group ownership until both unmount", () => {
    const f = fixture();
    for (const id of ["a", "b"]) f.handleHoveringMessage({ id, showMeYourNameGroupId: "g", messageReference: { message_id: "r" } }, true);
    assert.equal(f.hoveringMessageMap.get("g"), 2);
    f.unmountOne();
    assert.equal(f.hoveringMessageMap.get("g"), 1);
    assert.equal(f.hoveringRepliesMap.get("r"), 1);
    f.unmount();
    assert.equal(f.hoveringMessageMap.size, 0);
    assert.equal(f.hoveringRepliesMap.size, 0);
});

test("Stopping clears hover ownership and prevents late nickname hydration", async () => {
    const f = fixture();
    f.handleHoveringMessage({ id: "m", messageReference: { message_id: "r" } }, true);
    const pending = f.plugin.start();
    f.plugin.stop();
    await pending;
    assert.equal(f.hoveringMessageMap.size, 0);
    assert.equal(f.hoveringRepliesMap.size, 0);
    const modal = f.CustomNicknameModal({ modalProps: { onClose() {} }, user: { id: "new", username: "user" } });
    await modal.props.actions[0].onClick();
    assert.equal(JSON.stringify(f.saved()), "{}");
    assert.equal(f.writes(), 0);
});


test("Changing only the referenced reply invalidates hover ownership", () => {
    const f = fixture();
    f.handleHoveringMessage({ id: "m", showMeYourNameGroupId: "g", messageReference: { message_id: "old" } }, true);
    f.unmount();
    f.handleHoveringMessage({ id: "m", showMeYourNameGroupId: "g", messageReference: { message_id: "new" } }, true);
    assert.notDeepEqual(f.dependencies[0], f.dependencies[1]);
    assert.equal(f.hoveringRepliesMap.has("old"), false);
    assert.equal(f.hoveringRepliesMap.get("new"), 1);
});

test("Repeated name renders reuse their settings subscription key arrays", () => {
    const f = fixture();
    f.settings.messages = false;
    const user = { id: "user", username: "user" };
    f.users.set(user.id, user);
    const props = { message: { id: "m", channel_id: "channel", author: user } };
    f.getMessageNameElement(props);
    f.getMessageNameElement(props);
    assert.equal(f.settingKeys[0], f.settingKeys[2]);
    assert.equal(f.settingKeys[1], f.settingKeys[3]);
});


test("Reduced motion stops the outer gradient animation on mentions and reactions", () => {
    const f = fixture();
    f.settings.alwaysShowEffects = true;
    f.fluxStores.accessibility.useReducedMotion = true;
    const author = { id: "user", username: "user", displayNameStyles: { effectId: 2, colors: [65280, 16776960] } };
    for (const type of ["mentions", "reactionsPopout"]) {
        const [, element] = f.renderUsername(author, null, null, type, "", false, false);
        assert.equal(element.children[1].props.style?.animation, undefined);
    }
});
