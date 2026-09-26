/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { createRoot, React, showToast, Toasts } from "@webpack/common";

interface AudioKeeperProps {
    kind: "audio" | "voice";
    mediaRef?: React.RefObject<HTMLAudioElement>;
    renderNativePlayer?: () => React.ReactNode;
    src: string;
    waveform?: string;
}

interface VoiceMessageProps {
    __vcPersistentAudioDetached?: boolean;
    src: string;
    waveform?: string;
}

interface AudioSnapshot {
    currentTime: number;
    duration: number;
    muted: boolean;
    playbackRate: number;
    src: string;
    volume: number;
}

interface AudioPlayerInstance {
    mediaRef: React.RefObject<HTMLAudioElement>;
    props: {
        src: string;
        type: string;
    };
    renderAudio(): React.ReactNode;
}

interface DetachedPlayerBase {
    cleanup: () => void;
    kind: AudioKeeperProps["kind"];
    src: string;
    title: string;
    waveform?: string;
}

interface CustomDetachedPlayer extends DetachedPlayerBase {
    audio: HTMLAudioElement;
    mode: "custom";
}

interface NativeDetachedPlayer extends DetachedPlayerBase {
    audio?: HTMLAudioElement;
    mode: "native";
    renderNativePlayer: () => React.ReactNode;
    snapshot: AudioSnapshot;
}

type DetachedPlayer = CustomDetachedPlayer | NativeDetachedPlayer;

interface DragState {
    height: number;
    originLeft: number;
    originTop: number;
    startX: number;
    startY: number;
    width: number;
}

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const widgetMargin = 8;
const maxAudioAttachFrames = 120;
const maxWaveformCacheSize = 64;
const fallbackWaveformBars = [
    10, 14, 18, 12, 22, 16, 26, 20, 12, 18, 24, 14, 30, 18, 12, 20,
    26, 16, 22, 12, 18, 28, 16, 10, 20, 24, 14, 18, 30, 22, 12, 16,
    24, 14, 20, 28, 18, 12, 26, 16, 20, 14, 22, 30, 18, 12, 24, 16,
];
const detachedPlayers = new Map<string, DetachedPlayer>();
const widgetSubscribers = new Set<() => void>();
const waveformBarsCache = new Map<string, readonly number[]>();

let widgetContainer: HTMLDivElement | null = null;
let widgetRoot: ReturnType<typeof createRoot> | null = null;
let NativeVoiceMessage: React.ComponentType<VoiceMessageProps> | null = null;

const settings = definePluginSettings({
    keepVoiceMessages: {
        type: OptionType.BOOLEAN,
        description: "Keep voice messages playing after leaving their channel.",
        default: true,
    },
    keepAudioAttachments: {
        type: OptionType.BOOLEAN,
        description: "Keep audio attachments playing after leaving their channel.",
        default: true,
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when playback continues in the background.",
        default: true,
    },
    showWidget: {
        type: OptionType.BOOLEAN,
        description: "Show a floating control widget for background playback.",
        default: true,
    },
});

function shouldTrack(kind: AudioKeeperProps["kind"]) {
    return kind === "voice"
        ? settings.store.keepVoiceMessages
        : settings.store.keepAudioAttachments;
}

function sameAudio(audio: HTMLAudioElement, src: string) {
    return audio.src === src || audio.currentSrc === src;
}

function isDetachedWidgetAudio(audio: HTMLAudioElement) {
    return !!audio.closest(".vc-persistent-audio-widget-root");
}

function findAudioNear(anchor: HTMLElement | null, src: string) {
    let node = anchor?.parentElement ?? null;

    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        const audio = Array.from(node.querySelectorAll<HTMLAudioElement>("audio")).find(a => !isDetachedWidgetAudio(a) && sameAudio(a, src));
        if (audio) return audio;
    }

    return null;
}

function stopDetached(src: string) {
    const previous = detachedPlayers.get(src);
    if (!previous) return;

    previous.cleanup();
    previous.audio?.pause();
    if (previous.mode === "custom") previous.audio.src = "";
    detachedPlayers.delete(src);
    notifyWidget();
}

