/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";
import { Logger } from "@utils/Logger";
import { Queue } from "@utils/Queue";

const logger = new Logger("ClipUpload");

const conversions = new Queue();

function getInputName(fileName: string) {
    return `input${fileName.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? ".video"}`;
}

export function convertClipToMp4(file: File, fileName: string, signal: AbortSignal) {
    return new Promise<File>((resolve, reject) => {
        const abort = () => reject(new DOMException("Conversion canceled.", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        conversions.push(async () => {
            if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                return;
            }
            const ff = new FFmpeg();
            const terminate = () => ff.terminate();
            signal.addEventListener("abort", terminate, { once: true });
            const inputName = getInputName(file.name);
            const outputName = "output.mp4";
            try {
                await loadFFmpeg(ff);
                if (signal.aborted) return;
                logger.info("FFmpeg loaded.");
                const bytes = new Uint8Array(await file.arrayBuffer());
                if (signal.aborted) return;
                await ff.writeFile(inputName, bytes);

                const exitCode = await ff.exec([
                    "-i", inputName,
                    "-map", "0:v:0",
                    "-map", "0:a:0?",
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-profile:v", "high",
                    "-level:v", "4.0",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-movflags", "+faststart",
                    outputName
                ]);

                if (exitCode !== 0) throw new Error("Couldn't convert the selected file.");

                const data = await ff.readFile(outputName);
                if (typeof data === "string") throw new Error("Couldn't read the converted file.");

                resolve(new File([new Uint8Array(data)], fileName, { type: "video/mp4" }));
            } catch (error) {
                reject(error);
            } finally {
                signal.removeEventListener("abort", abort);
                signal.removeEventListener("abort", terminate);
                ff.terminate();
            }
        });
    });
}
