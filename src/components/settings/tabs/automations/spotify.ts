/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI, SpotifyStore } from "@webpack/common";

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

async function callSpotify(method: string, path: string, query: Record<string, string> = {}): Promise<void> {
    const { token, deviceId, premium } = requireSpotify();
    if (!premium) throw new Error("Spotify only allows playback control on Premium accounts.");

    const url = new URL(`${SPOTIFY_API}${path}`);
    url.searchParams.set("device_id", deviceId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await fetch(url.toString(), { method, headers: { Authorization: `Bearer ${token}` } });
    // Spotify answers 204 with no body when it accepts a command.
    if (!response.ok && response.status !== 204) {
        throw new Error(response.status === 403
            ? "Spotify refused that. Playback control needs Premium and an active device."
            : `Spotify returned ${response.status}.`);
    }
}

export const spotifyPlay = () => callSpotify("PUT", "/play");
export const spotifyPause = () => callSpotify("PUT", "/pause");
export const spotifyNext = () => callSpotify("POST", "/next");
export const spotifyPrevious = () => callSpotify("POST", "/previous");
export const spotifySeek = (seconds: number) => callSpotify("PUT", "/seek", { position_ms: String(Math.max(0, Math.trunc(seconds)) * 1000) });
export const spotifyVolume = (percent: number) => callSpotify("PUT", "/volume", { volume_percent: String(Math.min(100, Math.max(0, Math.trunc(percent)))) });

export function spotifyNowPlaying() {
    const track = SpotifyStore.getTrack();
    if (!track) throw new Error("Spotify is not playing anything right now.");
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