function stopAllDetached() {
    for (const src of Array.from(detachedPlayers.keys())) {
        stopDetached(src);
    }
}

function restoreDetachedToAudio(src: string, audio: HTMLAudioElement) {
    const player = detachedPlayers.get(src);
    if (!player || player.audio === audio) return false;

    const snapshot = player.audio ? capture(player.audio) : player.mode === "native" ? player.snapshot : null;
    if (!snapshot) return false;

    const shouldResume = player.audio ? !player.audio.paused && !player.audio.ended : true;

    audio.currentTime = snapshot.currentTime;
    audio.volume = snapshot.volume;
    audio.muted = snapshot.muted;
    audio.playbackRate = snapshot.playbackRate;

    stopDetached(src);

    if (shouldResume) {
        void audio.play().catch(() => {
            audio.pause();
        });
    }

    return shouldResume;
}

function getTitle(kind: AudioKeeperProps["kind"], src: string) {
    if (kind === "voice") return "Background voice message";

    try {
        const name = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "");
        return name || "Audio attachment";
    } catch {
        return "Audio attachment";
    }
}

function continueDetached(kind: AudioKeeperProps["kind"], snapshot: AudioSnapshot, renderNativePlayer?: () => React.ReactNode, waveform?: string) {
    if (!snapshot.src || Number.isFinite(snapshot.duration) && snapshot.currentTime >= snapshot.duration - 0.25) return;

    if (settings.store.showWidget && renderNativePlayer) {
        continueNativeDetached(kind, snapshot, renderNativePlayer, waveform);
        return;
    }

    continueCustomDetached(kind, snapshot, waveform);
}

function continueNativeDetached(kind: AudioKeeperProps["kind"], snapshot: AudioSnapshot, renderNativePlayer: () => React.ReactNode, waveform?: string) {
    stopDetached(snapshot.src);

    detachedPlayers.set(snapshot.src, {
        cleanup: () => void 0,
        kind,
        mode: "native",
        renderNativePlayer,
        snapshot,
        src: snapshot.src,
        title: getTitle(kind, snapshot.src),
        waveform,
    });

    ensureWidgetRoot();
    notifyWidget();

    if (settings.store.showToast) {
        showToast("Continuing audio playback in a floating player.", Toasts.Type.MESSAGE);
    }
}

function continueCustomDetached(kind: AudioKeeperProps["kind"], snapshot: AudioSnapshot, waveform?: string) {
    stopDetached(snapshot.src);

    const audio = new Audio(snapshot.src);
    audio.currentTime = snapshot.currentTime;
    audio.volume = snapshot.volume;
    audio.muted = snapshot.muted;
    audio.playbackRate = snapshot.playbackRate;

    const updateWidget = () => notifyWidget();
    const cleanup = () => stopDetached(snapshot.src);
    const removeListeners = () => {
        audio.removeEventListener("play", updateWidget);
        audio.removeEventListener("pause", updateWidget);
        audio.removeEventListener("timeupdate", updateWidget);
        audio.removeEventListener("durationchange", updateWidget);
        audio.removeEventListener("volumechange", updateWidget);
        audio.removeEventListener("ratechange", updateWidget);
        audio.removeEventListener("ended", cleanup);
        audio.removeEventListener("error", cleanup);
    };

    audio.addEventListener("play", updateWidget);
    audio.addEventListener("pause", updateWidget);
    audio.addEventListener("timeupdate", updateWidget);
    audio.addEventListener("durationchange", updateWidget);
    audio.addEventListener("volumechange", updateWidget);
    audio.addEventListener("ratechange", updateWidget);
    audio.addEventListener("ended", cleanup);
    audio.addEventListener("error", cleanup);
    detachedPlayers.set(snapshot.src, {
        audio,
        cleanup: removeListeners,
        kind,
        mode: "custom",
        src: snapshot.src,
        title: getTitle(kind, snapshot.src),
        waveform,
    });

    if (settings.store.showWidget) {
        ensureWidgetRoot();
    }

    notifyWidget();

    audio.play().then(() => {
        if (settings.store.showToast) {
            showToast("Continuing audio playback in the background.", Toasts.Type.MESSAGE);
        }
    }).catch(cleanup);
}

