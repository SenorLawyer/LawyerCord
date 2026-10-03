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
import type { ReleaseCatalog, ReleaseUpdate, UpdateRelease } from "@shared/updateRelease";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { createHash } from "crypto";
import { ipcMain } from "electron";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { getStagedUpdateError, replaceVerifiedArchive, restartStagedUpdate } from "./archiveReplacement";
import { ASAR_FILE, serializeErrors } from "./common";
import { type GithubRelease, releaseChannel, selectUpdateRelease } from "./releaseSelection";

const API_BASE = `https://api.github.com/repos/${gitRemote}`;
let pendingUpdate: { release: ReleaseUpdate; url: string; digest: string; } | undefined;
let preparedUpdate: typeof pendingUpdate;
let updateCheck = Symbol();
let applying: Promise<boolean> | undefined;
let restartRequired = false;

async function githubGet<T>(endpoint: string) {
    return fetchJson<T>(API_BASE + endpoint, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": VENCORD_USER_AGENT }
    });
}

function releaseAsset(release: GithubRelease) {
    const asset = release.assets.find(asset => asset.name === ASAR_FILE);
    if (!asset || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
        throw new Error("This release has no verified desktop archive.");
    const url = new URL(asset.browser_download_url);
    if (url.origin !== "https://github.com" || url.pathname !== `/${gitRemote}/releases/download/${release.tag_name}/${ASAR_FILE}` || url.search || url.hash || url.username || url.password)
        throw new Error("This release archive is not hosted in the official repository.");
    return { url: asset.browser_download_url, digest: asset.digest };
}

function describeRelease(release: GithubRelease): UpdateRelease {
    const channel = releaseChannel(release);
    if (!channel) throw new Error("Choose a published Stable, Beta or Nightly release.");
    return {
        tag: release.tag_name, name: release.name || release.tag_name, channel,
        publishedAt: release.published_at,
        version: /^v(\d+\.\d+\.\d+\.\d+)/.exec(release.tag_name)?.[1]
    };
}

async function getReleaseCatalog(_: unknown, page: unknown = 1): Promise<ReleaseCatalog> {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 50)
        throw new Error("Choose a valid release page.");
    const releases = await githubGet<GithubRelease[]>(`/releases?per_page=100&page=${page}`);
    return {
        releases: releases.filter(release => releaseChannel(release) && release.assets.some(asset => asset.name === ASAR_FILE && typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest))).map(describeRelease),
        hasMore: releases.length === 100 && page < 50
    };
}

async function getRelease(channel: UpdateChannel, tag?: unknown): Promise<GithubRelease> {
    if (tag !== undefined) {
        if (typeof tag !== "string" || tag.length > 100 || !/^(v\d+\.\d+\.\d+\.\d+(?:-beta\.\d+)?|nightly-\d{8}-\d{4}-[a-f\d]+)$/.test(tag))
            throw new Error("Choose a valid release version.");
        const release = await githubGet<GithubRelease>(`/releases/tags/${encodeURIComponent(tag)}`);
        if (release.tag_name !== tag || !releaseChannel(release)) throw new Error("This release is unavailable.");
        return release;
    }
    const releases: GithubRelease[] = [];
    for (let page = 1; page <= 10; page++) {
        const batch = await githubGet<GithubRelease[]>(`/releases?per_page=100&page=${page}`);
        releases.push(...batch);
        if (batch.length < 100 || releases.some(release => releaseChannel(release) === "stable") && (channel === "stable" || releases.some(release => releaseChannel(release) === channel))) break;
    }
    return selectUpdateRelease(releases, channel);
}

interface Comparison {
    status: "ahead" | "behind" | "identical" | "diverged";
    commits: Array<{ sha: string; author: { login: string } | null; commit: { author: { name: string }; message: string } }>;
}

async function resolveRelease(channel: UpdateChannel, tag?: unknown): Promise<{ release: ReleaseUpdate; url: string; digest: string }> {
    const selected = await getRelease(channel, tag);
    const asset = releaseAsset(selected);
    const { sha: commit } = await githubGet<{ sha: string }>(`/commits/${encodeURIComponent(selected.tag_name)}`);
    const same = commit === gitHash || commit.startsWith(gitHash) && gitHash.length >= 7;
    const comparison = same ? undefined : await githubGet<Comparison>(`/compare/${gitHash}...${commit}`);
    return {
        ...asset,
        release: {
            ...describeRelease(selected), commit, currentVersion: VERSION,
            relation: same || comparison?.status === "identical" ? "current" : comparison?.status === "behind" ? "rollback" : comparison?.status === "ahead" ? "upgrade" : "switch",
            changes: comparison?.commits.map(c => ({ hash: c.sha, author: c.author?.login ?? c.commit.author.name, message: c.commit.message.split("\n")[0] })) ?? []
        }
    };
}

async function checkRelease(_: unknown, channel: unknown, tag?: unknown) {
    const previousError = getStagedUpdateError(__dirname);
    if (previousError) throw new Error(previousError);
    if (applying || restartRequired) {
        if (pendingUpdate) return pendingUpdate.release;
        throw new Error("Restart Discord to finish installing the selected version.");
    }
    const check = updateCheck = Symbol();
    pendingUpdate = undefined;
    const pending = await resolveRelease(normalizeUpdateChannel(channel), tag);
    if (check === updateCheck) pendingUpdate = pending;
    return pending.release;
}

async function prepareUpdate(_: unknown, channel: unknown, tag?: unknown) {
    if (applying || restartRequired) return false;
    preparedUpdate = undefined;
    const check = updateCheck = Symbol();
    pendingUpdate = undefined;
    const pending = await resolveRelease(normalizeUpdateChannel(channel), tag);
    if (check !== updateCheck) return false;
    if (pending.release.relation === "current" || tag === undefined && pending.release.relation !== "upgrade") return false;
    pendingUpdate = preparedUpdate = pending;
    return true;
}

function applyUpdates() {
    if (applying) return applying;
    if (restartRequired) return Promise.resolve(true);
    const pending = preparedUpdate;
    if (!pending) return Promise.resolve(false);
    pendingUpdate = pending;
    return applying = (async () => {
        const data = await fetchBuffer(pending.url);
        if (`sha256:${createHash("sha256").update(data).digest("hex")}` !== pending.digest)
            throw new Error("The downloaded update does not match its checksum. Try downloading it again.");
        await replaceVerifiedArchive(__dirname, data);
        restartRequired = true;
        return true;
    })().finally(() => { applying = undefined; });
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${gitRemote}`));
ipcMain.handle(IpcEvents.GET_RELEASES, serializeErrors(getReleaseCatalog));
ipcMain.handle(IpcEvents.CHECK_RELEASE, serializeErrors(checkRelease));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(async (_: unknown, channel: unknown) => (await checkRelease(_, channel)).changes));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(prepareUpdate));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));

ipcMain.handle(IpcEvents.RESTART_UPDATE, serializeErrors(restartStagedUpdate));
