/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { crxToZip } from "../src/main/utils/crxToZip";

const zip = Buffer.from([80, 75, 3, 4, 1, 2, 3]);
assert.equal(crxToZip(zip), zip);
for (const version of [2, 3]) {
    const header = Buffer.alloc(version === 2 ? 16 : 12);
    header.write("Cr24");
    header.writeUInt32LE(version, 4);
    header.writeUInt32LE(5, 8);
    if (version === 2) header.writeUInt32LE(3, 12);
    const archive = Buffer.concat([header, Buffer.alloc(version === 2 ? 8 : 5), zip]);
    assert.deepEqual(crxToZip(archive), zip);
    for (let length = 0; length < header.length; length++)
        assert.throws(() => crxToZip(archive.subarray(0, length)));
    archive.writeUInt32LE(0xffffffff, 8);
    assert.throws(() => crxToZip(archive));
}