function capture(audio: HTMLAudioElement): AudioSnapshot {
    return {
        currentTime: audio.currentTime,
        duration: audio.duration,
        muted: audio.muted,
        playbackRate: audio.playbackRate,
        src: audio.currentSrc || audio.src,
        volume: audio.volume,
    };
}

function notifyWidget() {
    for (const subscriber of widgetSubscribers) {
        subscriber();
    }
}

function ensureWidgetRoot() {
    if (widgetRoot || !document.body) return;

    widgetContainer = document.createElement("div");
    widgetContainer.className = "vc-persistent-audio-widget-root";
    document.body.appendChild(widgetContainer);

    widgetRoot = createRoot(widgetContainer);
    widgetRoot.render(<DetachedAudioWidget />);
}

function unmountWidgetRoot() {
    widgetRoot?.unmount();
    widgetRoot = null;

    widgetContainer?.remove();
    widgetContainer = null;
}

function formatDuration(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";

    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;

    return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function seek(player: CustomDetachedPlayer, delta: number) {
    const { audio } = player;
    const duration = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + delta;
    audio.currentTime = Math.min(Math.max(audio.currentTime + delta, 0), duration);
    notifyWidget();
}

function seekToRatio(player: CustomDetachedPlayer, ratio: number) {
    const { audio } = player;
    const { duration } = audio;
    if (!Number.isFinite(duration) || duration <= 0) return;

    audio.currentTime = Math.min(Math.max(ratio, 0), 1) * duration;
    notifyWidget();
}

function setPosition(player: CustomDetachedPlayer, value: string) {
    const position = Number(value);
    if (!Number.isFinite(position)) return;

    player.audio.currentTime = position;
    notifyWidget();
}

function setVolume(player: CustomDetachedPlayer, value: string) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return;

    player.audio.volume = Math.min(Math.max(volume, 0), 1);
    player.audio.muted = player.audio.volume === 0;
    notifyWidget();
}

function togglePlayback(player: CustomDetachedPlayer) {
    if (player.audio.paused) {
        void player.audio.play().catch(() => stopDetached(player.src));
        return;
    }

    player.audio.pause();
}

function toggleMute(player: CustomDetachedPlayer) {
    player.audio.muted = !player.audio.muted;
    notifyWidget();
}

function cyclePlaybackRate(player: CustomDetachedPlayer) {
    const current = player.audio.playbackRate;
    player.audio.playbackRate = playbackRates.find(rate => rate > current + 0.01) ?? playbackRates[0];
    notifyWidget();
}

function clampWidgetPosition(position: { left: number; top: number; }, width: number, height: number) {
    const maxLeft = Math.max(widgetMargin, window.innerWidth - width - widgetMargin);
    const maxTop = Math.max(widgetMargin, window.innerHeight - height - widgetMargin);

    return {
        left: Math.min(Math.max(position.left, widgetMargin), maxLeft),
        top: Math.min(Math.max(position.top, widgetMargin), maxTop),
    };
}

function decodeWaveform(waveform?: string) {
    if (!waveform) return fallbackWaveformBars;

    const cached = waveformBarsCache.get(waveform);
    if (cached) return cached;

    try {
        const bytes = window.atob(waveform);
        const bars = Array.from(bytes, byte => Math.max(8, Math.round(byte.charCodeAt(0) / 255 * 28) + 4));
        const decoded = bars.length ? bars : fallbackWaveformBars;

        waveformBarsCache.set(waveform, decoded);
        if (waveformBarsCache.size > maxWaveformCacheSize) {
            const oldestKey = waveformBarsCache.keys().next().value;
            if (oldestKey) waveformBarsCache.delete(oldestKey);
        }

        return decoded;
    } catch {
        return fallbackWaveformBars;
    }
}

