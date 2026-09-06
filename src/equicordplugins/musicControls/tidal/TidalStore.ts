/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

import { settings } from "../settings";

export interface Track {
    id: string;
    name: string;
    artist: string;
    imageSrc?: string | null;
    songDuration: number;
    elapsedSeconds?: number;
    url?: string;
    album?: string | null;
    vibrantColor?: string | null;
}

export interface PlayerState {
    track: Track | null;
    isPlaying: boolean,
    position: number,
    repeat: Repeat,
    shuffle: boolean,
    volume: number,
}

export type Repeat = 0 | 1 | 2;

const logger = new Logger("TidalControls");

function mapApiResponseToTrack(apiData: any): Track | null {
    if (!apiData?.track) return null;

    const { track } = apiData;
    const artist = track.artist?.name || (track.artists?.[0]?.name) || "Unknown Artist";

    return {
        name: track.title || "Unknown Title",
        artist,
        imageSrc: apiData.coverUrl || null,
        songDuration: apiData.duration || track.duration || 0,
        elapsedSeconds: apiData.currentTime || 0,
        url: track.url || null,
        album: track.album?.title || null,
        id: track.id?.toString() || "0",
        vibrantColor: track.album?.vibrantColor || null,
    };
}

function isSameTrack(previous: Track | null, next: Track) {
    return previous?.id === next.id
        && previous.name === next.name
        && previous.artist === next.artist
        && previous.imageSrc === next.imageSrc
        && previous.songDuration === next.songDuration
        && previous.url === next.url
        && previous.album === next.album
        && previous.vibrantColor === next.vibrantColor;
}

type Message = { type: "update"; all: boolean; fields?: any; field?: string; value?: any; } | { type: "subscribed" | "unsubscribed" | "ok" | "error";[key: string]: any; };

class TidalSocket {
    public onChange: (e: Message) => void;
    public ready = false;

    public socket: WebSocket | undefined;
    private connecting = false;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

    constructor(onChange: typeof this.onChange) {
        this.onChange = onChange;
        this.reconnect();
    }

    public reconnect() {
        if (this.ready || this.connecting) return;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        try {
            this.initWs();
        } catch (e) {
            this.connecting = false;
            logger.error("Failed to connect to Tidal WebSocket", e);
            this.scheduleReconnect(5_000);
            return;
        }
    }

    get routes() {
        return {
            "play": () => this.socket?.send(JSON.stringify({ action: "resume" })),
            "pause": () => this.socket?.send(JSON.stringify({ action: "pause" })),
            "toggle": () => this.socket?.send(JSON.stringify({ action: "toggle" })),
            "previous": () => this.socket?.send(JSON.stringify({ action: "previous" })),
            "next": () => this.socket?.send(JSON.stringify({ action: "next" })),
            "seek": (seconds: number) => this.socket?.send(JSON.stringify({ action: "seek", time: seconds })),
            "shuffle": (shuffle: boolean) => this.socket?.send(JSON.stringify({ action: "setShuffleMode", shuffle })),
            "repeat": (mode: Repeat) => this.socket?.send(JSON.stringify({ action: "setRepeatMode", mode })),
            "volume": (volume: number) => this.socket?.send(JSON.stringify({ action: "volume", volume })),
        };
    }

    private scheduleReconnect(delay: number) {
        if (this.reconnectTimeout) return;

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this.reconnect();
        }, delay);
    }

    public destroy() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        const { socket } = this;
        this.socket = undefined;
        this.connecting = false;
        this.ready = false;
        socket?.close();
    }

    private initWs() {
        const url = settings.store.websocketURL || "ws://localhost:24123";
        if (!url) {
            return;
        }
        this.connecting = true;
        const socket = new WebSocket(url);
        this.socket = socket;

        socket.addEventListener("open", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = true;
            socket.send(JSON.stringify({ action: "subscribe", all: true, fields: ["currentTime"] }));
        });

        socket.addEventListener("error", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = false;
            this.scheduleReconnect(5_000);
            this.onChange({ type: "update", all: true, fields: { playing: false, track: null, currentTime: 0, repeatMode: 0, shuffle: false, volume: 100 } });
        });

        socket.addEventListener("close", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = false;
            this.scheduleReconnect(10_000);
            this.onChange({ type: "update", all: true, fields: { playing: false, track: null, currentTime: 0, repeatMode: 0, shuffle: false, volume: 100 } });
        });

        socket.addEventListener("message", e => {
            if (this.socket !== socket) return;
            let message: Message;
            try {
                message = JSON.parse(e.data) as Message;

                switch (message.type) {
                    case "update":
                        this.onChange(message);
                        break;
                    case "error":
                        logger.error("Tidal API error:", message);
                        break;
                }
            } catch (err) {
                logger.error("Invalid JSON:", err, `\n${e.data}`);
                return;
            }
        });
    }
}

