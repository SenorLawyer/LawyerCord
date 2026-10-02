/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function deferred<T>() {
    let resolve: (value: T) => void = () => { throw new Error("Promise is not initialized."); };
    let reject: (error: unknown) => void = () => { throw new Error("Promise is not initialized."); };
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture() {
    const root = process.env.AUDIT_QUEST_ROOT ?? "src/equicordplugins/questify";
    const ready = deferred<void>();
    let userId: string | undefined = "first";
    const settings = {
        disableQuestsEverything: false, questFetchInterval: 1800, questButtonDisplay: "always", questButtonIndicator: "badge",
        newQuestAlertSound: "sound", newQuestAlertVolume: 50, newExcludedQuestAlertSound: "excluded", newExcludedQuestAlertVolume: 25,
        notifyOnNewQuests: true, notifyOnNewExcludedQuests: true, questButtonIncludedTypes: {},
        notifyOnQuestComplete: true, questCompletedAlertSound: "complete", questCompletedAlertVolume: 75
    };
    const quest = (id: string) => ({ id, config: { messages: { questName: `${id} Quest` } } });
    const quests = new Map<string, ReturnType<typeof quest>>([["existing", quest("existing")]]);
    const excludedQuests = new Map<string, { id: string; }>();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let fetches = 0;
    let fetch: () => Promise<void> = async () => {};
    let get: () => Promise<{ body: object; }> = async () => ({ body: quest("excluded") });
    let gets = 0;
    let validations = 0;
    let logCount = 0;
    const warnings: unknown[][] = [];
    const notifications: { onClick?: () => void; }[] = [];
    const sounds: string[] = [];
    const navigations: string[] = [];
    const sleeps: (() => void)[] = [];
    const modules: Record<string, unknown> = {
        "@api/AudioPlayer": { playAudio: (sound: string) => sounds.push(sound) },
        "@api/Notifications": { showNotification: (notification: { onClick?: () => void; }) => notifications.push(notification) },
        "@api/ServerList": { addServerListElement() {}, removeServerListElement() {}, ServerListRenderPosition: {} },
        "@api/Settings": { PlainSettings: { plugins: { Questify: { enabled: true } } } },
        "@components/index": { ErrorBoundary: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, StartAt: {} },
        "@utils/misc": { sleep: () => new Promise<void>(resolve => sleeps.push(resolve)) },
        "@utils/Logger": { Logger: class {
            info() { logCount++; } log() { logCount++; } debug() { logCount++; } error() { logCount++; }
            warn(...args: unknown[]) { warnings.push(args); }
        } },
        "@webpack": { onceReady: ready.promise, findByCodeLazy: (code: string) =>
            code === "QUESTS_FETCH_CURRENT_QUESTS_BEGIN" ? () => { fetches++; return fetch(); }
                : code.startsWith("config).with") ? () => true : (body: object) => body
        },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
            QuestStore: { quests, excludedQuests, getQuest: (id: string) => quests.get(id) },
            RestAPI: { get: () => { gets++; return get(); } }
        },
        "@webpack/common/utils": { NavigationRouter: { transitionTo: (url: string) => navigations.push(url) } },
        "components/questButton": {}, "components/questTileContextMenu": {},
        "settings/access": { getQuestifySettings: () => settings },
        "settings/ignoredQuests": { questIsIgnored: () => false, validateIgnoredQuests: () => validations++ },
        "settings/rerender": {},
        "settings/restartTracking": { initializeRestartTracking() {}, disposeRestartTracking() {}, setRestartDirty() {} },
        "settings/store": { settings: {} }, "utils/questState": {}, "utils/questTiles": {},
        "utils/filtering": {
            getNewQuests: (before: { id: string; }[], after: { id: string; }[]) => after.filter(q => !before.some(p => p.id === q.id)),
            normalizeQuestName: (q: ReturnType<typeof quest>) => q.config.messages.questName,
            questMatchesIncludedTypes: () => true
        },
        "utils/ui": { QUEST_PAGE: "/quests" }, "styles.css?managed": {}
    };
    const cache = new Map<string, Record<string, unknown>>();
    function load(name: string): Record<string, unknown> {
        if (name in modules) return modules[name] as Record<string, unknown>;
        const cached = cache.get(name); if (cached) return cached;
        const path = `${root}/${name}${name === "index" ? ".tsx" : ".ts"}`;
        const { outputText } = transpileModule(readFileSync(path, "utf8"), {
            fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
        });
        const exports: Record<string, unknown> = {};
        cache.set(name, exports);
        runInNewContext(outputText, {
            exports, require: (dependency: string) => load(dependency.startsWith(".") ? posix.normalize(posix.join(posix.dirname(name), dependency)) : dependency),
            window: { location: { pathname: "/quests" } }, VencordNative: undefined,
            setInterval: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
            clearInterval: (id: number) => timers.delete(id)
        });
        return exports;
    }
    const plugin = load("index").default as {
        start(): void; stop(): void;
        flux: { LOGOUT(data?: object): void; LOGIN_SUCCESS(): Promise<void>; QUESTS_USER_STATUS_UPDATE(data: object): void; };
    };
    const fetching = load("utils/fetching") as { fetchAndAlertQuests(source: string): Promise<unknown>; };
    const timersModule = load("settings/fetching") as { startAutoFetchingQuests(force?: boolean): void; };
    async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
    return {
        plugin, fetching, timersModule, ready, settings, quests, excludedQuests, timers, sleeps, sounds, notifications, navigations, warnings,
        quest, settle, get fetches() { return fetches; }, get gets() { return gets; }, get validations() { return validations; }, get logCount() { return logCount; },
        setUser(id: string | undefined) { userId = id; }, setFetch(fn: typeof fetch) { fetch = fn; }, setGet(fn: typeof get) { get = fn; },
        async start() { plugin.start(); ready.resolve(); await settle(); },
        async wake() { sleeps.shift()?.(); await settle(); }
    };
}

