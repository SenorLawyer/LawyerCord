/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as releaseSelection from "../src/main/updater/releaseSelection";
import * as updateChannel from "../src/shared/updateChannel";

const nativeRequire = createRequire(import.meta.url);
const events = { GET_RELEASES: "releases", CHECK_RELEASE: "release", RESTART_UPDATE: "restart", GET_UPDATES: "check", UPDATE: "update", BUILD: "build", GET_REPO: "repo" };
const stable = { tag_name: "v3.0.1.0", target_commitish: "main", published_at: "2026-09-28T10:00:00Z", prerelease: false };
const beta = { tag_name: "v3.1.0.0-beta.1", target_commitish: "main", published_at: "2026-09-29T10:00:00Z", prerelease: true };
const nightly = { tag_name: "nightly-20260930-1000-abcdef01", target_commitish: "main", published_at: "2026-09-30T10:00:00Z", prerelease: true };

for (const mode of ["http", "git"]) test(`${mode} updater isolates release channels`, async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const requests: string[] = [];
    const gitCalls: string[][] = [];
    let missingBranch = false;
    let currentCommit = "installed-commit";
    const modules: Record<string, unknown> = {
        "@shared/IpcEvents": { IpcEvents: events },
        "@shared/updateChannel": updateChannel,
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "test" },
        "./releaseSelection": releaseSelection,
        "./archiveReplacement": { getStagedUpdateError: () => undefined, replaceVerifiedArchive: async () => ({ staged: true }), restartStagedUpdate: () => true },
        "~git-hash": currentCommit,
        "~git-remote": "fixture/repo",
        "./common": { ASAR_FILE: "desktop.asar", serializeErrors: (fn: unknown) => fn },
        electron: { ipcMain: { handle: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(event, fn) } },
        "original-fs": {},
        util: { promisify: (fn: unknown) => fn },
        child_process: {
            async execFile(_command: string, args: string[]) {
                gitCalls.push(Array.from(args));
                if (missingBranch && args[0] === "fetch") throw new Error("Missing release branch");
                if (args[0] === "log") return { stdout: "Author/release-commit/Released fix" };
                if (args[0] === "rev-parse") return { stdout: currentCommit };
                if (args[0] === "branch") return { stdout: "main" };
                if (args[0] === "switch") currentCommit = "release-commit";
                return { stdout: "" };
            }
        },
        "@main/utils/http": {
            async fetchJson(url: string) {
                const endpoint = new URL(url).pathname.replace("/repos/fixture/repo", "");
                requests.push(endpoint);
                if (endpoint === "/releases") return [nightly, beta, stable].map(release => ({
                    ...release,
                    assets: [{ name: "desktop.asar", browser_download_url: `https://github.com/fixture/repo/releases/download/${release.tag_name}/desktop.asar`, digest: `sha256:${"a".repeat(64)}` }]
                }));
                if (endpoint.startsWith("/commits/")) return { sha: `commit-${endpoint.slice(9)}` };
                if (endpoint.startsWith("/compare/")) return { status: "ahead", commits: [{ sha: "release-commit", author: { login: "Author" }, commit: { message: "Released fix" } }] };
                throw new Error(`Unexpected request: ${endpoint}`);
            }
        }
    };
    const { outputText } = transpileModule(readFileSync(`src/main/updater/${mode}.ts`, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    runInNewContext(outputText, {
        exports: {}, __dirname: "/fixture/dist", process: { platform: "win32", env: {} }, URL, VERSION: "3.0.0.0",
        require: (name: string) => name in modules ? modules[name] : nativeRequire(name)
    });
    const check = handlers.get(events.GET_UPDATES);
    const update = handlers.get(events.UPDATE);
    assert.ok(check && update);

    for (const [channel, selected] of [["stable", stable], ["beta", beta], ["nightly", nightly], [undefined, stable], ["invalid", stable]] as const) {
        requests.length = 0;
        gitCalls.length = 0;
        await check(undefined, channel);
        await update(undefined, channel);
        if (mode === "http") {
            assert.deepEqual(requests, [
                "/releases", `/commits/${selected.tag_name}`, `/compare/installed-commit...commit-${selected.tag_name}`,
                "/releases", `/commits/${selected.tag_name}`, `/compare/installed-commit...commit-${selected.tag_name}`
            ], "checks and downloads resolve the allowed release tag, never moving main");
        } else {
            const branch = updateChannel.normalizeUpdateChannel(channel);
            assert.equal(gitCalls.filter(args => args[0] === "fetch").length, 2);
            assert.ok(gitCalls.filter(args => args[0] === "fetch").every(args => args[2] === `refs/heads/${branch}:refs/remotes/origin/${branch}`));
            assert.ok(gitCalls.some(args => args[0] === "log" && args[1] === `HEAD..origin/${branch}`));
            assert.ok(gitCalls.some(args => args[0] === "switch" && args.includes(`origin/${branch}`)));
        }
    }
    if (mode === "git") {
        missingBranch = true;
        for (const channel of updateChannel.UPDATE_CHANNELS) {
            gitCalls.length = 0;
            await assert.rejects(check(undefined, channel), /Missing release branch/);
            await assert.rejects(update(undefined, channel), /Missing release branch/);
            assert.ok(gitCalls.every(args => args[0] === "fetch" && !args.join(" ").includes("/main")));
        }
    }
});
