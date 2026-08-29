/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { IpcEvents } from "@shared/IpcEvents";
import { normalizeUpdateChannel } from "@shared/updateChannel";
import { execFile as cpExecFile } from "child_process";
import { ipcMain } from "electron";
import { join } from "path";
import { promisify } from "util";

import { serializeErrors } from "./common";

const VENCORD_SRC_DIR = join(__dirname, "..");
const LAWYERCORD_DIR = join(__dirname, "../../");

const execFile = promisify(cpExecFile);

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

function git(...args: string[]) {
    const opts = { cwd: VENCORD_SRC_DIR };

    if (isFlatpak) return execFile("flatpak-spawn", ["--host", "git", ...args], opts);
    else return execFile("git", args, opts);
}

async function getRepo() {
    const res = await git("remote", "get-url", "origin");
    return res.stdout.trim()
        .replace(/git@(.+):/, "https://$1/")
        .replace(/\.git$/, "");
}

function updateBranch(channel: unknown): string {
    const selected = normalizeUpdateChannel(channel);
    return selected === "stable" ? "main" : selected;
}

async function fetchBranch(channel: unknown): Promise<string> {
    let branch = updateBranch(channel);
    if (branch !== "main" && !(await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).stdout.trim())
        branch = "main";
    await git("fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
    return branch;
}

async function calculateGitChanges(_: unknown, channel: unknown) {
    const branch = await fetchBranch(channel);

    const res = await git("log", `HEAD..origin/${branch}`, "--pretty=format:%an/%H/%s");

    const commits = res.stdout.trim();
    return commits ? commits.split("\n").map(line => {
        const [author, hash, ...rest] = line.split("/");
        return {
            hash, author,
            message: rest.join("/").split("\n")[0]
        };
    }) : [];
}

async function pull(_: unknown, channel: unknown) {
    const branch = await fetchBranch(channel);
    const before = (await git("rev-parse", "HEAD")).stdout.trim();
    const beforeBranch = (await git("branch", "--show-current")).stdout.trim();
    const dirty = (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout.trim();
    if (dirty) throw new Error("Commit or stash local changes before updating");

    if (beforeBranch === branch) {
        await git("merge", "--ff-only", `origin/${branch}`);
    } else {
        const exists = (await git("for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)).stdout.trim();
        if (!exists) {
            await git("switch", "--create", branch, "--track", `origin/${branch}`);
        } else {
            await git("switch", branch);
            await git("merge", "--ff-only", `origin/${branch}`);
        }
    }

    const after = (await git("rev-parse", "HEAD")).stdout.trim();
    return before !== after || beforeBranch !== branch;
}

async function build() {
    const opts = { cwd: LAWYERCORD_DIR };

    const command = isFlatpak ? "flatpak-spawn" : "node";
    const args = isFlatpak ? ["--host", "node", "scripts/build/build.mjs"] : ["scripts/build/build.mjs"];

    if (IS_DEV) args.push("--dev");

    const res = await execFile(command, args, opts);

    return !res.stderr.includes("Build failed");
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(getRepo));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(pull));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(build));