test("Questify startup cannot recreate stopped tasks, including after a restart", async () => {
    const f = fixture(); f.plugin.start(); f.plugin.stop(); f.ready.resolve(); await f.settle();
    assert.equal(f.fetches, 0); assert.equal(f.timers.size, 0);
    f.plugin.start(); await f.settle(); assert.equal(f.fetches, 1); assert.equal(f.timers.size, 1);
    f.plugin.stop();
});

test("Questify logout always stops fetching and settings cannot revive stopped timers", async () => {
    const f = fixture(); await f.start(); assert.equal(f.timers.size, 1);
    f.plugin.flux.LOGOUT({ isSwitchingAccount: false }); f.setUser(undefined);
    assert.equal(f.timers.size, 0);
    f.timersModule.startAutoFetchingQuests(true); assert.equal(f.timers.size, 0);
    f.setUser("second"); await f.plugin.flux.LOGIN_SUCCESS(); assert.equal(f.timers.size, 1);
    f.plugin.stop(); f.timersModule.startAutoFetchingQuests(true); assert.equal(f.timers.size, 0);
});

test("Questify logout invalidates startup and login waiting for webpack readiness", async () => {
    const f = fixture(); f.plugin.start();
    const login = f.plugin.flux.LOGIN_SUCCESS();
    f.plugin.flux.LOGOUT({ isSwitchingAccount: false }); f.setUser(undefined);
    f.ready.resolve(); await f.settle(); await login;
    assert.equal(f.fetches, 0); assert.equal(f.timers.size, 0);
    f.plugin.stop();
});

test("Questify stopped or replaced accounts cannot alert from pending quest refreshes", async () => {
    for (const change of ["stop", "account"]) {
        const f = fixture(); await f.start();
        const pending = deferred<void>(); f.setFetch(() => pending.promise);
        const result = f.fetching.fetchAndAlertQuests("manual");
        f.quests.set("new", f.quest("new"));
        if (change === "stop") f.plugin.stop(); else f.setUser("second");
        pending.resolve(); await f.settle(); await f.wake(); await result;
        assert.equal(f.sounds.length, 0); assert.equal(f.notifications.length, 0); assert.equal(f.gets, 0);
    }
});

