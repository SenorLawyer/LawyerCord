/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import { decompressFrame, parseGIF } from "gifuct-js";

import { CAPTIONS } from "../captions";
import { measureTextLines } from "../captions/caption";
import type { GifMakerOptions } from "../types";
import { encodeGif } from "./encode";
import { MAX_MEDIA_BYTES, MAX_TOTAL_PIXELS, MEDIA_TIMEOUT, readMediaResponse, validateDimensions } from "./limits";

const MAX_FRAMES = 200;
const INTERNAL_FPS = 30;

const ALLOWED_MEDIA_HOSTS = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net",
    "media.tenor.com",
    "tenor.com",
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
]);

const MediaNative = VencordNative?.pluginHelpers?.GifMaker as PluginNative<typeof import("../native")> | undefined;

const blobUrlMap = new WeakMap<HTMLElement, string>();

function isDiscordCdnUrl(url: string): boolean {
    try {
        return ALLOWED_MEDIA_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

async function getMediaBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    if (MediaNative) {
        const id = signal ? crypto.randomUUID() : undefined;
        const abort = () => { void MediaNative.cancelMedia(id); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const result = await MediaNative.fetchMedia(url, id);
            signal?.throwIfAborted();
            if (result.error !== undefined) throw new Error(result.error);
            if (result.data.byteLength > MAX_MEDIA_BYTES) throw new Error("Media must be smaller than 50 MB.");
            return new Blob([result.data], { type: result.type });
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, MEDIA_TIMEOUT);
    try {
        return await readMediaResponse(await fetch(url, { signal: controller.signal }), controller.signal);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

const mediaProxyParser = /^https:\/\/(?:images-ext-\d+|cdn)\.discord(?:app|cdn)\.net\/external\/[^/]+\/(?<protocol>https?)\/(?<rest>.+)$/i;

function resolveMediaUrl(url: string): string {
    const normalized = url.startsWith("//") ? `https:${url}` : url;
    const match = normalized.match(mediaProxyParser);
    if (match?.groups) {
        const { protocol, rest } = match.groups;
        return `${decodeURIComponent(protocol)}://${decodeURIComponent(rest)}`;
    }
    return normalized;
}

export function cleanupBlobUrl(el: HTMLImageElement | HTMLVideoElement) {
    if ("pause" in el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
    } else {
        el.removeAttribute("src");
    }
    const blobUrl = blobUrlMap.get(el);
    if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrlMap.delete(el);
    }
}

export async function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    signal?.throwIfAborted();
    const resolved = resolveMediaUrl(url);
    const blob = isDiscordCdnUrl(resolved) ? await getMediaBlob(resolved, signal) : null;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const img = new Image();
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            img.onload = img.onerror = null;
        };
        const fail = (error: unknown) => {
            cleanup();
            cleanupBlobUrl(img);
            reject(error);
        };
        const abort = () => fail(signal?.reason);
        const timeout = setTimeout(() => fail(new Error("The image took too long to load.")), MEDIA_TIMEOUT);
        signal?.addEventListener("abort", abort, { once: true });
        img.onload = () => {
            try {
                validateDimensions(img.naturalWidth, img.naturalHeight);
                cleanup();
                resolve(img);
            } catch (error) {
                fail(error);
            }
        };
        img.onerror = () => fail(new Error("Could not load the image."));
        img.crossOrigin = "anonymous";
        if (blob) {
            const blobUrl = URL.createObjectURL(blob);
            blobUrlMap.set(img, blobUrl);
            img.src = blobUrl;
        } else img.src = resolved;
    });
}

export async function loadVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
    signal?.throwIfAborted();
    const resolved = resolveMediaUrl(url);
    const blob = isDiscordCdnUrl(resolved) ? await getMediaBlob(resolved, signal) : null;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            video.removeEventListener("loadedmetadata", loaded);
            video.removeEventListener("error", failed);
        };
        const fail = (error: unknown) => {
            cleanup();
            cleanupBlobUrl(video);
            reject(error);
        };
        const abort = () => fail(signal?.reason);
        const failed = () => fail(new Error("Could not load the video."));
        const loaded = () => {
            try {
                validateDimensions(video.videoWidth, video.videoHeight);
                if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("The video has an invalid duration.");
                cleanup();
                resolve(video);
            } catch (error) {
                fail(error);
            }
        };
        const timeout = setTimeout(() => fail(new Error("The video took too long to load.")), MEDIA_TIMEOUT);
        signal?.addEventListener("abort", abort, { once: true });
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.preload = "auto";
        video.muted = true;
        video.crossOrigin = "anonymous";
        if (blob) {
            const blobUrl = URL.createObjectURL(blob);
            blobUrlMap.set(video, blobUrl);
            video.src = blobUrl;
        } else video.src = resolved;
        video.load();
    });
}

