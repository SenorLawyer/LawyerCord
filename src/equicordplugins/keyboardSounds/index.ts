/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AudioPlayerInterface, createAudioPlayer } from "@api/AudioPlayer";
import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

import { ignoredKeys, packs } from "./packs";

type SoundEntry = { playing: boolean; player: AudioPlayerInterface; };

const allSounds = {
    backspaces: [] as SoundEntry[],
    caps: [] as SoundEntry[],
    enters: [] as SoundEntry[],
    arrows: [] as SoundEntry[],
    others: [] as SoundEntry[]
};

let chosenPack: typeof packs[keyof typeof packs];
let started = false;
let allowedIgnoredKeys = new Set<string>();
const keysCurrentlyPressed = new Set<string>();
const arrowKeys = new Set(["ArrowUp", "ArrowRight", "ArrowLeft", "ArrowDown"]);
const ignoredKeysSet = new Set(ignoredKeys);

const keyup = (e: KeyboardEvent) => { keysCurrentlyPressed.delete(e.code); };
const blur = () => { keysCurrentlyPressed.clear(); };

function getRandomSound(soundsArray: SoundEntry[]) {
    if (!soundsArray.length) return;

    const startIndex = Math.floor(Math.random() * soundsArray.length);
    let chosenSound = soundsArray[startIndex];

    for (let offset = 0; offset < soundsArray.length; offset++) {
        const sound = soundsArray[(startIndex + offset) % soundsArray.length];
        if (!sound.playing) {
            chosenSound = sound;
            break;
        }
    }

    chosenSound.playing = true;
    chosenSound.player.restart();
}

const keydown = (e: KeyboardEvent) => {
    if (!chosenPack) return;
    if (ignoredKeysSet.has(e.code) && !allowedIgnoredKeys.has(e.key)) return;
    if (keysCurrentlyPressed.has(e.code)) return;
    keysCurrentlyPressed.add(e.code);

    if (e.code === "Backspace" && allSounds.backspaces.length) {
        getRandomSound(allSounds.backspaces);
    } else if (e.code === "CapsLock" && allSounds.caps.length) {
        getRandomSound(allSounds.caps);
    } else if (e.code === "Enter" && allSounds.enters.length) {
        getRandomSound(allSounds.enters);
    } else if (arrowKeys.has(e.code) && allSounds.arrows.length) {
        getRandomSound(allSounds.arrows);
    } else if (allSounds.others.length) {
        getRandomSound(allSounds.others);
    }
};

function clearSounds() {
    for (const soundsArray of Object.values(allSounds)) {
        for (const sound of soundsArray) {
            sound.player.delete();
        }
        soundsArray.length = 0;
    }
}

function assignSounds(volume: number, pack: "operagx" | "osu") {
    clearSounds();
    chosenPack = packs[pack];
    allowedIgnoredKeys = new Set(chosenPack?.allowedIgnored ?? []);

    if (!chosenPack) {
        return;
    }

    function addSounds(key: keyof typeof allSounds) {
        if (!chosenPack[key]) return;

        for (let i = 0; i < 3; i++) {
            for (const url of chosenPack[key]) {
                const soundEntry: SoundEntry = {
                    playing: false,
                    player: createAudioPlayer(url, {
                        volume,
                        preload: true,
                        persistent: true,
                        onEnded: () => { soundEntry.playing = false; }
                    })
                };
                allSounds[key].push(soundEntry);
            }
        }
    }

    chosenPack.backspaces && addSounds("backspaces");
    chosenPack.caps && addSounds("caps");
    chosenPack.enters && addSounds("enters");
    chosenPack.arrows && addSounds("arrows");
    chosenPack.others && addSounds("others");
}

const settings = definePluginSettings({
    volume: {
        description: "Volume of the keyboard sounds.",
        type: OptionType.SLIDER,
        markers: [0, 25, 50, 75, 100],
        stickToMarkers: false,
        default: 100,
        onChange: value => {
            for (const sounds of Object.values(allSounds)) {
                for (const sound of sounds) sound.player.volume = value;
            }
        }
    },
    soundPack: {
        description: "Sound pack to use.",
        type: OptionType.SELECT,
        options: [
            { label: "OperaGX", value: "operagx" as "operagx", default: true },
            { label: "osu!", value: "osu" as "osu" }
        ],
        onChange: value => {
            if (started) assignSounds(settings.store.volume, value);
        }
    }
});

export default definePlugin({
    name: "KeyboardSounds",
    description: "Adds OperaGX or osu! sound effects when typing on your keyboard.",
    tags: ["Fun"],
    authors: [Devs.HypedDomi, EquicordDevs.Etorix],
    dependencies: ["AudioPlayerAPI"],
    settings,
    start() {
        started = true;
        assignSounds(settings.store.volume, settings.store.soundPack);
        document.addEventListener("keyup", keyup);
        document.addEventListener("keydown", keydown);
        window.addEventListener("blur", blur);
    },
    stop: () => {
        started = false;
        clearSounds();
        keysCurrentlyPressed.clear();
        document.removeEventListener("keyup", keyup);
        document.removeEventListener("keydown", keydown);
        window.removeEventListener("blur", blur);
    },
});