test("Questify stops excluded quest requests and notifications when their owner stops", async () => {
    const f = fixture(); await f.start();
    const pending = deferred<{ body: object; }>(); f.setGet(() => pending.promise);
    const result = f.fetching.fetchAndAlertQuests("manual"); await f.settle();
    f.excludedQuests.set("one", { id: "one" }); f.excludedQuests.set("two", { id: "two" });
    await f.wake(); assert.equal(f.gets, 1);
    f.plugin.stop(); pending.resolve({ body: f.quest("one") }); await f.settle(); await f.wake(); await result;
    assert.equal(f.gets, 1); assert.equal(f.sounds.length, 0); assert.equal(f.notifications.length, 0);
});

test("Questify coalesces only within an account session and stale completions cannot clear its replacement", async () => {
    const f = fixture(); await f.start();
    const old = deferred<void>(); f.setFetch(() => old.promise);
    const first = f.fetching.fetchAndAlertQuests("first");
    f.plugin.flux.LOGOUT({ isSwitchingAccount: true }); f.setUser("second");
    f.setFetch(async () => {}); await f.plugin.flux.LOGIN_SUCCESS();
    const current = deferred<void>(); f.setFetch(() => current.promise);
    const second = f.fetching.fetchAndAlertQuests("second"); const launches = f.fetches;
    old.resolve(); await f.settle(); await f.wake(); await first;
    const coalesced = f.fetching.fetchAndAlertQuests("duplicate"); assert.equal(f.fetches, launches);
    current.resolve(); await f.settle(); await f.wake(); await Promise.all([second, coalesced]);
    f.plugin.stop();
});

test("Questify alerts current quests once and retained navigation callbacks honor account ownership", async () => {
    const f = fixture(); await f.start();
    const result = f.fetching.fetchAndAlertQuests("manual"); await f.settle();
    f.quests.set("new", f.quest("new")); await f.wake(); await result;
    assert.deepEqual(f.sounds, ["sound"]); assert.equal(f.notifications.length, 1);
    f.notifications[0].onClick?.(); assert.equal(f.navigations.length, 1);
    f.setUser("second"); f.notifications[0].onClick?.(); assert.equal(f.navigations.length, 1);
    f.plugin.stop();
});

test("Questify frequent status updates do not retain logged payloads and still validate quest state", async () => {
    const f = fixture(); await f.start(); const logs = f.logCount;
    for (let i = 0; i < 100; i++) f.plugin.flux.QUESTS_USER_STATUS_UPDATE({ user_status: { quest_id: "existing" } });
    assert.equal(f.validations, 100); assert.equal(f.logCount, logs);
    f.plugin.stop();
});

test("Questify failed manual fetches resolve and report one warning for the current owner", async () => {
    const f = fixture(); await f.start();
    const pending = deferred<void>(); f.setFetch(() => pending.promise);
    const first = f.fetching.fetchAndAlertQuests("manual");
    const second = f.fetching.fetchAndAlertQuests("duplicate");
    pending.reject(new Error("Request failed."));
    assert.deepEqual(await Promise.all([first, second]), [null, null]); assert.equal(f.warnings.length, 1);
    f.plugin.stop();
});

test("Questify preserves completion alerts for snake and camel payloads and ignores repeated completions", async () => {
    for (const camel of [false, true]) {
        const f = fixture(); await f.start();
        const completed = new Date().toISOString();
        const data = camel ? { userStatus: { questId: "existing", completedAt: completed } }
            : { user_status: { quest_id: "existing", completed_at: completed } };
        f.plugin.flux.QUESTS_USER_STATUS_UPDATE(data); f.plugin.flux.QUESTS_USER_STATUS_UPDATE(data);
        assert.deepEqual(f.sounds, ["complete"]); assert.equal(f.notifications.length, 1);
        f.notifications[0].onClick?.(); assert.equal(f.navigations.length, 1);
        f.plugin.stop(); f.notifications[0].onClick?.(); assert.equal(f.navigations.length, 1);
    }
});
