/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { FluxDispatcher } from "@webpack/common";

import { BanchoStatusEnum, GameState, Modes, TosuApi } from "../types/tosu";
import { getCachedApplicationAsset } from "./assetCache";

const OSU_APP_ID = "367827983903490050";
const OSU_STARDARD_SMALL_IMAGE = "373370493127884800";
const OSU_MANIA_SMALL_IMAGE = "373370588703621136";
const OSU_TAIKO_SMALL_IMAGE = "373370519891738624";
const OSU_CATCH_SMALL_IMAGE = "373370543161999361";
const SOCKET_ID = "RichPresence_Tosu";
const MAX_BEATMAP_COVER_CACHE_SIZE = 75;
const MESSAGE_THROTTLE_MS = 3000;

let ws: WebSocket | undefined;
let wsReconnect: ReturnType<typeof setTimeout> | undefined;
let shouldReconnect = false;
let connectionGeneration = 0;
let inMessageThrottle = false;
let messageThrottleTimeout: ReturnType<typeof setTimeout> | undefined;
let clearActivityTimeout: ReturnType<typeof setTimeout> | undefined;
const beatmapCoverCache = new Map<number, Promise<string | undefined>>();

function joinStateParts(...parts: string[]): string {
    let state = "";
    for (const part of parts) {
        if (!part) continue;
        if (state) state += " | ";
        state += part;
    }

    return state;
}

function clearActivity() {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: SOCKET_ID });
}

function clearRuntimeTimeouts() {
    if (wsReconnect) {
        clearTimeout(wsReconnect);
        wsReconnect = undefined;
    }
    if (messageThrottleTimeout) {
        clearTimeout(messageThrottleTimeout);
        messageThrottleTimeout = undefined;
    }
    if (clearActivityTimeout) {
        clearTimeout(clearActivityTimeout);
        clearActivityTimeout = undefined;
    }
    inMessageThrottle = false;
}

function throttledOnMessage(data: string, generation: number) {
    if (!shouldReconnect || generation !== connectionGeneration || inMessageThrottle) return;

    void onMessage(data, generation);
    inMessageThrottle = true;

    messageThrottleTimeout = setTimeout(() => {
        messageThrottleTimeout = undefined;
        inMessageThrottle = false;
    }, MESSAGE_THROTTLE_MS);

    if (clearActivityTimeout) clearTimeout(clearActivityTimeout);
    clearActivityTimeout = setTimeout(() => {
        clearActivityTimeout = undefined;
        if (shouldReconnect && generation === connectionGeneration) clearActivity();
    }, MESSAGE_THROTTLE_MS * 2);
}

