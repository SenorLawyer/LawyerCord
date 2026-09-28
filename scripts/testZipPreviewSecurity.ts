/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { strToU8, zipSync } from "fflate";

import {
    extractZipArchiveEntry,
    inspectZipArchive,
    MAX_ZIP_COMPRESSION_RATIO,
    MAX_ZIP_ENTRIES,
    MAX_ZIP_ENTRY_BYTES,
    MAX_ZIP_PATH_DEPTH,
    MAX_ZIP_TOTAL_BYTES
} from "../src/equicordplugins/zipPreview/archive";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

interface CentralEntryRef {
    compressedSize: number;
    cursor: number;
    localHeaderOffset: number;
    path: string;
}

function archive(files: Record<string, Uint8Array>, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array<ArrayBuffer> {
    return zipSync(files, { level }) as Uint8Array<ArrayBuffer>;
}

function arrayBuffer(data: Uint8Array): ArrayBuffer {
    return Uint8Array.from(data).buffer;
}

function view(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function findEocd(data: Uint8Array): number {
    const dataView = view(data);
    for (let offset = data.byteLength - 22; offset >= Math.max(0, data.byteLength - 65_557); offset--) {
        if (dataView.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
    }
    throw new Error("Test ZIP has no EOCD");
}

function centralEntries(data: Uint8Array): CentralEntryRef[] {
    const dataView = view(data);
    const eocd = findEocd(data);
    const count = dataView.getUint16(eocd + 10, true);
    let cursor = dataView.getUint32(eocd + 16, true);
    const entries: CentralEntryRef[] = [];
    for (let index = 0; index < count; index++) {
        assert.equal(dataView.getUint32(cursor, true), CENTRAL_DIRECTORY_SIGNATURE);
        const nameLength = dataView.getUint16(cursor + 28, true);
        const extraLength = dataView.getUint16(cursor + 30, true);
        const commentLength = dataView.getUint16(cursor + 32, true);
        entries.push({
            compressedSize: dataView.getUint32(cursor + 20, true),
            cursor,
            localHeaderOffset: dataView.getUint32(cursor + 42, true),
            path: Buffer.from(data.subarray(cursor + 46, cursor + 46 + nameLength)).toString("utf8")
        });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function entryByPath(data: Uint8Array, path: string): CentralEntryRef {
    const entry = centralEntries(data).find(candidate => candidate.path === path);
    if (!entry) throw new Error(`Missing test entry ${path}`);
    return entry;
}

function setEntryUncompressedSize(data: Uint8Array, entry: CentralEntryRef, size: number): void {
    const dataView = view(data);
    dataView.setUint32(entry.cursor + 24, size, true);
    dataView.setUint32(entry.localHeaderOffset + 22, size, true);
}

function setEntryCrc32(data: Uint8Array, entry: CentralEntryRef, crc32: number): void {
    const dataView = view(data);
    dataView.setUint32(entry.cursor + 16, crc32, true);
    dataView.setUint32(entry.localHeaderOffset + 14, crc32, true);
}

function entryDataOffset(data: Uint8Array, entry: CentralEntryRef): number {
    const dataView = view(data);
    return entry.localHeaderOffset
        + 30
        + dataView.getUint16(entry.localHeaderOffset + 26, true)
        + dataView.getUint16(entry.localHeaderOffset + 28, true);
}

function pseudoRandomBytes(length: number, seed = 0x12345678): Uint8Array {
    const output = new Uint8Array(length);
    let state = seed >>> 0;
    for (let index = 0; index < output.length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        output[index] = state;
    }
    return output;
}

function expectRejected(data: Uint8Array, pattern: RegExp, label: string): void {
    assert.throws(() => inspectZipArchive(arrayBuffer(data)), pattern, label);
}

async function testNormalArchiveAndLazyExtraction(): Promise<void> {
    const chunkedInput = pseudoRandomBytes(32 * 1024);
    const input = archive({
        "chunked.bin": chunkedInput,
        "folder/readme.txt": strToU8("bounded ZIP preview\n"),
        "image.bin": Uint8Array.of(0, 1, 2, 3, 4),
    });
    const inspected = inspectZipArchive(arrayBuffer(input));
    assert.deepEqual(inspected.entries.map(entry => entry.path).sort(), ["chunked.bin", "folder/readme.txt", "image.bin"]);
    assert.equal("data" in inspected.entries[0], false, "inspection must retain metadata rather than inflated bytes");

    const readme = inspected.entries.find(entry => entry.path === "folder/readme.txt");
    assert.ok(readme);
    const extraction = extractZipArchiveEntry(inspected, readme, 10 * 1024 * 1024);
    assert.ok(extraction instanceof Promise, "selected-entry extraction must be asynchronous");
    assert.equal(new TextDecoder().decode(await extraction), "bounded ZIP preview\n");

    const chunked = inspected.entries.find(entry => entry.path === "chunked.bin");
    assert.ok(chunked && chunked.compressedSize > 4 * 1024);
    assert.deepEqual(await extractZipArchiveEntry(inspected, chunked, 1024 * 1024), chunkedInput,
        "normal entries spanning multiple bounded input chunks must extract exactly");
}

async function testOnlySelectedEntryIsInflated(): Promise<void> {
    const input = archive({
        "bad.txt": strToU8("This entry will be corrupted after compression.".repeat(1000)),
        "good.txt": strToU8("Only this entry should be inflated."),
    });
    const bad = entryByPath(input, "bad.txt");
    input[entryDataOffset(input, bad) + Math.floor(bad.compressedSize / 2)] ^= 0xff;

    const inspected = inspectZipArchive(arrayBuffer(input));
    const goodEntry = inspected.entries.find(entry => entry.path === "good.txt");
    const badEntry = inspected.entries.find(entry => entry.path === "bad.txt");
    assert.ok(goodEntry && badEntry);
    assert.equal(new TextDecoder().decode(await extractZipArchiveEntry(inspected, goodEntry, 1024)), "Only this entry should be inflated.");
    await assert.rejects(
        extractZipArchiveEntry(inspected, badEntry, 1024 * 1024),
        /decompressed|integrity|declared size/u,
        "corruption in an unselected entry must surface only when that entry is selected"
    );
}

function testCompressionBombAndSizeLimits(): void {
    const bomb = archive({ "bomb.txt": new Uint8Array(4 * 1024 * 1024) }, 9);
    assert.ok(bomb.byteLength < 16 * 1024, "the deterministic fixture should have a bomb-like compression ratio");
    expectRejected(bomb, /compression ratio/u, "high-ratio data must be rejected before inflation");

    const oversized = archive({ "large.bin": pseudoRandomBytes(32 * 1024) });
    setEntryUncompressedSize(oversized, entryByPath(oversized, "large.bin"), MAX_ZIP_ENTRY_BYTES + 1);
    expectRejected(oversized, /entry is too large/u, "per-entry expanded size must be bounded");

    const cumulativeFiles: Record<string, Uint8Array> = {};
    for (let index = 0; index < 6; index++) cumulativeFiles[`part-${index}.bin`] = pseudoRandomBytes(160 * 1024, index + 1);
    const cumulative = archive(cumulativeFiles);
    const declaredSize = Math.floor(MAX_ZIP_TOTAL_BYTES / 6) + 1;
    for (const entry of centralEntries(cumulative)) {
        assert.ok(declaredSize <= entry.compressedSize * MAX_ZIP_COMPRESSION_RATIO);
        setEntryUncompressedSize(cumulative, entry, declaredSize);
    }
    expectRejected(cumulative, /expands beyond/u, "cumulative expanded size must be bounded");
}

function testCompressionRatioBoundary(): void {
    const exact = archive({ "ratio.bin": pseudoRandomBytes(24 * 1024) });
    const exactEntry = entryByPath(exact, "ratio.bin");
    const exactSize = exactEntry.compressedSize * MAX_ZIP_COMPRESSION_RATIO;
    assert.ok(exactSize >= 1024 * 1024 && exactSize <= MAX_ZIP_ENTRY_BYTES);
    setEntryUncompressedSize(exact, exactEntry, exactSize);
    assert.equal(inspectZipArchive(arrayBuffer(exact)).entries.length, 1, "the documented ratio boundary should be accepted");

    const over = Uint8Array.from(exact);
    setEntryUncompressedSize(over, entryByPath(over, "ratio.bin"), exactSize + 1);
    expectRejected(over, /compression ratio/u, "one byte above the ratio boundary must be rejected");
}

function testEntryCountAndPaths(): void {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index <= MAX_ZIP_ENTRIES; index++) files[`entry-${index}.txt`] = new Uint8Array();
    expectRejected(archive(files), /more than 1000 entries/u, "entry count must be enforced before extraction");

    const unsafePaths = [
        "../outside.txt",
        "/absolute.txt",
        "folder\\windows.txt",
        "C:drive.txt",
        "folder/./file.txt",
        `${Array.from({ length: MAX_ZIP_PATH_DEPTH + 1 }, () => "deep").join("/")}/file.txt`,
    ];
    for (const path of unsafePaths) {
        expectRejected(archive({ [path]: strToU8("unsafe") }), /unsafe entry path/u, `unsafe path ${path} must be rejected`);
    }
}

function testMalformedArchives(): void {
    const base = archive({ "one.txt": strToU8("one"), "two.txt": strToU8("two") });

    const signatureInComment = new Uint8Array(base.byteLength + 40);
    signatureInComment.set(base);
    const realEocd = findEocd(signatureInComment.subarray(0, base.byteLength));
    view(signatureInComment).setUint16(realEocd + 20, 40, true);
    view(signatureInComment).setUint32(realEocd + 25, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
    assert.equal(inspectZipArchive(arrayBuffer(signatureInComment)).entries.length, 2,
        "an EOCD-shaped byte sequence inside a valid comment must not shadow the real EOCD");

    expectRejected(base.subarray(0, base.byteLength - 1), /malformed/u, "truncated EOCD must be rejected");

    const badCentralSignature = Uint8Array.from(base);
    view(badCentralSignature).setUint32(centralEntries(badCentralSignature)[0].cursor, 0, true);
    expectRejected(badCentralSignature, /malformed/u, "invalid central-directory signatures must be rejected");

    const badLocalName = Uint8Array.from(base);
    const first = centralEntries(badLocalName)[0];
    badLocalName[first.localHeaderOffset + 30] ^= 1;
    expectRejected(badLocalName, /malformed/u, "local and central file names must match");

    const duplicate = Uint8Array.from(base);
    const duplicateEntries = centralEntries(duplicate);
    duplicate.set(Buffer.from("one.txt"), duplicateEntries[1].cursor + 46);
    expectRejected(duplicate, /duplicate entry paths/u, "duplicate central-directory paths must be rejected");

    const overlapping = Uint8Array.from(base);
    const overlapEntries = centralEntries(overlapping);
    const overlapView = view(overlapping);
    const firstNameLength = overlapView.getUint16(overlapEntries[0].localHeaderOffset + 26, true);
    const firstDataWithoutExtra = overlapEntries[0].localHeaderOffset + 30 + firstNameLength;
    const overlapExtraLength = overlapEntries[1].localHeaderOffset - firstDataWithoutExtra - overlapEntries[0].compressedSize + 1;
    assert.ok(overlapExtraLength > 0 && overlapExtraLength <= 0xffff);
    overlapView.setUint16(overlapEntries[0].localHeaderOffset + 28, overlapExtraLength, true);
    expectRejected(overlapping, /overlap/u, "overlapping local entry ranges must be rejected");

    const encrypted = Uint8Array.from(base);
    const encryptedEntry = centralEntries(encrypted)[0];
    const encryptedView = view(encrypted);
    encryptedView.setUint16(encryptedEntry.cursor + 8, encryptedView.getUint16(encryptedEntry.cursor + 8, true) | 1, true);
    encryptedView.setUint16(encryptedEntry.localHeaderOffset + 6, encryptedView.getUint16(encryptedEntry.localHeaderOffset + 6, true) | 1, true);
    expectRejected(encrypted, /Encrypted or patched/u, "encrypted entries must be rejected");

    const unsupported = Uint8Array.from(base);
    const unsupportedEntry = centralEntries(unsupported)[0];
    view(unsupported).setUint16(unsupportedEntry.cursor + 10, 99, true);
    view(unsupported).setUint16(unsupportedEntry.localHeaderOffset + 8, 99, true);
    expectRejected(unsupported, /unsupported compression/u, "unsupported compression methods must be rejected");

    const unsupportedFlags = Uint8Array.from(base);
    const flaggedEntry = centralEntries(unsupportedFlags)[0];
    const flaggedView = view(unsupportedFlags);
    flaggedView.setUint16(flaggedEntry.cursor + 8, flaggedView.getUint16(flaggedEntry.cursor + 8, true) | 0x8000, true);
    flaggedView.setUint16(flaggedEntry.localHeaderOffset + 6, flaggedView.getUint16(flaggedEntry.localHeaderOffset + 6, true) | 0x8000, true);
    expectRejected(unsupportedFlags, /unsupported entry flags/u, "unknown general-purpose flags must be rejected");

    const multiDisk = Uint8Array.from(base);
    view(multiDisk).setUint16(findEocd(multiDisk) + 4, 1, true);
    expectRejected(multiDisk, /Multi-disk/u, "multi-disk archives must be rejected");

    const trailingData = new Uint8Array(base.byteLength + 1);
    trailingData.set(base);
    expectRejected(trailingData, /malformed/u, "trailing data after the EOCD must be rejected");
}

async function testIntegrityAndPreviewLimit(): Promise<void> {
    const crcMismatch = archive({ "crc.txt": strToU8("integrity checked") });
    const crcEntry = entryByPath(crcMismatch, "crc.txt");
    const crcView = view(crcMismatch);
    const wrongCrc = (crcView.getUint32(crcEntry.cursor + 16, true) ^ 0xffffffff) >>> 0;
    crcView.setUint32(crcEntry.cursor + 16, wrongCrc, true);
    crcView.setUint32(crcEntry.localHeaderOffset + 14, wrongCrc, true);
    const inspectedCrc = inspectZipArchive(arrayBuffer(crcMismatch));
    await assert.rejects(
        extractZipArchiveEntry(inspectedCrc, inspectedCrc.entries[0], 1024),
        /integrity/u,
        "selected output must be checked against the central-directory CRC"
    );

    const previewLimit = archive({ "preview.bin": pseudoRandomBytes(128 * 1024) });
    const previewRef = entryByPath(previewLimit, "preview.bin");
    const declaredSize = 10 * 1024 * 1024 + 1;
    assert.ok(declaredSize <= previewRef.compressedSize * MAX_ZIP_COMPRESSION_RATIO);
    setEntryUncompressedSize(previewLimit, previewRef, declaredSize);
    const inspectedLimit = inspectZipArchive(arrayBuffer(previewLimit));
    await assert.rejects(
        extractZipArchiveEntry(inspectedLimit, inspectedLimit.entries[0], 10 * 1024 * 1024),
        /too large to preview/u,
        "selected-entry extraction must enforce its tighter preview limit before inflation"
    );
}

async function testForgedExpandedSizeCannotBeTruncated(): Promise<void> {
    const forged = archive({ "forged-bomb.txt": new Uint8Array(4 * 1024 * 1024) }, 9);
    assert.ok(forged.byteLength < 8 * 1024, "the forged fixture should remain a compact compression bomb");

    const forgedEntry = entryByPath(forged, "forged-bomb.txt");
    setEntryUncompressedSize(forged, forgedEntry, 1);
    setEntryCrc32(forged, forgedEntry, 0xd202ef8d); // CRC32 of the one-byte prefix Uint8Array.of(0).

    const inspected = inspectZipArchive(arrayBuffer(forged));
    assert.equal(inspected.entries[0].uncompressedSize, 1,
        "forged central-directory metadata should pass the pre-extraction inspection boundary");
    await assert.rejects(
        extractZipArchiveEntry(inspected, inspected.entries[0], 1024),
        /expands beyond its declared size/u,
        "actual output beyond the declared size must abort instead of being silently truncated and CRC-accepted"
    );
}

async function testNoWholeArchiveInflationRegression(): Promise<void> {
    const source = await readFile("src/equicordplugins/zipPreview/utils.ts", "utf8");
    assert.doesNotMatch(source, /\bunzipSync\b/u, "ZIP Preview must not synchronously inflate the whole archive");
    assert.match(source, /inspectZipArchive/u);
    assert.match(source, /extractZipArchiveEntry/u);
}

async function main(): Promise<void> {
    await testNormalArchiveAndLazyExtraction();
    await testOnlySelectedEntryIsInflated();
    testCompressionBombAndSizeLimits();
    testCompressionRatioBoundary();
    testEntryCountAndPaths();
    testMalformedArchives();
    await testIntegrityAndPreviewLimit();
    await testForgedExpandedSizeCannotBeTruncated();
    await testNoWholeArchiveInflationRegression();
    console.log("ZIP Preview archive security checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
