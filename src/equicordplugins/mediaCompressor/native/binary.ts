/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { access, chmod, mkdir, open, rename, rm, writeFile } from "fs/promises";
import { delimiter, isAbsolute, join } from "path";

import { run } from "./process";

const BUILD = "ffmpeg-n8.1.3-14-g330caae0c1";
const RELEASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-04-20-51";
const archives: Record<string, { url: string; hash: string; binary: string; }> = {
    "win32-x64": { url: `${RELEASE}/${BUILD}-win64-gpl-8.1.zip`, hash: "e0152c72dbc560bcf5bf8bb8ce6cb5b7ff2240379dc706240c65d5c1157dd037", binary: `${BUILD}-win64-gpl-8.1/bin/ffmpeg.exe` },
    "linux-x64": { url: `${RELEASE}/${BUILD}-linux64-gpl-8.1.tar.xz`, hash: "7e594ca6a9b11df570db21b6ba0f437d4483c94208df4bcf3660524f1a3c75da", binary: `${BUILD}-linux64-gpl-8.1/bin/ffmpeg` },
    "linux-arm64": { url: `${RELEASE}/${BUILD}-linuxarm64-gpl-8.1.tar.xz`, hash: "bdd13f73d5b64a8c0c8137a33fa54cd3b7e579c8881a25c5fc55705983fee7a4", binary: `${BUILD}-linuxarm64-gpl-8.1/bin/ffmpeg` },
    "darwin-arm64": { url: "https://www.osxexperts.net/ffmpeg9arm.zip", hash: "d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9", binary: "ffmpeg" },
    "darwin-x64": { url: "https://www.osxexperts.net/ffmpeg80intel.zip", hash: "2d24d22db78c87f394a5822867acd5c5dc5e762cd261a44bd26923f3a5af3e07", binary: "ffmpeg" }
};

async function download(url: string, destination: string, hash: string, signal: AbortSignal, status: (text: string) => void) {
    for (let redirects = 0; redirects < 5; redirects++) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !["github.com", "release-assets.githubusercontent.com", "www.osxexperts.net"].includes(parsed.hostname))
            throw new Error("The encoder download address is not allowed.");
        const response = await fetch(parsed, { redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) throw new Error("The encoder download was redirected without a destination.");
            url = new URL(location, parsed).href;
            continue;
        }
        if (!response.ok || !response.body) throw new Error("The encoder could not be downloaded.");
        const file = await open(destination, "wx", 0o600);
        const digest = createHash("sha256");
        let bytes = 0;
        const reader = response.body.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.length;
                if (bytes > 250 * 1024 * 1024) throw new Error("The encoder download is too large.");
                digest.update(value);
                await file.writeFile(value);
                status(`Downloading the native encoder once, ${Math.round(bytes / 1024 / 1024)} MB`);
            }
        } finally { await reader.cancel(); await file.close(); }
        if (digest.digest("hex") !== hash) throw new Error("The encoder download did not pass verification.");
        return;
    }
    throw new Error("The encoder download redirected too many times.");
}

export async function getBinary(signal: AbortSignal, status: (text: string) => void, system = true) {
    const root = join(DATA_DIR, "mediaCompressor", "encoders");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (system) {
        const paths = (process.env.PATH ?? "").split(delimiter);
        if (process.platform === "darwin") paths.push("/opt/homebrew/bin", "/usr/local/bin");
        if (process.platform === "win32" && process.env.LOCALAPPDATA) paths.push(join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
        for (const directory of new Set(paths.filter(isAbsolute))) {
            const path = join(directory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
            try { await access(path); } catch { continue; }
            const result = await run(path, ["-hide_banner", "-encoders"], root, signal, 5000);
            if (result.code === 0 && result.output.includes("libx264") && result.output.includes("libwebp")) return path;
        }
    }
    const arch = process.platform === "win32" && process.arch === "arm64" ? "x64" : process.arch;
    const archive = archives[`${process.platform}-${arch}`];
    if (!archive) return null;
    const destination = join(root, archive.hash);
    const binary = join(destination, archive.binary);
    try { await access(binary); return binary; } catch { status("Setting up the native encoder"); }
    const staging = join(root, randomUUID());
    await mkdir(staging, { mode: 0o700 });
    try {
        const file = join(staging, "download");
        await download(archive.url, file, archive.hash, signal, status);
        status("Verifying and unpacking the native encoder");
        const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
        if ((await run(tar, ["-xf", file, "-C", staging], root, signal, 120_000)).code !== 0) throw new Error("The encoder could not be unpacked.");
        signal.throwIfAborted();
        await chmod(join(staging, archive.binary), 0o700);
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(join(staging, archive.binary))) digest.update(chunk);
        await writeFile(join(staging, "SOURCE.txt"), `FFmpeg build source and license information: ${archive.url}\nhttps://ffmpeg.org/legal.html\nhttps://github.com/BtbN/FFmpeg-Builds\nhttps://www.osxexperts.net/\nBinary SHA256: ${digest.digest("hex")}\n`);
        await rm(file);
        await rename(staging, destination);
        return binary;
    } finally { await rm(staging, { force: true, recursive: true }); }
}
