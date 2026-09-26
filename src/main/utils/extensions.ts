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

import { session } from "electron";
import { unzip, unzipSync } from "fflate";
import { constants as fsConstants } from "fs";
import { access, mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import { promisify } from "util";

import { DATA_DIR } from "./constants";
import { crxToZip } from "./crxToZip";

const extensionCacheDir = join(DATA_DIR, "ExtensionCache");
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4096;

async function extract(data: Buffer, outDir: string) {
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error("Extension archive exceeds the download size limit.");

    let entries = 0;
    let expandedBytes = 0;
    const expectedSizes = new Map<string, number>();
    unzipSync(data, { filter(file) {
        entries++;
        expandedBytes += file.originalSize;
        if (entries > MAX_ENTRIES) throw new Error("Extension archive contains too many entries.");
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("Extension archive exceeds the expanded size limit.");
        if (file.compression !== 0 && file.compression !== 8) throw new Error("Extension archive uses an unsupported compression method.");
        if (expectedSizes.has(file.name)) throw new Error("Extension archive contains duplicate entries.");

        const destination = resolve(outDir, file.name);
        if (!destination.startsWith(resolve(outDir) + sep)) throw new Error("Extension archive contains an unsafe path.");
        expectedSizes.set(file.name, file.originalSize);
        return false;
    } });

    await mkdir(outDir, { recursive: true });
    try {
        const files = await promisify(unzip)(data);
        for (const [name, content] of Object.entries(files)) {
            // Signature stuff
            // 'Cannot load extension with file or directory name
            // _metadata. Filenames starting with "_" are reserved for use by the system.';
            if (name.startsWith("_metadata/")) continue;
            if (content.length !== expectedSizes.get(name)) throw new Error("Extension entry does not match its declared size.");

            const destination = resolve(outDir, name);
            await mkdir(name.endsWith("/") ? destination : dirname(destination), { recursive: true });
            if (!name.endsWith("/")) await writeFile(destination, content);
        }
    } catch (error) {
        await rm(outDir, { recursive: true, force: true });
        throw error;
    }
}

export async function installExt(id: string) {
    const extDir = join(extensionCacheDir, `${id}`);

    try {
        await access(extDir, fsConstants.F_OK);
    } catch (err) {
        const stagedDir = `${extDir}.tmp`;
        const url = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&x=id%3D${id}%26uc&prodversion=${process.versions.chrome}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let buf: Buffer;
        let length = 0;
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "User-Agent": `Electron ${process.versions.electron} ~ LawyerCord (https://github.com/ProtonDev-sys/ProtonnCord)`
                }
            });
            reader = response.body?.getReader();
            if (!response.ok) throw new Error(`Extension download failed with status ${response.status}.`);
            if (!reader) throw new Error("Extension download has no body.");
            if (Number(response.headers.get("Content-Length")) > MAX_ARCHIVE_BYTES) throw new Error("Extension archive exceeds the download size limit.");

            buf = Buffer.allocUnsafe(MAX_ARCHIVE_BYTES);
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (length + value.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Extension archive exceeds the download size limit.");
                buf.set(value, length);
                length += value.byteLength;
            }
        } finally {
            clearTimeout(timeout);
            await reader?.cancel().catch(() => undefined);
            controller.abort();
        }

        await rm(stagedDir, { recursive: true, force: true });
        await extract(crxToZip(buf.subarray(0, length)), stagedDir);
        try {
            await rename(stagedDir, extDir);
        } catch (error) {
            await rm(stagedDir, { recursive: true, force: true });
            throw error;
        }
    }

    // Electron 36 Deprecates session.defaultSession.loadExtension()
    return session.defaultSession.extensions ? session.defaultSession.extensions.loadExtension(extDir) : session.defaultSession.loadExtension(extDir);
}
