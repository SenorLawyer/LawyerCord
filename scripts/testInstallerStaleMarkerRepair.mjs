/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./prepareInstallerSource.mjs", import.meta.url), "utf8");

assert.match(source, /errors\.Is\(err, os\.ErrNotExist\)/);
assert.match(source, /os\.Rename\(_appAsar, appAsar\)/);

console.log("installer stale-marker repair check passed");
