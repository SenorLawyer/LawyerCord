/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ColorUtils, React, showToast, Toasts } from "@webpack/common";

const logger = new Logger("BetterAudioPlayer");
const cl = classNameFactory("vc-better-audio-player-");
const MAX_FILE_SIZE = 12e6;
const MAX_AUDIO_BLOB_CACHE_SIZE = 12;
const MAX_COLOR_CACHE_SIZE = 16;

const audioBlobCache = new Map<string, Blob>();
const audioDownloads = new Map<string, { controller: AbortController; promise: Promise<Blob | null>; consumers: number; }>();
let audioCacheBytes = 0;
const colorCache = new Map<string, readonly [number, number, number]>();

interface PlayerInstance {
    mediaRef: React.RefObject<HTMLAudioElement>;
    props: { src: string; type: string; };
}

function validateColor(value: string, key: string, fallback: string) {
    if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(value)) return;

    try {
        const rgb = ColorUtils.hexToRgb(value.replace("#", ""));
        if (rgb) {
            settings.store[key] = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
            return;
        }
    } catch { /* invalid hex */ }

    showToast(`Invalid color format for ${key}, use "R, G, B" or "#RRGGBB"`, Toasts.Type.FAILURE);
    settings.store[key] = fallback;
}

function getRgbColor(value: string): readonly [number, number, number] {
    const cachedColor = colorCache.get(value);
    if (cachedColor) return cachedColor;

    const firstSeparator = value.indexOf(",");
    const secondSeparator = value.indexOf(",", firstSeparator + 1);
    const r = Number(value.slice(0, firstSeparator));
    const g = Number(value.slice(firstSeparator + 1, secondSeparator));
    const b = Number(value.slice(secondSeparator + 1));
    const color = [r, g, b] as const;
    colorCache.set(value, color);

    if (colorCache.size > MAX_COLOR_CACHE_SIZE) {
        const oldestKey = colorCache.keys().next().value;
        if (oldestKey) colorCache.delete(oldestKey);
    }

    return color;
}

function maxTypedArray(arr: Uint8Array<ArrayBufferLike>): number {
    let max = 0;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] > max) max = arr[i];
    }
    return max;
}

function drawOscilloscope(ctx: CanvasRenderingContext2D, w: number, h: number, dataArray: Uint8Array<ArrayBufferLike>, bufferLength: number) {
    const sliceWidth = w / bufferLength;
    const [r, g, b] = getRgbColor(settings.store.oscilloscopeColor);
    const solidColor = settings.store.oscilloscopeSolidColor;
    const amp = 3;
    let x = 0;

    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < bufferLength; i++) {
        const v = (dataArray[i] - 128) / 128;
        const y = (h / 2) - (v * amp * h / 2);

        if (solidColor) {
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        } else {
            const absV = Math.abs(v);
            ctx.strokeStyle = `rgb(${Math.min(r + absV * 100 + (i / bufferLength) * 155, 255)}, ${Math.min(g + absV * 50 + (i / bufferLength) * 155, 255)}, ${Math.min(b + absV * 150 + (i / bufferLength) * 155, 255)})`;
        }

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
}

function drawSpectrograph(ctx: CanvasRenderingContext2D, w: number, h: number, frequencyData: Uint8Array<ArrayBufferLike>, bufferLength: number) {
    const barWidth = w / bufferLength;
    const maxVal = maxTypedArray(frequencyData);
    if (maxVal === 0) return;

    const [r, g, b] = getRgbColor(settings.store.spectrographColor);
    const solidColor = settings.store.spectrographSolidColor;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const barH = (frequencyData[i] / maxVal) * h;

        if (solidColor) {
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        } else {
            const red = Math.min(r + (i / bufferLength) * 155, 255);
            const green = Math.min(g + (i / bufferLength) * 155, 255);
            const blue = Math.min(b + (i / bufferLength) * 155, 255);
            const gradient = ctx.createLinearGradient(x, h - barH, x, h);
            gradient.addColorStop(0, `rgb(${red}, ${green}, ${blue})`);
            gradient.addColorStop(1, `rgb(${Math.max(red - 50, 0)}, ${Math.max(green - 50, 0)}, ${Math.max(blue - 50, 0)})`);
            ctx.fillStyle = gradient;
        }

        ctx.fillRect(x, h - barH, barWidth, barH);
        x += barWidth + 0.5;
    }
}

