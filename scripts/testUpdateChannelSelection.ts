/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { selectUpdateRelease, type GithubRelease } from "../src/main/updater/releaseSelection";

function release(tag_name: string, published_at: string, prerelease = false): GithubRelease {
    return {
        assets: [],
        prerelease,
        published_at,
        tag_name,
    };
}

const stable = release("v2.0.0.0", "2026-08-29T18:45:34Z");
const oldBeta = release("v1.17.0.0-beta.8", "2026-08-30T09:00:00Z", true);
const newBeta = release("v2.1.0.0-beta.1", "2026-08-30T09:00:00Z", true);
const oldNightly = release("nightly-20260805-2102-2a2de339", "2026-08-05T21:07:39Z", true);
const newNightly = release("nightly-20260831-0900-70405925", "2026-08-31T09:00:00Z", true);

assert.equal(selectUpdateRelease([oldNightly, stable], "stable"), stable);
assert.equal(selectUpdateRelease([oldBeta, stable], "beta"), stable, "beta falls back to a higher stable release");
assert.equal(selectUpdateRelease([newBeta, stable], "beta"), newBeta, "beta selects a newer beta release");
assert.equal(selectUpdateRelease([oldNightly, stable], "nightly"), stable, "nightly falls back to the newer stable release");
assert.equal(selectUpdateRelease([newNightly, newBeta, stable], "nightly"), newNightly, "nightly selects the newest nightly release");

const sameVersionBeta = release("v2.0.0.0-beta.9", "2026-08-31T10:00:00Z", true);
assert.equal(selectUpdateRelease([sameVersionBeta, stable], "beta"), stable, "stable supersedes beta at the same version");
assert.equal(selectUpdateRelease([sameVersionBeta, stable], "nightly"), stable, "nightly fallback also respects stable promotion");
assert.equal(selectUpdateRelease([newBeta], "beta"), newBeta);
assert.equal(selectUpdateRelease([newBeta], "nightly"), newBeta);
assert.equal(selectUpdateRelease([stable], "beta"), stable);
assert.equal(selectUpdateRelease([newNightly], "nightly"), newNightly);
for (const channel of ["stable", "beta", "nightly"] as const)
    assert.throws(() => selectUpdateRelease([], channel), new RegExp(`No ${channel} release`));
for (const channel of ["stable", "beta"] as const)
    assert.throws(() => selectUpdateRelease([newNightly], channel), new RegExp(`No ${channel} release`));

console.log("update channel selection checks passed");