function waitForSeek(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!video.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            video.removeEventListener("seeked", seeked);
            video.removeEventListener("error", failed);
        };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const failed = () => { cleanup(); reject(new Error("Could not seek the video.")); };
        const seeked = () => { cleanup(); resolve(); };
        const timeout = setTimeout(failed, MEDIA_TIMEOUT);
        signal?.addEventListener("abort", abort, { once: true });
        video.addEventListener("seeked", seeked);
        video.addEventListener("error", failed);
    });
}

export function getCaptionHeight(ctx: CanvasRenderingContext2D, width: number, options: GifMakerOptions): number {
    if (options.captionMode === "caption" && options.captionText) {
        const { lines, lineHeight } = measureTextLines(ctx, options.captionText, options.captionSize, options.fontFamily, width - 20);
        return Math.ceil(lines.length * lineHeight + 20);
    }
    return 0;
}

async function encodeFrames(
    width: number,
    height: number,
    options: GifMakerOptions,
    frameCount: number,
    drawFrame: (ctx: CanvasRenderingContext2D, i: number) => void | Promise<void>,
    delays?: number[],
    signal?: AbortSignal,
): Promise<Blob> {
    signal?.throwIfAborted();
    validateDimensions(width, height);
    if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES)
        throw new Error("GIFs must contain between 1 and 200 frames.");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return new Blob();
    const captionHeight = getCaptionHeight(ctx, width, options);
    const gifHeight = height + captionHeight;
    validateDimensions(width, gifHeight);
    if (width * gifHeight * frameCount > MAX_TOTAL_PIXELS)
        throw new Error("This GIF is too large to process. Choose smaller dimensions.");
    canvas.width = width;
    canvas.height = gifHeight;

    const defaultDelay = Math.round(1000 / INTERNAL_FPS);

    const frameLength = canvas.width * canvas.height * 4;
    const combined = new Uint8ClampedArray(frameLength * frameCount);
    for (let i = 0; i < frameCount; i++) {
        signal?.throwIfAborted();
        ctx.clearRect(0, 0, width, gifHeight);

        ctx.save();
        ctx.translate(0, captionHeight);
        await drawFrame(ctx, i);
        ctx.restore();
        signal?.throwIfAborted();

        const caption = CAPTIONS.find(c => c.type === options.captionMode);
        if (caption) {
            ctx.save();
            caption.render(ctx, width, captionHeight > 0 ? captionHeight : height, options);
            ctx.restore();
        }

        combined.set(ctx.getImageData(0, 0, width, gifHeight).data, i * frameLength);
        if (i % 4 === 3) await sleep(0);
    }

    await sleep(0);
    signal?.throwIfAborted();
    return encodeGif(combined, width, gifHeight, delays ?? new Array(frameCount).fill(defaultDelay), signal);
}

async function createGifFromImage(url: string, options: GifMakerOptions, signal?: AbortSignal): Promise<Blob> {
    const img = await loadImage(url, signal);
    try {
        return await encodeFrames(options.width, options.height, options, 1, ctx => {
            ctx.drawImage(img, 0, 0, options.width, options.height);
        }, undefined, signal);
    } finally {
        cleanupBlobUrl(img);
    }
}

async function createGifFromVideo(url: string, options: GifMakerOptions, signal?: AbortSignal): Promise<Blob> {
    const video = await loadVideo(url, signal);
    try {
        const { duration } = video;
        const frameCount = Math.min(
            Math.max(1, Math.floor(duration * INTERNAL_FPS)),
            MAX_FRAMES
        );

        const interval = duration / frameCount;
        const delay = Math.round(interval * 1000);
        const delays = new Array(frameCount).fill(delay);

        return await encodeFrames(options.width, options.height, options, frameCount, async (ctx, i) => {
            video.currentTime = i * interval;
            await waitForSeek(video, signal);
            ctx.drawImage(video, 0, 0, options.width, options.height);
        }, delays, signal);
    } finally {
        cleanupBlobUrl(video);
    }
}