async function fetchAudioBlobData(src: string, signal: AbortSignal): Promise<Blob | null> {
    const response = await fetch(src, { signal });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_FILE_SIZE) {
        await response.body?.cancel();
        return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        if (signal.aborted) throw new DOMException("Audio download canceled.", "AbortError");
        while (true) {
            const { done, value } = await reader.read();
            if (signal.aborted) throw new DOMException("Audio download canceled.", "AbortError");
            if (done) break;
            size += value.byteLength;
            if (size > MAX_FILE_SIZE) return null;
            chunks.push(new Uint8Array(value));
        }
        return new Blob(chunks, { type: response.headers.get("content-type") || "audio/mpeg" });
    } finally {
        signal.removeEventListener("abort", abort);
        try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
}

function getAudioBlob(src: string, signal: AbortSignal): Promise<Blob | null> {
    if (signal.aborted) return Promise.resolve(null);
    const cachedBlob = audioBlobCache.get(src);
    if (cachedBlob) return Promise.resolve(cachedBlob);
    let download = audioDownloads.get(src);
    if (download?.controller.signal.aborted) return Promise.resolve(null);
    if (!download) {
        if (audioDownloads.size >= 4) {
            logger.warn("Too many audio visualizers are loading. Play the audio again to retry.");
            return Promise.resolve(null);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const promise = fetchAudioBlobData(src, controller.signal).then(blob => {
            if (!blob || controller.signal.aborted) return null;
            audioBlobCache.set(src, blob);
            audioCacheBytes += blob.size;
            while (audioBlobCache.size > MAX_AUDIO_BLOB_CACHE_SIZE || audioCacheBytes > 2 * MAX_FILE_SIZE) {
                const oldest = audioBlobCache.entries().next();
                if (oldest.done) break;
                audioCacheBytes -= oldest.value[1].size;
                audioBlobCache.delete(oldest.value[0]);
            }
            return blob;
        }).catch(error => {
            if (!controller.signal.aborted) logger.error("Could not load audio for the visualizer.", error);
            return null;
        }).finally(() => {
            clearTimeout(timeout);
            if (audioDownloads.get(src)?.controller === controller) audioDownloads.delete(src);
        });
        download = { controller, promise, consumers: 0 };
        audioDownloads.set(src, download);
    }
    const entry = download;
    entry.consumers++;
    return new Promise(resolve => {
        let finished = false;
        const finish = (blob: Blob | null) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            if (--entry.consumers === 0 && audioDownloads.get(src) === entry) {
                entry.controller.abort();
            }
            resolve(blob);
        };
        const abort = () => finish(null);
        signal.addEventListener("abort", abort, { once: true });
        void entry.promise.then(finish);
    });
}

