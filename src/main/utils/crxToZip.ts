/* eslint-disable simple-header/header */

/*!
 * crxToZip
 * Copyright (c) 2013 Rob Wu <rob@robwu.nl>
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

export function crxToZip(buf: Buffer) {
    // 50 4b 03 04
    // This is actually a zip file
    if (buf[0] === 80 && buf[1] === 75 && buf[2] === 3 && buf[3] === 4) {
        return buf;
    }

    // 43 72 32 34 (Cr24)
    if (buf[0] !== 67 || buf[1] !== 114 || buf[2] !== 50 || buf[3] !== 52) {
        throw new Error("Invalid header: Does not start with Cr24");
    }

    // 02 00 00 00
    // or
    // 03 00 00 00
    const isV3 = buf[4] === 3;
    const isV2 = buf[4] === 2;

    if ((!isV2 && !isV3) || buf[5] || buf[6] || buf[7]) {
        throw new Error("Unexpected crx format version number.");
    }

    const zipStartOffset = isV2
        ? 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12)
        : 12 + buf.readUInt32LE(8);
    if (zipStartOffset >= buf.length) throw new Error("CRX header extends beyond the archive.");

    return buf.subarray(zipStartOffset);
}