export const TidalStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    class TidalStore extends Store {
        public mPosition = 0;
        public start = 0;

        public track: Track | null = null;
        public isPlaying = false;
        public repeat: Repeat = 0;
        public shuffle = false;
        public volume = 100;
        public playerElement: HTMLElement | null = null;
        private appliedVibrantColor: string | null = null;

        public socket = new TidalSocket((message: Message) => {
            if (message.type === "update" && message.all && message.fields) {
                const apiData = message.fields;

                const track = mapApiResponseToTrack(apiData);

                if (!track || !isSameTrack(store.track, track)) {
                    store.track = track;
                }
                store.position = (apiData.currentTime || 0);
                if (track) this.applyVibrantColor(track.vibrantColor);

                if (apiData.playing !== undefined) store.isPlaying = apiData.playing;
                if (apiData.repeatMode !== undefined) store.repeat = apiData.repeatMode;
                if (apiData.shuffle !== undefined) store.shuffle = apiData.shuffle;
                if (apiData.volume !== undefined) store.volume = apiData.volume;

                store.emitChange();
            }
        });

        public openExternal(path: string) {
            VencordNative.native.openExternal(path.replace("http://www.tidal.com", "tidal://"));

        }

        private applyVibrantColor(vibrantColor?: string | null) {
            if (!vibrantColor) return;
            if (this.playerElement && this.appliedVibrantColor === vibrantColor) return;

            this.playerElement ??= document.querySelector("#eq-tdl-player");
            if (!this.playerElement) return;

            this.playerElement.style.setProperty("--eq-tdl-slider-gradient", `linear-gradient(to right, ${vibrantColor} 80%, #E5E5E5 100%)`);
            this.playerElement.style.setProperty("--eq-tdl-slider-grabber", vibrantColor);
            this.appliedVibrantColor = vibrantColor;
        }

        set position(p: number) {
            this.mPosition = p * 1000;
            this.start = Date.now();
        }

        get position(): number {
            let pos = this.mPosition;
            if (this.isPlaying) {
                pos += Date.now() - this.start;
            }
            return pos;
        }

        previous() {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.previous();
        }
        next() {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.next();
        }
        setVolume(percent: number) {
            if (!this.ensureSocketReady()) return;
            const volume = Math.max(1, Math.min(100, Math.round(percent)));
            this.socket.routes.volume(volume);
            this.volume = volume;
            this.emitChange();
        }
        setPlaying(playing: boolean) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes[playing ? "play" : "pause"]();
            this.isPlaying = playing;
        }
        setRepeat(state: Repeat) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.repeat(state);
            this.repeat = state;
            this.emitChange();
        }
        setShuffle(state: boolean) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.shuffle(state);
            this.shuffle = state;
            this.emitChange();
        }
        seek(ms: number) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.seek(Math.round(ms / 1000));
        }

        public ensureSocketReady(): boolean {
            if (!this.socket || !this.socket.ready) {
                return false;
            }
            return true;
        }

        public destroy() {
            this.socket.destroy();
            this.track = null;
            this.isPlaying = false;
            this.mPosition = 0;
            this.start = 0;
            this.playerElement = null;
            this.appliedVibrantColor = null;
            this.emitChange();
        }
    }

    const store = new TidalStore(FluxDispatcher);

    return store;
});
