/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AsyncInflate } from "fflate";

export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 1000;
export const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_COMPRESSION_RATIO = 100;
export const MAX_ZIP_PATH_BYTES = 1024;
export const MAX_ZIP_PATH_DEPTH = 16;
export const MAX_ZIP_SEGMENT_BYTES = 255;

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const MAX_EXTRACTION_TIME_MS = 15_000;
// AsyncInflate reports output after each compressed push, so small pushes bound work before termination.
const MAX_DEFLATE_INPUT_CHUNK_BYTES = 4 * 1024;
const MIN_RATIO_CHECK_BYTES = 1024 * 1024;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UNSAFE_FLAGS = 0x0001 | 0x0020 | 0x0040 | 0x2000;
const SUPPORTED_FLAGS = 0x0002 | 0x0004 | DATA_DESCRIPTOR_FLAG | UTF8_FLAG;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    return value >>> 0;
});

export interface InspectedZipEntry {
    path: string;
    compressedSize: number;
    uncompressedSize: number;
    compression: 0 | 8;
    crc32: number;
    dataOffset: number;
}

export interface InspectedZipArchive {
    data: Uint8Array<ArrayBuffer>;
    entries: InspectedZipEntry[];
}

interface EntryRange {
    end: number;
    start: number;
}

export function inspectZipArchive(buffer: ArrayBuffer): InspectedZipArchive {
    if (buffer.byteLength > MAX_ZIP_BYTES) throw new Error("ZIP is too large to preview.");

    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const eocdOffset = findEndOfCentralDirectory(view);
    const diskNumber = readUint16(view, eocdOffset + 4);
    const centralDirectoryDisk = readUint16(view, eocdOffset + 6);
    const diskEntries = readUint16(view, eocdOffset + 8);
    const entryCount = readUint16(view, eocdOffset + 10);
    const centralDirectorySize = readUint32(view, eocdOffset + 12);
    const centralDirectoryOffset = readUint32(view, eocdOffset + 16);
    const commentLength = readUint16(view, eocdOffset + 20);

    if (eocdOffset + 22 + commentLength !== data.byteLength) throw invalidArchive();
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== entryCount) {
        throw new Error("Multi-disk ZIP files cannot be previewed.");
    }
    if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
        throw new Error("ZIP64 files cannot be previewed.");
    }
    if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`ZIP contains more than ${MAX_ZIP_ENTRIES} entries.`);

    const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
    if (centralDirectoryEnd !== eocdOffset || centralDirectoryEnd > data.byteLength) throw invalidArchive();
    if (hasZip64Structures(view, eocdOffset)) throw new Error("ZIP64 files cannot be previewed.");

    const entries: InspectedZipEntry[] = [];
    const paths = new Set<string>();
    const ranges: EntryRange[] = [];
    let cursor = centralDirectoryOffset;
    let totalUncompressedSize = 0;

    for (let index = 0; index < entryCount; index++) {
        if (cursor + 46 > centralDirectoryEnd || readUint32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
            throw invalidArchive();
        }

        const flags = readUint16(view, cursor + 8);
        const compression = readUint16(view, cursor + 10);
        const crc32 = readUint32(view, cursor + 16);
        const compressedSize = readUint32(view, cursor + 20);
        const uncompressedSize = readUint32(view, cursor + 24);
        const fileNameLength = readUint16(view, cursor + 28);
        const extraLength = readUint16(view, cursor + 30);
        const fileCommentLength = readUint16(view, cursor + 32);
        const startingDisk = readUint16(view, cursor + 34);
        const localHeaderOffset = readUint32(view, cursor + 42);
        const nextEntry = cursor + 46 + fileNameLength + extraLength + fileCommentLength;

        if (nextEntry > centralDirectoryEnd || fileNameLength === 0 || fileNameLength > MAX_ZIP_PATH_BYTES) {
            throw invalidArchive();
        }
        if (startingDisk !== 0) throw new Error("Multi-disk ZIP files cannot be previewed.");
        if (flags & UNSAFE_FLAGS) throw new Error("Encrypted or patched ZIP entries cannot be previewed.");
        if (flags & ~SUPPORTED_FLAGS) throw new Error("ZIP uses unsupported entry flags.");
        if (compression !== 0 && compression !== 8) throw new Error("ZIP uses an unsupported compression method.");
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error("ZIP64 files cannot be previewed.");
        }
        if (compression === 0 && compressedSize !== uncompressedSize) throw invalidArchive();
        if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
            throw new Error("A ZIP entry is too large to preview safely.");
        }
        if (
            uncompressedSize >= MIN_RATIO_CHECK_BYTES
            && (compressedSize === 0 || uncompressedSize > compressedSize * MAX_ZIP_COMPRESSION_RATIO)
        ) {
            throw new Error("ZIP compression ratio is too high to preview safely.");
        }

        totalUncompressedSize += uncompressedSize;
        if (totalUncompressedSize > MAX_ZIP_TOTAL_BYTES) {
            throw new Error("ZIP expands beyond the preview size limit.");
        }

        const fileNameBytes = data.subarray(cursor + 46, cursor + 46 + fileNameLength);
        const rawPath = decodeFileName(fileNameBytes, Boolean(flags & UTF8_FLAG));
        const { isDirectory, path } = validateEntryPath(rawPath, fileNameLength);
        if (paths.has(path)) throw new Error("ZIP contains duplicate entry paths.");
        paths.add(path);

        const dataOffset = validateLocalHeader({
            centralDirectoryOffset,
            compressedSize,
            compression,
            crc32,
            data,
            fileNameBytes,
            flags,
            localHeaderOffset,
            uncompressedSize,
            view,
        });
        ranges.push({ start: localHeaderOffset, end: dataOffset + compressedSize });

        if (isDirectory) {
            if (compressedSize !== 0 || uncompressedSize !== 0) throw invalidArchive();
        } else {
            entries.push({
                path,
                compressedSize,
                uncompressedSize,
                compression,
                crc32,
                dataOffset,
            });
        }

        cursor = nextEntry;
    }

    if (cursor !== centralDirectoryEnd) throw invalidArchive();
    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++) {
        if (ranges[index].start < ranges[index - 1].end) throw new Error("ZIP entries overlap.");
    }

    return { data, entries };
}