function hasExt(url: string, ext: string): boolean {
    try {
        const normalized = url.startsWith("//") ? `https:${url}` : url;
        const match = normalized.match(mediaProxyParser);
        const resolved = match?.groups
            ? `${decodeURIComponent(match.groups.protocol)}://${decodeURIComponent(match.groups.rest)}`
            : normalized;
        return new URL(resolved).pathname.toLowerCase().endsWith(ext);
    } catch {
        return url.toLowerCase().endsWith(ext);
    }
}

export async function createGif(url: string, isVideo: boolean, options: GifMakerOptions, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    validateDimensions(options.width, options.height);
    if (isVideo) return createGifFromVideo(url, options, signal);
    if (hasExt(url, ".gif")) {
        try {
            return await createGifFromAnimatedImage(url, options, signal);
        } catch (err) {
            if (!(err instanceof Error) || err.message !== "No animated frames found") {
                throw err;
            }
        }
    }
    return createGifFromImage(url, options, signal);
}

async function createGifFromAnimatedImage(url: string, options: GifMakerOptions, signal?: AbortSignal): Promise<Blob> {
    const blob = await getMediaBlob(resolveMediaUrl(url), signal);
    const bytes = await blob.arrayBuffer();
    signal?.throwIfAborted();
    const parsedGif = parseGIF(bytes);
    validateDimensions(parsedGif.lsd.width, parsedGif.lsd.height);
    const frames = parsedGif.frames.filter(frame => "image" in frame);
    if (frames.length > MAX_FRAMES) throw new Error("GIFs must contain at most 200 frames.");
    let sourcePixels = 0;
    for (const frame of frames) {
        const { width, height, left, top } = frame.image.descriptor;
        validateDimensions(width, height);
        sourcePixels += width * height;
        if (sourcePixels > MAX_TOTAL_PIXELS) throw new Error("This GIF contains too many source pixels to process.");
        if (left + width > parsedGif.lsd.width || top + height > parsedGif.lsd.height)
            throw new Error("The GIF contains an invalid frame rectangle.");
    }

    if (frames.length <= 1) throw new Error("No animated frames found");

    const gifW = parsedGif.lsd.width;
    const gifH = parsedGif.lsd.height;

    const composite = document.createElement("canvas");
    composite.width = gifW;
    composite.height = gifH;
    const ctx = composite.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Failed to get canvas context for GIF compositing.");

    const patchCanvas = document.createElement("canvas");

    const totalFrames = frames.length;
    const snapshot = document.createElement("canvas");
    snapshot.width = gifW;
    snapshot.height = gifH;
    const snapshotCtx = snapshot.getContext("2d");
    if (!snapshotCtx) throw new Error("Failed to get canvas context for frame snapshot.");

    return await encodeFrames(options.width, options.height, options, totalFrames, async (encodeCtx, i) => {
        signal?.throwIfAborted();
        const frame = decompressFrame(frames[i], parsedGif.gct, true);

        if (i > 0) {
            const prev = frames[i - 1];
            const dims = prev.image.descriptor;
            if (prev.gce?.extras.disposal === 2) {
                ctx.clearRect(dims.left, dims.top, dims.width, dims.height);
            } else if (prev.gce?.extras.disposal === 3) {
                ctx.clearRect(0, 0, gifW, gifH);
                ctx.drawImage(snapshot, 0, 0);
            }
        }

        if (frames[i].gce?.extras.disposal === 3) {
            snapshotCtx.clearRect(0, 0, gifW, gifH);
            snapshotCtx.drawImage(composite, 0, 0);
        }

        const patchData = new ImageData(
            new Uint8ClampedArray(frame.patch),
            frame.dims.width,
            frame.dims.height
        );
        patchCanvas.width = frame.dims.width;
        patchCanvas.height = frame.dims.height;
        const patchCtx = patchCanvas.getContext("2d");
        if (!patchCtx) throw new Error("Failed to get canvas context for patch rendering.");
        patchCtx.putImageData(patchData, 0, 0);
        ctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);

        encodeCtx.drawImage(composite, 0, 0, options.width, options.height);

        if (i % 20 === 19) {
            await sleep(0);
        }
    }, frames.map(frame => frame.gce ? (frame.gce.delay || 10) * 10 : 0), signal);
}
