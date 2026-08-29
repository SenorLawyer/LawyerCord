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

import { fetchBuffer, fetchJson } from "@main/utils/http";
import { IpcEvents } from "@shared/IpcEvents";
import { normalizeUpdateChannel, type UpdateChannel } from "@shared/updateChannel";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { ipcMain } from "electron";
import { writeFileSync } from "original-fs";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { ASAR_FILE, serializeErrors } from "./common";
import { type GithubRelease, selectUpdateRelease } from "./releaseSelection";

const API_BASE = `https://api.github.com/repos/${gitRemote}`;
let PendingUpdate: string | null = null;

async function githubGet<T = any>(endpoint: string) {
    return fetchJson<T>(API_BASE + endpoint, {
        headers: {
            Accept: "application/vnd.github+json",
            // "All API requests MUST include a valid User-Agent header.
            // Requests with no User-Agent header will be rejected."
            "User-Agent": VENCORD_USER_AGENT
        }
    });
}

async function getRelease(channel: UpdateChannel): Promise<GithubRelease> {
    const releases = await githubGet<GithubRelease[]>("/releases?per_page=100");
    return selectUpdateRelease(releases, channel);
}

async function fetchUpdates(channel: UpdateChannel) {
    const release = await getRelease(channel);
    if (release.target_commitish === gitHash) return null;

    const asset = release.assets.find(asset => asset.name === ASAR_FILE);
    if (!asset) throw new Error(`The ${channel} release does not include ${ASAR_FILE}`);
    PendingUpdate = asset.browser_download_url;
    return release;
}

async function calculateGitChanges(_: unknown, updateChannel: unknown) {
    const release = await fetchUpdates(normalizeUpdateChannel(updateChannel));
    if (!release) return [];

    const data = await githubGet(`/compare/${gitHash}...${release.target_commitish}`);

    return data.commits.map((c: any) => ({
        hash: c.sha,
        author: c.author?.login ?? c.commit?.author?.name ?? "Unknown Author",
        message: c.commit.message.split("\n")[0]
    }));
}

async function applyUpdates() {
    if (!PendingUpdate) return true;

    const data = await fetchBuffer(PendingUpdate);
    writeFileSync(__dirname, data, { flush: true });

    PendingUpdate = null;

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${gitRemote}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(async (_: unknown, updateChannel: unknown) => Boolean(await fetchUpdates(normalizeUpdateChannel(updateChannel)))));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));