function hasZip64Structures(view: DataView, centralDirectoryOffset: number): boolean {
    if (centralDirectoryOffset >= 56 && readUint32(view, centralDirectoryOffset - 56) === 0x06064b50) return true;
    return centralDirectoryOffset >= 20 && readUint32(view, centralDirectoryOffset - 20) === 0x07064b50;
}

export async function extractZipArchiveEntry(
    archive: InspectedZipArchive,
    entry: InspectedZipEntry,
    maxOutputBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
    if (!archive.entries.includes(entry)) throw new Error("ZIP entry is no longer available.");
    if (entry.uncompressedSize > maxOutputBytes) throw new Error("ZIP entry is too large to preview.");

    const compressed = archive.data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const output = entry.compression === 0
        ? await copyStoredEntry(compressed)
        : await inflateEntry(compressed, entry.uncompressedSize);

    if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
        throw new Error("ZIP entry failed its integrity check.");
    }
    return output;
}

async function copyStoredEntry(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    await Promise.resolve();
    return data.slice();
}

function findEndOfCentralDirectory(view: DataView): number {
    const minimumOffset = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
    for (let offset = view.byteLength - 22; offset >= minimumOffset; offset--) {
        if (
            readUint32(view, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE
            && offset + 22 + readUint16(view, offset + 20) === view.byteLength
        ) return offset;
    }
    throw invalidArchive();
}

function validateLocalHeader({
    centralDirectoryOffset,
    compressedSize,
    compression,
    crc32,
    data,
    fileNameBytes,
    flags,
    localHeaderOffset,
    uncompressedSize,
    view,
}: {
    centralDirectoryOffset: number;
    compressedSize: number;
    compression: number;
    crc32: number;
    data: Uint8Array;
    fileNameBytes: Uint8Array;
    flags: number;
    localHeaderOffset: number;
    uncompressedSize: number;
    view: DataView;
}): number {
    if (localHeaderOffset + 30 > centralDirectoryOffset) throw invalidArchive();
    if (readUint32(view, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) throw invalidArchive();

    const localFlags = readUint16(view, localHeaderOffset + 6);
    const localCompression = readUint16(view, localHeaderOffset + 8);
    const localCrc32 = readUint32(view, localHeaderOffset + 14);
    const localCompressedSize = readUint32(view, localHeaderOffset + 18);
    const localUncompressedSize = readUint32(view, localHeaderOffset + 22);
    const localFileNameLength = readUint16(view, localHeaderOffset + 26);
    const localExtraLength = readUint16(view, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;

    if (localFlags !== flags || localCompression !== compression || localFileNameLength !== fileNameBytes.byteLength) {
        throw invalidArchive();
    }
    if (dataOffset + compressedSize > centralDirectoryOffset) throw invalidArchive();
    for (let index = 0; index < fileNameBytes.byteLength; index++) {
        if (data[localHeaderOffset + 30 + index] !== fileNameBytes[index]) throw invalidArchive();
    }

    if (flags & DATA_DESCRIPTOR_FLAG) {
        if (localCrc32 !== 0 && localCrc32 !== crc32) throw invalidArchive();
        if (localCompressedSize !== 0 && localCompressedSize !== compressedSize) throw invalidArchive();
        if (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize) throw invalidArchive();
    } else if (
        localCrc32 !== crc32
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize
    ) {
        throw invalidArchive();
    }

    return dataOffset;
}

function validateEntryPath(rawPath: string, pathBytes: number): { isDirectory: boolean; path: string; } {
    if (/^[\\/]/u.test(rawPath) || rawPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(rawPath)) {
        throw new Error("ZIP contains an unsafe entry path.");
    }

    const isDirectory = rawPath.endsWith("/");
    const path = isDirectory ? rawPath.slice(0, -1) : rawPath;
    const segments = path.split("/");
    if (
        pathBytes > MAX_ZIP_PATH_BYTES
        || segments.length > MAX_ZIP_PATH_DEPTH
        || segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
        || /^[a-z]:/iu.test(segments[0])
        || segments.some(segment => new TextEncoder().encode(segment).byteLength > MAX_ZIP_SEGMENT_BYTES)
    ) {
        throw new Error("ZIP contains an unsafe entry path.");
    }

    return { isDirectory, path };
}

function decodeFileName(bytes: Uint8Array, utf8: boolean): string {
    if (!utf8) return Array.from(bytes, byte => String.fromCharCode(byte)).join("");
    try {
        return textDecoder.decode(bytes);
    } catch {
        throw new Error("ZIP contains an invalid UTF-8 entry path.");
    }
}

function inflateEntry(data: Uint8Array, size: number): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        const result = new Uint8Array(size);
        let inflater: AsyncInflate | undefined;
        let inputOffset = 0;
        let outputBytes = 0;
        let settled = false;

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            inflater?.terminate();
            reject(error);
        };

        const timeout = setTimeout(() => {
            fail(new Error("ZIP entry took too long to decompress."));
        }, MAX_EXTRACTION_TIME_MS);

        const pushNextChunk = () => {
            if (settled || !inflater) return;

            const nextOffset = Math.min(inputOffset + MAX_DEFLATE_INPUT_CHUNK_BYTES, data.byteLength);
            const isFinal = nextOffset === data.byteLength;
            const chunk = data.slice(inputOffset, nextOffset);
            inputOffset = nextOffset;
            inflater.push(chunk, isFinal);
        };

        try {
            inflater = new AsyncInflate((error, output, final) => {
                if (settled) return;
                if (error) {
                    fail(new Error("ZIP entry could not be decompressed."));
                    return;
                }

                const nextOutputBytes = outputBytes + output.byteLength;
                if (nextOutputBytes > size) {
                    fail(new Error("ZIP entry expands beyond its declared size."));
                    return;
                }
                result.set(output, outputBytes);
                outputBytes = nextOutputBytes;

                if (!final) return;
                if (outputBytes !== size) {
                    fail(new Error("ZIP entry could not be decompressed."));
                    return;
                }

                settled = true;
                clearTimeout(timeout);
                resolve(result);
            });
            inflater.ondrain = pushNextChunk;
            pushNextChunk();
        } catch {
            fail(new Error("ZIP entry could not be decompressed."));
        }
    });
}

function crc32(data: Uint8Array): number {
    let value = 0xffffffff;
    for (const byte of data) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function readUint16(view: DataView, offset: number): number {
    if (offset < 0 || offset + 2 > view.byteLength) throw invalidArchive();
    return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
    if (offset < 0 || offset + 4 > view.byteLength) throw invalidArchive();
    return view.getUint32(offset, true);
}

function invalidArchive(): Error {
    return new Error("ZIP archive is malformed.");
}