async function getAsset(key: string): Promise<string> {
    if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\/attachments\//.test(key))
        return "mp:" + key.replace(/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//, "");
    return getCachedApplicationAsset(OSU_APP_ID, key);
}

function pruneOldestBeatmapCover() {
    const oldestKey = beatmapCoverCache.keys().next().value;
    if (oldestKey !== undefined) beatmapCoverCache.delete(oldestKey);
}

function getBeatmapCover(setId: number): Promise<string | undefined> {
    const cachedCover = beatmapCoverCache.get(setId);
    if (cachedCover) return cachedCover;

    if (beatmapCoverCache.size >= MAX_BEATMAP_COVER_CACHE_SIZE) pruneOldestBeatmapCover();

    const coverPromise = (async () => {
        const mapBg = await getAsset(`https://assets.ppy.sh/beatmaps/${setId}/covers/list@2x.jpg`);
        if (!mapBg) return undefined;

        const res = await fetch(mapBg.replace(/^mp:/, "https://media.discordapp.net/"), { method: "HEAD" });
        if (!res.ok) {
            beatmapCoverCache.delete(setId);
            return undefined;
        }

        return mapBg;
    })().catch(() => {
        beatmapCoverCache.delete(setId);
        return undefined;
    });

    beatmapCoverCache.set(setId, coverPromise);
    return coverPromise;
}

async function onMessage(data: string, generation: number) {
    if (!shouldReconnect || generation !== connectionGeneration) return;

    const json: TosuApi = JSON.parse(data);
    // @ts-ignore
    if (json.error) return clearActivity();

    const { state, session, profile, beatmap, play, resultsScreen } = json;

    const assets: NonNullable<Activity["assets"]> = {};

    switch (profile.mode.number) {
        case Modes.Osu:
            assets.small_image = OSU_STARDARD_SMALL_IMAGE;
            assets.small_text = "osu!";
            break;
        case Modes.Mania:
            assets.small_image = OSU_MANIA_SMALL_IMAGE;
            assets.small_text = "osu!mania";
            break;
        case Modes.Taiko:
            assets.small_image = OSU_TAIKO_SMALL_IMAGE;
            assets.small_text = "osu!taiko";
            break;
        case Modes.Fruits:
            assets.small_image = OSU_CATCH_SMALL_IMAGE;
            assets.small_text = "osu!catch";
            break;
    }

    const activity: Activity = {
        application_id: OSU_APP_ID,
        name: "osu!",
        type: ActivityType.PLAYING,
        assets,
        timestamps: { start: Date.now() - session.playTime },
        flags: 1 << 0,
    };

    let mods = "";
    let fc = "";
    let combo = "";
    let h100 = "";
    let h50 = "";
    let h0 = "";
    let sb = "";
    let pp = "";

    switch (state.number) {
        case GameState.Play: {
            activity.type = profile.banchoStatus.number === BanchoStatusEnum.Playing
                ? ActivityType.PLAYING : ActivityType.WATCHING;

            const player = profile.banchoStatus.number === BanchoStatusEnum.Playing ? "" : `${play.playerName} | `;
            mods = play.mods.name ? `+${play.mods.name} ` : "";
            activity.name = `${player}${beatmap.artist} - ${beatmap.title} [${beatmap.version}] ${mods}(${beatmap.mapper}, ${beatmap.stats.stars.total.toFixed(2)}*)`;

            combo = play.hits[0] === 0 && play.hits.sliderBreaks === 0
                ? `${play.combo.current}x`
                : `${play.combo.current}x/${play.combo.max}x`;
            pp = play.hits[0] === 0 && play.hits.sliderBreaks === 0
                ? `${Math.round(play.pp.current)}pp`
                : `${Math.round(play.pp.current)}pp/${Math.round(play.pp.fc)}pp`;
            activity.details = `${play.accuracy.toFixed(2)}% | ${combo} | ${pp}`;

            h100 = play.hits[100] > 0 ? `${play.hits[100]}x100` : "";
            h50 = play.hits[50] > 0 ? `${play.hits[50]}x50` : "";
            h0 = play.hits[0] > 0 ? `${play.hits[0]}xMiss` : "";
            sb = play.hits.sliderBreaks > 0 ? `${play.hits.sliderBreaks}xSB` : "";
            activity.state = joinStateParts(h100, h50, h0, sb);

            const playRank = await getAsset(`https://raw.githubusercontent.com/AutumnVN/gosu-rich-presence/main/grade/${play.rank.current.toLowerCase().replace("x", "ss")}.png`);
            assets.small_image = playRank;
            assets.small_text = undefined;
            break;
        }
        case GameState.ResultScreen: {
            activity.type = ActivityType.WATCHING;

            mods = resultsScreen.mods.name ? `+${resultsScreen.mods.name} ` : "";
            activity.name = `${resultsScreen.playerName} | ${beatmap.artist} - ${beatmap.title} [${beatmap.version}] ${mods}(${beatmap.mapper}, ${beatmap.stats.stars.total.toFixed(2)}*)`;

            fc = resultsScreen.maxCombo === beatmap.stats.maxCombo ? "FC" : `| ${resultsScreen.maxCombo}x/${beatmap.stats.maxCombo}x`;
            pp = !resultsScreen.pp.current ? ""
                : Math.round(resultsScreen.pp.current) === Math.round(resultsScreen.pp.fc)
                    ? `| ${Math.round(resultsScreen.pp.current)}pp`
                    : `| ${Math.round(resultsScreen.pp.current)}pp/${Math.round(resultsScreen.pp.fc)}pp`;
            activity.details = `${resultsScreen.accuracy.toFixed(2)}% ${fc} ${pp}`;

            h100 = resultsScreen.hits[100] > 0 ? `${resultsScreen.hits[100]}x100` : "";
            h50 = resultsScreen.hits[50] > 0 ? `${resultsScreen.hits[50]}x50` : "";
            h0 = resultsScreen.hits[0] > 0 ? `${resultsScreen.hits[0]}xMiss` : "";
            activity.state = joinStateParts(h100, h50, h0);

            const resultRank = await getAsset(`https://raw.githubusercontent.com/AutumnVN/gosu-rich-presence/main/grade/${resultsScreen.rank.toLowerCase().replace("x", "ss")}.png`);
            assets.small_image = resultRank;
            assets.small_text = undefined;
            break;
        }
        default: {
            activity.type = ActivityType.LISTENING;
            mods = play.mods.name ? `+${play.mods.name} ` : "";
            activity.name = `${beatmap.artist} - ${beatmap.title} [${beatmap.version}] ${mods}(${beatmap.mapper}, ${beatmap.stats.stars.total.toFixed(2)}*)`;

            switch (state.number) {
                case GameState.Menu: activity.details = "Main Menu"; break;
                case GameState.Edit: activity.details = "Edit"; break;
                case GameState.SelectEdit: activity.details = "Song Select (Edit)"; break;
                case GameState.SelectPlay: activity.details = "Song Select (Play)"; break;
                case GameState.SelectDrawings: activity.details = "Select Drawings"; break;
                case GameState.Update: activity.details = "Update"; break;
                case GameState.Busy: activity.details = "Busy"; break;
                case GameState.Lobby: activity.details = "Lobby"; break;
                case GameState.MatchSetup: activity.details = "Match Setup"; break;
                case GameState.SelectMulti: activity.details = "Select Multi"; break;
                case GameState.RankingVs: activity.details = "Ranking Vs"; break;
                case GameState.OnlineSelection: activity.details = "Online Selection"; break;
                case GameState.OptionsOffsetWizard: activity.details = "Options Offset Wizard"; break;
                case GameState.RankingTagCoop: activity.details = "Ranking Tag Coop"; break;
                case GameState.RankingTeam: activity.details = "Ranking Team"; break;
                case GameState.BeatmapImport: activity.details = "Beatmap Import"; break;
                case GameState.PackageUpdater: activity.details = "Package Updater"; break;
                case GameState.Benchmark: activity.details = "Benchmark"; break;
                case GameState.Tourney: activity.details = "Tourney"; break;
                case GameState.Charts: activity.details = "Charts"; break;
            }

            switch (profile.banchoStatus.number) {
                case BanchoStatusEnum.Idle: activity.state = "Idle"; break;
                case BanchoStatusEnum.Afk: activity.state = "AFK"; break;
                case BanchoStatusEnum.Playing: activity.state = "Playing"; break;
                case BanchoStatusEnum.Editing: activity.state = "Editing"; break;
                case BanchoStatusEnum.Modding: activity.state = "Modding"; break;
                case BanchoStatusEnum.Multiplayer: activity.state = "Multiplayer"; break;
                case BanchoStatusEnum.Watching: activity.state = "Watching"; break;
                case BanchoStatusEnum.Testing: activity.state = "Testing"; break;
                case BanchoStatusEnum.Submitting: activity.state = "Submitting"; break;
                case BanchoStatusEnum.Paused: activity.state = "Paused"; break;
                case BanchoStatusEnum.Lobby: activity.state = "Lobby"; break;
                case BanchoStatusEnum.Multiplaying: activity.state = "Multiplaying"; break;
                case BanchoStatusEnum.OsuDirect: activity.state = "osu!direct"; break;
            }
            break;
        }
    }

    if (beatmap.set > 0) {
        const mapBg = await getBeatmapCover(beatmap.set);
        if (!shouldReconnect || generation !== connectionGeneration) return;
        if (mapBg) assets.large_image = mapBg;
    }

    if (shouldReconnect && generation === connectionGeneration) {
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
    }
}

export function start() {
    stop();
    shouldReconnect = true;
    const generation = ++connectionGeneration;

    (function connect() {
        if (!shouldReconnect || generation !== connectionGeneration) return;

        const socket = new WebSocket("ws://127.0.0.1:24050/websocket/v2");
        ws = socket;

        socket.addEventListener("error", () => socket.close());
        socket.addEventListener("close", () => {
            if (!shouldReconnect || generation !== connectionGeneration) return;
            wsReconnect = setTimeout(connect, 5000);
        });
        socket.addEventListener("message", ({ data }) => throttledOnMessage(data, generation));
    })();
}

export function stop() {
    shouldReconnect = false;
    connectionGeneration++;
    clearRuntimeTimeouts();
    ws?.close();
    ws = undefined;
    beatmapCoverCache.clear();
    clearActivity();
}
