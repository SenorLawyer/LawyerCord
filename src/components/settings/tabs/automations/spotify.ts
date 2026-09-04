/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI, SpotifyStore } from "@webpack/common";

import { checkCancelled } from "./runtime";

const SPOTIFY_API = "https://api.spotify.com/v1/me/player";

export interface ConnectedAccount {
    type: string;
    id: string;
    name: string;
    verified: boolean;
}

/**
 * The accounts linked in Discord's Connections settings. Discord only hands the client a
 * usable token for Spotify, so everything else here is read-only account information.
 */
export async function getConnections(): Promise<ConnectedAccount[]> {
    const { body } = await RestAPI.get({ url: Constants.Endpoints.CONNECTIONS });
    if (!Array.isArray(body)) throw new Error("Discord did not return your connections.");
    return body.flatMap(entry => typeof entry === "object" && entry !== null
        && typeof (entry as ConnectedAccount).type === "string"
        && typeof (entry as ConnectedAccount).id === "string"
        ? [{
            type: (entry as ConnectedAccount).type,
            id: (entry as ConnectedAccount).id,
            name: String((entry as ConnectedAccount).name ?? ""),
            verified: (entry as ConnectedAccount).verified === true,
        }]
        : []);
}

/** The Spotify token Discord holds for Listen Along, plus the device it is playing on. */
function requireSpotify(): { token: string; deviceId: string; premium: boolean; } {
    const active = SpotifyStore.getActiveSocketAndDevice();
    if (!active) throw new Error("Spotify is not connected, or nothing is playing. Open Spotify and start a track first.");
    return { token: active.socket.accessToken, deviceId: active.device.id, premium: active.socket.isPremium };
}

async function callSpotify(method: string, path: string, query: Record<string, string> = {}, signal?: AbortSignal, selectedDevice?: string) {
    if (signal) checkCancelled(signal);
    const { token, deviceId, premium } = requireSpotify();
    if (!premium) throw new Error("Spotify only allows playback control on Premium accounts.");

    const url = new URL(`${SPOTIFY_API}${path}`);
    url.searchParams.set("device_id", selectedDevice || deviceId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await fetch(url.toString(), { method, signal, headers: { Authorization: `Bearer ${token}` } });
    // Spotify answers 204 with no body when it accepts a command.
    if (!response.ok && response.status !== 204) {
        throw new Error(response.status === 403
            ? "Spotify refused that. Playback control needs Premium and an active device."
            : `Spotify returned ${response.status}.`);
    }
    if (signal) checkCancelled(signal);
    return { accepted: true, action: path.slice(1), deviceId: selectedDevice || deviceId, track: currentTrack() };
}

export const spotifyPlay = (signal?: AbortSignal, deviceId?: string) => callSpotify("PUT", "/play", {}, signal, deviceId);
export const spotifyPause = (signal?: AbortSignal, deviceId?: string) => callSpotify("PUT", "/pause", {}, signal, deviceId);
export const spotifyNext = (signal?: AbortSignal, deviceId?: string) => callSpotify("POST", "/next", {}, signal, deviceId);
export const spotifyPrevious = (signal?: AbortSignal, deviceId?: string) => callSpotify("POST", "/previous", {}, signal, deviceId);
export const spotifySeek = (seconds: number, signal?: AbortSignal, deviceId?: string) => callSpotify("PUT", "/seek", { position_ms: String(Math.max(0, Math.trunc(seconds)) * 1000) }, signal, deviceId);
export const spotifyVolume = (percent: number, signal?: AbortSignal, deviceId?: string) => callSpotify("PUT", "/volume", { volume_percent: String(Math.min(100, Math.max(0, Math.trunc(percent)))) }, signal, deviceId);
export function spotifySetting(setting: "shuffle" | "repeat", value: string, signal: AbortSignal, deviceId?: string) {
    if (!(setting === "shuffle" ? ["true", "false"] : ["off", "track", "context"]).includes(value)) throw new Error("Choose a valid Spotify setting.");
    return callSpotify("PUT", "/" + setting, { state: value }, signal, deviceId);
}

export function spotifyNowPlaying() {
    const track = currentTrack();
    if (!track) throw new Error("Spotify is not playing anything right now.");
    return track;
}

function currentTrack() {
    const track = SpotifyStore.getTrack();
    if (!track) return null;
    return {
        id: track.id,
        name: track.name,
        duration: track.duration,
        album: track.album.name,
        artists: track.artists.map(artist => artist.name),
        artist: track.artists.map(artist => artist.name).join(", "),
        url: `https://open.spotify.com/track/${track.id}`,
    };
}
