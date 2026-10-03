/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as selection from "../src/main/updater/releaseSelection";
import * as channels from "../src/shared/updateChannel";

const nativeRequire = createRequire(import.meta.url);
const events = { GET_UPDATES: "changes", GET_RELEASES: "catalog", CHECK_RELEASE: "check", UPDATE: "update", BUILD: "build", GET_REPO: "repo", RESTART_UPDATE: "restart" };
const bytes = Buffer.from("verified archive");
const stable = { tag_name: "v3.0.1.0", name: "Stable 3.0.1.0", published_at: "2026-09-01T00:00:00Z", prerelease: false, assets: [{ name: "desktop.asar", browser_download_url: "https://github.com/fixture/repo/releases/download/v3.0.1.0/desktop.asar", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }] };

function fixture() {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const requests: string[] = [];
    const status = "behind";
    let archive = bytes;
    let replacements = 0;
    let delayDownload: (() => void) | undefined;
    let waitDownload = false;
    const modules: Record<string, unknown> = {
        "@shared/IpcEvents": { IpcEvents: events }, "@shared/updateChannel": channels,
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "test" },
        "~git-hash": "installed", "~git-remote": "fixture/repo", "./releaseSelection": selection,
        "./common": { ASAR_FILE: "desktop.asar", serializeErrors: (fn: unknown) => fn },
        "./archiveReplacement": { getStagedUpdateError: () => undefined, replaceVerifiedArchive: async () => { replacements++; }, restartStagedUpdate: async () => true },
        electron: { ipcMain: { handle: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(event, fn) } },
        "@main/utils/http": {
            async fetchJson(url: string) {
                requests.push(url);
                if (url.includes("/releases/tags/")) return stable;
                if (url.includes("/releases?")) return [stable];
                if (url.includes("/commits/")) return { sha: "older" };
                if (url.includes("/compare/")) return { status, commits: [] };
                throw new Error(url);
            },
            async fetchBuffer() {
                if (waitDownload) await new Promise<void>(resolve => { delayDownload = resolve; });
                return archive;
            }
        }
    };
    const source = transpileModule(readFileSync("src/main/updater/http.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(source, { exports: {}, __dirname: "/fixture/desktop.asar", URL, VERSION: "4.1.0.0", require: (name: string) => name in modules ? modules[name] : nativeRequire(name) });
    const call = (event: string, ...args: unknown[]) => {
        const fn = handlers.get(event);
        assert.ok(fn);
        return fn(undefined, ...args);
    };
    return { call, requests, corrupt: () => { archive = Buffer.from("wrong"); }, replacements: () => replacements, delay: () => { waitDownload = true; }, resume: () => { assert.ok(delayDownload); delayDownload(); } };
}

test("rollback metadata survives empty compare commits and requires explicit selection", async () => {
    const f = fixture();
    const result = await f.call("check", "stable") as { relation: string; changes: unknown[]; currentVersion: string };
    assert.equal(result.relation, "rollback");
    assert.equal(result.changes.length, 0);
    assert.equal(result.currentVersion, "4.1.0.0");
    assert.equal(await f.call("build"), false, "checking alone does not authorize a rollback");
    assert.equal(await f.call("update", "stable"), false);
    assert.equal(await f.call("update", "nightly", stable.tag_name), true);
    assert.ok(f.requests.at(-3)?.includes(`/releases/tags/${stable.tag_name}`));
    assert.equal(await f.call("build"), true);
    assert.equal(f.replacements(), 1);
    assert.equal(await f.call("update", "stable", stable.tag_name), false);
});

test("explicit tag validation rejects URL injection and mismatched official release", async () => {
    const f = fixture();
    await assert.rejects(f.call("check", "stable", "https://example.com/file"), /valid release/);
    await assert.rejects(f.call("check", "stable", "v1.0.0.0"), /unavailable/);
    await assert.rejects(f.call("catalog", 0), /valid release page/);
    await assert.rejects(f.call("catalog", 51), /valid release page/);
    assert.equal((await f.call("catalog", 2) as { releases: unknown[] }).releases.length, 1);
    assert.ok(f.requests.at(-1)?.endsWith("page=2"));
});

test("checksum failures preserve archive and duplicate apply calls coalesce", async () => {
    const corrupt = fixture();
    await corrupt.call("update", "stable", stable.tag_name);
    corrupt.corrupt();
    await assert.rejects(corrupt.call("build"), /checksum/);
    assert.equal(corrupt.replacements(), 0);
    const f = fixture();
    await f.call("update", "stable", stable.tag_name);
    f.delay();
    const first = f.call("build");
    const second = f.call("build");
    assert.equal(await f.call("update", "nightly", stable.tag_name), false);
    f.resume();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(f.replacements(), 1);
});

function rendererFixture() {
    const exports: Record<string, unknown> = {};
    let resolveCheck: ((value: unknown) => void) | undefined;
    let resolveBuild: ((value: unknown) => void) | undefined;
    let staged = false;
    const installed: Array<unknown[]> = [];
    const modules: Record<string, unknown> = {
        "@api/Settings": { flushSettings: async () => undefined },
        "~git-hash": "installed", "./Logger": { Logger: class {} }, "./native": {}, "./updateClassification": {}
    };
    const source = transpileModule(readFileSync("src/utils/updater.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(source, {
        exports, IS_STANDALONE: true,
        Vencord: { Settings: { updateChannel: "stable" } },
        VencordNative: { updater: {
            checkRelease: () => staged ? Promise.resolve({ ok: true, value: { tag: installed.at(-1)?.[1], relation: "rollback", changes: [] } }) : new Promise(resolve => { resolveCheck = resolve; }),
            update: async (...args: unknown[]) => { installed.push(args); return { ok: true, value: true }; },
            rebuild: () => new Promise(resolve => { resolveBuild = resolve; })
        } },
        require: (name: string) => name in modules ? modules[name] : nativeRequire(name)
    });
    const call = (name: string, ...args: unknown[]) => {
        const fn = exports[name];
        assert.equal(typeof fn, "function");
        return Reflect.apply(fn as (...values: unknown[]) => unknown, undefined, args);
    };
    return {
        exports, installed, call, selected: () => exports.selectedRelease,
        checked: () => { assert.ok(resolveCheck); resolveCheck({ ok: true, value: { ...stable, tag: stable.tag_name, relation: "rollback", changes: [] } }); },
        built: (success = true) => { staged = success; assert.ok(resolveBuild); resolveBuild({ ok: true, value: success }); }
    };
}

test("renderer discards stale checks and preserves an in-flight explicit rollback across channel reset", async () => {
    const f = rendererFixture();
    const stale = f.call("checkForUpdates");
    f.call("resetUpdateState");
    f.checked();
    await stale;
    assert.equal(f.exports.selectedRelease, undefined);
    const current = f.call("checkForUpdates", stable.tag_name);
    f.checked();
    assert.equal(await current, false);
    assert.equal(f.exports.isNewer, true);
    const snapshots: unknown[] = [];
    const unsubscribe = f.call("subscribeUpdateState", () => snapshots.push(f.call("getUpdateState"))) as () => void;
    const first = f.call("update", stable.tag_name);
    const second = f.call("update", stable.tag_name);
    f.call("resetUpdateState");
    assert.equal(f.exports.isUpdating, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.built();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(f.installed, [["stable", stable.tag_name]]);
    assert.equal(f.exports.restartRequired, true);
    const stagedRelease = f.selected();
    assert.ok(typeof stagedRelease === "object" && stagedRelease !== null && "tag" in stagedRelease);
    assert.equal(stagedRelease.tag, stable.tag_name);
    f.call("resetUpdateState");
    assert.equal(f.exports.restartRequired, true);
    assert.equal(f.exports.isUpdating, false);
    assert.deepEqual(snapshots, [1, 2]);
    unsubscribe();
});

test("a failed packaged download allows choosing a different release instead of retrying the old target", async () => {
    const f = rendererFixture();
    const first = f.call("update", stable.tag_name) as Promise<boolean>;
    const failed = assert.rejects(first, /could not be installed/);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.built(false);
    await failed;
    assert.equal(f.exports.restartRequired, false);
    const nextTag = "v4.1.0.0-beta.1";
    const second = f.call("update", nextTag);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.built();
    assert.equal(await second, true);
    assert.deepEqual(f.installed, [["stable", stable.tag_name], ["stable", nextTag]]);
});