function Visualizer({ playerRef, src }: { playerRef: React.RefObject<HTMLAudioElement>; src: string; }) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const audioCtxRef = React.useRef<AudioContext | null>(null);
    const analyserRef = React.useRef<AnalyserNode | null>(null);
    const animFrameRef = React.useRef(0);
    const setupDoneRef = React.useRef(false);
    const blobUrlRef = React.useRef<string | null>(null);
    const canvasSizeRef = React.useRef({ width: 0, height: 0 });

    React.useEffect(() => {
        const audio = playerRef.current;
        const canvas = canvasRef.current;
        if (!audio || !canvas) return () => { };

        let cancelled = false;
        const controller = new AbortController();
        let initializing = false;

        const init = async () => {
            const blob = await getAudioBlob(src, controller.signal);
            if (cancelled || !blob) return;

            const blobUrl = URL.createObjectURL(blob);
            blobUrlRef.current = blobUrl;

            const wasPlaying = !audio.paused;
            const { currentTime } = audio;
            audio.src = blobUrl;
            audio.currentTime = currentTime;

            const audioCtx = new AudioContext();
            audioCtxRef.current = audioCtx;
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            const source = audioCtx.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);
            analyserRef.current = analyser;
            setupDoneRef.current = true;

            if (wasPlaying) {
                audio.play().catch(() => { });
            }
        };

        const canvasCtx = canvas.getContext("2d");
        let dataArray: Uint8Array<ArrayBuffer> | null = null;
        let frequencyData: Uint8Array<ArrayBuffer> | null = null;

        const requestDraw = () => {
            if (animFrameRef.current !== 0 || audio.paused) return;

            animFrameRef.current = requestAnimationFrame(draw);
        };

        const draw = () => {
            animFrameRef.current = 0;

            const analyser = analyserRef.current;
            if (!canvasCtx || !analyser || audio.paused) return;

            if (!dataArray || !frequencyData) {
                const bufferLength = analyser.frequencyBinCount;
                dataArray = new Uint8Array(bufferLength);
                frequencyData = new Uint8Array(bufferLength);
            }

            analyser.getByteTimeDomainData(dataArray);
            analyser.getByteFrequencyData(frequencyData);

            const { width, height } = canvasSizeRef.current;
            if (width === 0 || height === 0) return;

            canvasCtx.clearRect(0, 0, width, height);
            if (settings.store.oscilloscope) drawOscilloscope(canvasCtx, width, height, dataArray, dataArray.length);
            if (settings.store.spectrograph) drawSpectrograph(canvasCtx, width, height, frequencyData, frequencyData.length);

            requestDraw();
        };

        const onPlay = () => {
            if (!setupDoneRef.current) {
                if (initializing) return;
                initializing = true;
                void init().then(() => {
                    if (!cancelled && setupDoneRef.current) onPlay();
                }).catch(error => {
                    if (!cancelled) logger.error("Could not initialize the audio visualizer.", error);
                }).finally(() => { initializing = false; });
                return;
            }
            if (audioCtxRef.current?.state === "suspended") {
                audioCtxRef.current.resume();
            }
            requestDraw();
        };

        const onPause = () => {
            audioCtxRef.current?.suspend();
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = 0;
        };

        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        if (!audio.paused) onPlay();

        return () => {
            cancelled = true;
            controller.abort();
            audio.removeEventListener("play", onPlay);
            audio.removeEventListener("pause", onPause);
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = 0;
            audioCtxRef.current?.close();
            audioCtxRef.current = null;
            analyserRef.current = null;
            setupDoneRef.current = false;
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, [playerRef, src]);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return () => { };

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const devicePixelRatio = window.devicePixelRatio || 1;

            canvasSizeRef.current = { width: rect.width, height: rect.height };
            canvas.width = Math.floor(rect.width * devicePixelRatio);
            canvas.height = Math.floor(rect.height * devicePixelRatio);

            const ctx = canvas.getContext("2d");
            ctx?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        };

        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    return (
        <canvas
            className={cl("canvas")}
            ref={canvasRef}
        />
    );
}

const settings = definePluginSettings({
    oscilloscope: {
        type: OptionType.BOOLEAN,
        description: "Enable oscilloscope visualizer.",
        default: true,
    },
    spectrograph: {
        type: OptionType.BOOLEAN,
        description: "Enable spectrograph visualizer.",
        default: true,
    },
    oscilloscopeSolidColor: {
        type: OptionType.BOOLEAN,
        description: "Use a solid color for the oscilloscope.",
        default: false,
    },
    oscilloscopeColor: {
        type: OptionType.STRING,
        description: "Color for the oscilloscope (R, G, B or #hex).",
        default: "255, 255, 255",
        onChange: value => validateColor(value, "oscilloscopeColor", "255, 255, 255"),
    },
    spectrographSolidColor: {
        type: OptionType.BOOLEAN,
        description: "Use a solid color for the spectrograph.",
        default: false,
    },
    spectrographColor: {
        type: OptionType.STRING,
        description: "Color for the spectrograph (R, G, B or #hex).",
        default: "33, 150, 243",
        onChange: value => validateColor(value, "spectrographColor", "33, 150, 243"),
    },
});

export default definePlugin({
    name: "BetterAudioPlayer",
    performance: { impact: "high", description: "Draws audio spectrum and waveform animations while attachments play." },
    description: "Adds a spectrograph and oscilloscope visualizer to audio attachment players.",
    tags: ["Appearance", "Media", "Voice"],
    authors: [EquicordDevs.creations],
    settings,

    patches: [
        {
            find: "}renderPlayIcon(){",
            replacement: {
                match: /this\.renderAudio\(\):this\.renderVideo\(\)/,
                replace: "$&,$self.renderVisualizer(this)",
            },
        },
    ],

    stop() {
        for (const entry of audioDownloads.values()) entry.controller.abort();
        audioBlobCache.clear();
        audioCacheBytes = 0;
    },

    renderVisualizer(player: PlayerInstance) {
        if (player.props.type !== "AUDIO" || !settings.store.oscilloscope && !settings.store.spectrograph) return null;
        return <Visualizer playerRef={player.mediaRef} src={player.props.src} key={player.props.src} />;
    },
});
