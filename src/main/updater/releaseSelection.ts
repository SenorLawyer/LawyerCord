/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { UpdateChannel } from "@shared/updateChannel";

export interface GithubRelease {
    assets: Array<{ name: string; browser_download_url: string; }>;
    prerelease: boolean;
    published_at: string;
    tag_name: string;
    target_commitish: string;
}

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)\.(\d+)-beta\.\d+$/;
const NIGHTLY_TAG = /^nightly-\d{8}-\d{4}-[a-f\d]+$/;

function compareVersions(first: string, second: string): number {
    const firstMatch = STABLE_TAG.exec(first) ?? BETA_TAG.exec(first);
    const secondMatch = STABLE_TAG.exec(second) ?? BETA_TAG.exec(second);
    if (!firstMatch || !secondMatch) return 0;

    for (let index = 1; index <= 4; index++) {
        const difference = Number(firstMatch[index]) - Number(secondMatch[index]);
        if (difference) return difference;
    }
    return 0;
}

function latest(releases: GithubRelease[]): GithubRelease | undefined {
    return releases.reduce<GithubRelease | undefined>((newest, release) => !newest || release.published_at > newest.published_at ? release : newest, undefined);
}

export function selectUpdateRelease(releases: GithubRelease[], channel: UpdateChannel): GithubRelease {
    const stable = latest(releases.filter(release => !release.prerelease && STABLE_TAG.test(release.tag_name)));
    const beta = latest(releases.filter(release => release.prerelease && BETA_TAG.test(release.tag_name)));
    const nightly = latest(releases.filter(release => release.prerelease && NIGHTLY_TAG.test(release.tag_name)));

    if (channel === "stable") {
        if (stable) return stable;
    } else if (channel === "beta") {
        if (!beta) {
            if (stable) return stable;
        } else if (!stable || compareVersions(beta.tag_name, stable.tag_name) > 0) {
            return beta;
        } else {
            return stable;
        }
    } else {
        const preview = beta && (!stable || compareVersions(beta.tag_name, stable.tag_name) > 0) ? beta : stable;
        const selected = latest([nightly, preview].filter((release): release is GithubRelease => release !== undefined));
        if (selected) return selected;
    }

    throw new Error(`No ${channel} release is available`);
}