function DetachedAudioWidget() {
    const [, forceUpdate] = React.useReducer((value: number) => value + 1, 0);
    const [position, setPosition] = React.useState<{ left: number; top: number; } | null>(null);
    const dragStateRef = React.useRef<DragState | null>(null);
    const widgetRef = React.useRef<HTMLElement>(null);

    const clampCurrentWidgetPosition = React.useCallback(() => {
        const widget = widgetRef.current;
        if (!widget) return;

        const rect = widget.getBoundingClientRect();
        setPosition(current => {
            if (!current) return current;
            const next = clampWidgetPosition(current, rect.width, rect.height);
            return next.left === current.left && next.top === current.top ? current : next;
        });
    }, []);

    React.useEffect(() => {
        widgetSubscribers.add(forceUpdate);
        return () => void widgetSubscribers.delete(forceUpdate);
    }, []);

    React.useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;

            setPosition(clampWidgetPosition({
                left: dragState.originLeft + event.clientX - dragState.startX,
                top: dragState.originTop + event.clientY - dragState.startY,
            }, dragState.width, dragState.height));
        };

        const onPointerUp = () => {
            dragStateRef.current = null;
        };

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);

        return () => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
        };
    }, []);

    React.useEffect(() => {
        window.addEventListener("resize", clampCurrentWidgetPosition);
        return () => window.removeEventListener("resize", clampCurrentWidgetPosition);
    }, [clampCurrentWidgetPosition]);

    React.useEffect(clampCurrentWidgetPosition);

    const onDragStart = (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;

        const widget = event.currentTarget.closest<HTMLElement>(".vc-persistent-audio-widget");
        if (!widget) return;

        const rect = widget.getBoundingClientRect();
        dragStateRef.current = {
            height: rect.height,
            originLeft: rect.left,
            originTop: rect.top,
            startX: event.clientX,
            startY: event.clientY,
            width: rect.width,
        };
        setPosition({ left: rect.left, top: rect.top });
        event.preventDefault();
    };

    const players = Array.from(detachedPlayers.values());
    if (!players.length) return null;

    return (
        <section
            aria-label="Background audio controls"
            className="vc-persistent-audio-widget"
            ref={widgetRef}
            style={position ? { bottom: "auto", left: position.left, right: "auto", top: position.top } : undefined}
        >
            <div className="vc-persistent-audio-widget-header" onPointerDown={onDragStart}>
                <div>
                    <div className="vc-persistent-audio-widget-title">Background audio</div>
                    <div className="vc-persistent-audio-widget-count">{players.length} active</div>
                </div>
                <button className="vc-persistent-audio-control" type="button" onClick={stopAllDetached}>
                    Stop all
                </button>
            </div>
            {players.map(player => (
                player.mode === "native"
                    ? <NativeDetachedPlayerControls key={player.src} player={player} />
                    : player.kind === "voice"
                        ? <VoiceDetachedPlayerControls key={player.src} player={player} />
                        : <DetachedPlayerControls key={player.src} player={player} />
            ))}
        </section>
    );
}

