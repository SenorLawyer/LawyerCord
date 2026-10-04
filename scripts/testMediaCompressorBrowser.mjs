/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const bundle = await build({
    stdin: { contents: 'export {compress} from "./src/equicordplugins/mediaCompressor/compress"; export {loadFFmpeg} from "./src/utils/ffmpeg"; export {FFmpeg} from "@ffmpeg/ffmpeg";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "browser", format: "iife", globalName: "MediaTest", write: false
});
const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle.outputFiles[0].contents : '<script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
let browser;
try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(async () => {
        const canvas = new OffscreenCanvas(512, 512);
        const context = canvas.getContext("2d");
        const pixels = context.createImageData(512, 512);
        let seed = 12345;
        for (let i = 0; i < pixels.data.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
        }
        context.putImageData(pixels, 0, 0);
        const image = new File([await canvas.convertToBlob({ type: "image/png" })], "image.png", { type: "image/png" });
        const compressedImage = await MediaTest.compress(image, 60000, new AbortController().signal, () => {});
        const bitmap = await createImageBitmap(compressedImage);
        const imageWidth = bitmap.width;
        bitmap.close();

        const ff = new MediaTest.FFmpeg();
        let video;
        let animated;
        let rotated;
        try {
            await MediaTest.loadFFmpeg(ff);
            if (await ff.exec(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-crf", "8", "-threads", "1", "-c:a", "aac", "source.mp4"])) throw Error("Could not create the video fixture.");
            video = new File([await ff.readFile("source.mp4")], "video.mp4", { type: "video/mp4" });
            if (await ff.exec(["-i", "source.mp4", "-c", "copy", "-metadata:s:v:0", "rotate=90", "rotated.mp4"])) throw Error("Could not create the rotated fixture.");
            rotated = new File([await ff.readFile("rotated.mp4")], "rotated.mp4", { type: "video/mp4" });
            if (await ff.exec(["-i", "source.mp4", "-t", "0.2", "-plays", "0", "-f", "apng", "animated.png"])) throw Error("Could not create the animation fixture.");
            animated = new File([await ff.readFile("animated.png")], "animated.png", { type: "image/png" });
        } finally { ff.terminate(); }
        const compressedVideo = await MediaTest.compress(video, 50000, new AbortController().signal, () => {});
        const element = document.createElement("video");
        const url = URL.createObjectURL(compressedVideo);
        element.src = url;
        await new Promise((resolve, reject) => { element.onloadedmetadata = resolve; element.onerror = reject; });
        const duration = element.duration;
        URL.revokeObjectURL(url);
        const portrait = await MediaTest.compress(rotated, 50000, new AbortController().signal, () => {});
        const portraitUrl = URL.createObjectURL(portrait);
        element.src = portraitUrl;
        await new Promise((resolve, reject) => { element.onloadedmetadata = resolve; element.onerror = reject; });
        const portraitDimensions = [element.videoWidth, element.videoHeight];
        URL.revokeObjectURL(portraitUrl);
        let hasAudio = false;
        const probe = new MediaTest.FFmpeg();
        try {
            await MediaTest.loadFFmpeg(probe);
            probe.on("log", ({ message }) => { if (message.includes("Audio: aac")) hasAudio = true; });
            await probe.writeFile("output.mp4", new Uint8Array(await compressedVideo.arrayBuffer()));
            await probe.exec(["-i", "output.mp4"]);
        } finally { probe.terminate(); }
        let animationRejected = false;
        try { await MediaTest.compress(animated, 1000, new AbortController().signal, () => {}); }
        catch (error) { animationRejected = error.message.includes("animated image"); }
        const controller = new AbortController();
        let cancelled = false;
        try {
            await MediaTest.compress(video, 50000, controller.signal, status => { if (status.startsWith("Analyzing video,")) controller.abort(); });
        } catch { cancelled = controller.signal.aborted; }
        return { image: [image.size, compressedImage.size, imageWidth], video: [video.size, compressedVideo.size, duration], portraitDimensions, hasAudio, animationRejected, cancelled };
    });
    assert.ok(result.image[0] > 60000 && result.image[1] <= 60000 && result.image[2] > 0);
    assert.ok(result.video[0] > 50000 && result.video[1] <= 50000 && result.video[2] >= 3 && result.video[2] < 3.1);
    assert.equal(result.hasAudio, true);
    assert.equal(result.animationRejected, true);
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.portraitDimensions, [180, 320]);
    console.log("Real browser compression, decode, audio preservation, animation rejection and cancellation passed.", result);
} finally {
    await browser?.close();
    server.close();
}