function NativeDetachedPlayerControls({ player }: { player: NativeDetachedPlayer; }) {
    const nativeUiRef = React.useRef<HTMLDivElement>(null);
    const nativeNode = player.renderNativePlayer();

    React.useEffect(() => {
        let audio: HTMLAudioElement | null = null;
        let frame = 0;
        let settled = false;
        let attachAttempts = 0;

        const updateWidget = () => {
            if (audio) player.snapshot = capture(audio);
            notifyWidget();
        };
        const cleanup = () => stopDetached(player.src);
        const removeListeners = () => {
            if (!audio) return;

            audio.removeEventListener("play", updateWidget);
            audio.removeEventListener("pause", updateWidget);
            audio.removeEventListener("timeupdate", updateWidget);
            audio.removeEventListener("durationchange", updateWidget);
            audio.removeEventListener("volumechange", updateWidget);
            audio.removeEventListener("ratechange", updateWidget);
            audio.removeEventListener("ended", cleanup);
            audio.removeEventListener("error", cleanup);
        };

        const attach = () => {
            audio = nativeUiRef.current?.querySelector<HTMLAudioElement>("audio") ?? null;

            if (!audio) {
                if (++attachAttempts > maxAudioAttachFrames) {
                    stopDetached(player.src);
                    return;
                }

                frame = requestAnimationFrame(attach);
                return;
            }

            settled = true;
            player.audio = audio;
            player.cleanup = removeListeners;

            audio.currentTime = player.snapshot.currentTime;
            audio.volume = player.snapshot.volume;
            audio.muted = player.snapshot.muted;
            audio.playbackRate = player.snapshot.playbackRate;

            audio.addEventListener("play", updateWidget);
            audio.addEventListener("pause", updateWidget);
            audio.addEventListener("timeupdate", updateWidget);
            audio.addEventListener("durationchange", updateWidget);
            audio.addEventListener("volumechange", updateWidget);
            audio.addEventListener("ratechange", updateWidget);
            audio.addEventListener("ended", cleanup);
            audio.addEventListener("error", cleanup);

            void audio.play().then(updateWidget).catch(cleanup);
        };

        attach();

        return () => {
            cancelAnimationFrame(frame);
            if (!settled) return;

            removeListeners();
            audio?.pause();
            if (player.audio === audio) player.audio = undefined;
        };
    }, [player]);

    return (
        <article className="vc-persistent-audio-player vc-persistent-audio-native-player">
            <div className="vc-persistent-audio-player-heading">
                <div>
                    <div className="vc-persistent-audio-player-title">{player.title}</div>
                    <div className="vc-persistent-audio-player-kind">Floating Discord audio player</div>
                </div>
                <button
                    aria-label="Stop background audio"
                    className="vc-persistent-audio-icon-button"
                    type="button"
                    onClick={() => stopDetached(player.src)}
                >
                    Stop
                </button>
            </div>
            <div className="vc-persistent-audio-native-ui" ref={nativeUiRef}>
                {nativeNode}
            </div>
        </article>
    );
}

function DetachedPlayerControls({ player }: { player: CustomDetachedPlayer; }) {
    const { audio } = player;
    const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
    const currentTime = hasDuration ? Math.min(audio.currentTime, audio.duration) : 0;

    return (
        <article className="vc-persistent-audio-player">
            <div className="vc-persistent-audio-player-heading">
                <div>
                    <div className="vc-persistent-audio-player-title">{player.title}</div>
                    <div className="vc-persistent-audio-player-kind">
                        {player.kind === "voice" ? "Voice message" : "Audio attachment"}
                    </div>
                </div>
                <button
                    aria-label="Stop background audio"
                    className="vc-persistent-audio-icon-button"
                    type="button"
                    onClick={() => stopDetached(player.src)}
                >
                    Stop
                </button>
            </div>
            <input
                aria-label="Playback position"
                className="vc-persistent-audio-range"
                disabled={!hasDuration}
                max={hasDuration ? audio.duration : 1}
                min={0}
                onChange={event => setPosition(player, event.currentTarget.value)}
                step={0.1}
                type="range"
                value={currentTime}
            />
            <div className="vc-persistent-audio-time-row">
                <span>{formatDuration(audio.currentTime)}</span>
                <span>{formatDuration(audio.duration)}</span>
            </div>
            <div className="vc-persistent-audio-controls">
                <button className="vc-persistent-audio-control" type="button" onClick={() => seek(player, -15)}>
                    -15s
                </button>
                <button className="vc-persistent-audio-control vc-persistent-audio-primary" type="button" onClick={() => togglePlayback(player)}>
                    {audio.paused ? "Play" : "Pause"}
                </button>
                <button className="vc-persistent-audio-control" type="button" onClick={() => seek(player, 15)}>
                    +15s
                </button>
                <button className="vc-persistent-audio-control" type="button" onClick={() => toggleMute(player)}>
                    {audio.muted ? "Unmute" : "Mute"}
                </button>
                <button className="vc-persistent-audio-control" type="button" onClick={() => cyclePlaybackRate(player)}>
                    {audio.playbackRate.toFixed(audio.playbackRate % 1 ? 2 : 0)}x
                </button>
            </div>
            <label className="vc-persistent-audio-volume">
                <span>Volume</span>
                <input
                    aria-label="Playback volume"
                    className="vc-persistent-audio-range"
                    max={1}
                    min={0}
                    onChange={event => setVolume(player, event.currentTarget.value)}
                    step={0.01}
                    type="range"
                    value={audio.muted ? 0 : audio.volume}
                />
            </label>
        </article>
    );
}

function VoiceDetachedPlayerControls({ player }: { player: CustomDetachedPlayer; }) {
    const { audio } = player;
    const bars = decodeWaveform(player.waveform);
    const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
    const currentTime = hasDuration ? Math.min(audio.currentTime, audio.duration) : 0;
    const progress = hasDuration ? currentTime / audio.duration : 0;

    const onWaveformClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        seekToRatio(player, (event.clientX - rect.left) / rect.width);
    };

    return (
        <article className="vc-persistent-audio-voice-player">
            <button
                aria-label={audio.paused ? "Play background voice message" : "Pause background voice message"}
                className={`vc-persistent-audio-voice-play${audio.paused ? "" : " vc-persistent-audio-voice-play-paused"}`}
                type="button"
                onClick={() => togglePlayback(player)}
            />
            <button
                aria-label="Voice message playback position"
                className="vc-persistent-audio-voice-waveform"
                disabled={!hasDuration}
                type="button"
                onClick={onWaveformClick}
            >
                {bars.map((height, index) => (
                    <span
                        className={index / bars.length <= progress ? "vc-persistent-audio-voice-bar vc-persistent-audio-voice-bar-active" : "vc-persistent-audio-voice-bar"}
                        key={index}
                        style={{ height }}
                    />
                ))}
            </button>
            <span className="vc-persistent-audio-voice-time">
                {formatDuration(hasDuration ? audio.duration : audio.currentTime)}
            </span>
            <button
                aria-label="Change playback speed"
                className="vc-persistent-audio-voice-rate"
                type="button"
                onClick={() => cyclePlaybackRate(player)}
            >
                {audio.playbackRate.toFixed(audio.playbackRate % 1 ? 2 : 0)}x
            </button>
            <button
                aria-label={audio.muted ? "Unmute background voice message" : "Mute background voice message"}
                className="vc-persistent-audio-voice-volume"
                type="button"
                onClick={() => toggleMute(player)}
            >
                {audio.muted ? "Unmute" : "Mute"}
            </button>
            <button
                aria-label="Stop background voice message"
                className="vc-persistent-audio-voice-stop"
                type="button"
                onClick={() => stopDetached(player.src)}
            >
                Stop
            </button>
            <input
                aria-label="Background voice message volume"
                className="vc-persistent-audio-voice-volume-slider"
                max={1}
                min={0}
                onChange={event => setVolume(player, event.currentTarget.value)}
                step={0.01}
                type="range"
                value={audio.muted ? 0 : audio.volume}
            />
        </article>
    );
}

function AudioKeeper({ kind, mediaRef, renderNativePlayer, src, waveform }: AudioKeeperProps) {
    const anchorRef = React.useRef<HTMLSpanElement>(null);
    const renderNativePlayerRef = React.useRef(renderNativePlayer);
    renderNativePlayerRef.current = renderNativePlayer;

    React.useEffect(() => {
        if (!src || !shouldTrack(kind)) return;

        let audio: HTMLAudioElement | null = null;
        let frame = 0;
        let started = false;
        let ended = false;
        let attachAttempts = 0;
        let lastPauseAt = 0;
        let snapshot: AudioSnapshot | null = null;

        const updateSnapshot = () => {
            if (audio) snapshot = capture(audio);
        };

        const onPlay = () => {
            started = true;
            ended = false;
            stopDetached(src);
            updateSnapshot();
        };

        const onPause = () => {
            lastPauseAt = Date.now();
            updateSnapshot();
        };

        const onEnded = () => {
            ended = true;
            started = false;
            stopDetached(src);
            updateSnapshot();
        };

        const attach = () => {
            audio = mediaRef?.current ?? findAudioNear(anchorRef.current, src);

            if (!audio) {
                if (++attachAttempts > maxAudioAttachFrames) return;
                frame = requestAnimationFrame(attach);
                return;
            }

            const restoredPlayback = restoreDetachedToAudio(src, audio);
            updateSnapshot();
            started = restoredPlayback || (!audio.paused && !audio.ended);
            ended = audio.ended;
            audio.addEventListener("play", onPlay);
            audio.addEventListener("pause", onPause);
            audio.addEventListener("ended", onEnded);
            audio.addEventListener("timeupdate", updateSnapshot);
            audio.addEventListener("ratechange", updateSnapshot);
            audio.addEventListener("volumechange", updateSnapshot);
        };

        attach();

        return () => {
            cancelAnimationFrame(frame);
            updateSnapshot();

            audio?.removeEventListener("play", onPlay);
            audio?.removeEventListener("pause", onPause);
            audio?.removeEventListener("ended", onEnded);
            audio?.removeEventListener("timeupdate", updateSnapshot);
            audio?.removeEventListener("ratechange", updateSnapshot);
            audio?.removeEventListener("volumechange", updateSnapshot);

            const recentlyPaused = Date.now() - lastPauseAt < 250;
            if (snapshot && started && !ended && (!audio?.paused || recentlyPaused)) {
                continueDetached(kind, snapshot, renderNativePlayerRef.current, waveform);
            }
        };
    }, [kind, mediaRef, src, waveform]);

    return <span ref={anchorRef} style={{ display: "none" }} aria-hidden />;
}

export default definePlugin({
    name: "PersistentAudioPlayback",
    description: "Keeps voice messages and audio attachments playing after you navigate away.",
    tags: ["Media", "Voice"],
    authors: [EquicordDevs.nobody],
    settings,

    patches: [
        {
            find: "#{intl::PAUSE_VOICE_MESSAGE_A11Y_LABEL}",
            replacement: {
                match: /(?=\i\.memo\(.{0,50}?=1,onVolumeChange:[^}]+?waveform:[^}]+?playbackCacheKey:)/,
                replace: "$self.NativeVoiceMessage="
            }
        },
        {
            find: "#{intl::VOICE_MESSAGES_PLAYBACK_RATE_LABEL}",
            replacement: {
                match: /(?<=onVolumeHide:\i\}\))/,
                replace: ",$self.renderVoiceKeeper(arguments[0])"
            }
        },
        {
            find: "}renderPlayIcon(){",
            replacement: {
                match: /this\.renderAudio\(\):this\.renderVideo\(\)/,
                replace: "$&,$self.renderAudioKeeper(this)"
            },
        },
    ],

    stop() {
        stopAllDetached();
        unmountWidgetRoot();
        widgetSubscribers.clear();
        waveformBarsCache.clear();
    },

    set NativeVoiceMessage(value: React.ComponentType<VoiceMessageProps>) {
        NativeVoiceMessage = value;
    },

    renderVoiceKeeper(props: string | VoiceMessageProps) {
        const voiceProps = typeof props === "string" ? { src: props } : props;
        const NativeVoiceMessageComponent = NativeVoiceMessage;

        if (!voiceProps?.src || voiceProps.__vcPersistentAudioDetached) return null;

        return (
            <AudioKeeper
                kind="voice"
                renderNativePlayer={NativeVoiceMessageComponent ? () => <NativeVoiceMessageComponent {...voiceProps} __vcPersistentAudioDetached /> : undefined}
                src={voiceProps.src}
                waveform={voiceProps.waveform}
            />
        );
    },

    renderAudioKeeper(player: AudioPlayerInstance) {
        if (player.props.type !== "AUDIO") return null;
        return (
            <AudioKeeper
                kind="audio"
                mediaRef={player.mediaRef}
                renderNativePlayer={player.renderAudio.bind(player)}
                src={player.props.src}
            />
        );
    },
});
