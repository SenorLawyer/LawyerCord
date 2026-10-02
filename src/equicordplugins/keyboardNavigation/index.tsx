/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { closeAllModals,SettingsRouter, useEffect, useState } from "@webpack/common";

import { registerAction } from "./commands";
import { openCommandPalette } from "./components/CommandPalette";

const cl = classNameFactory("vc-command-palette-");
let isRecordingGlobal: boolean = false;
let cancelRecording: (() => void) | undefined;

const modifiers = {
    control: "ctrlKey",
    shift: "shiftKey",
    alt: "altKey",
    meta: "metaKey"
} as const;

function isModifierKey(key: string): key is keyof typeof modifiers {
    return key in modifiers;
}

function formatHotkeyLabel(hotkey: readonly string[]): string {
    let label = "";
    for (const word of hotkey) {
        if (label) label += " + ";
        label += word.charAt(0).toUpperCase() + word.slice(1);
    }

    return label;
}

export const settings = definePluginSettings({
    hotkey: {
        description: "The hotkey to open the command palette.",
        type: OptionType.COMPONENT,
        default: ["Control", "Shift", "P"],
        component: () => {
            const [isRecording, setIsRecording] = useState(false);
            useEffect(() => () => cancelRecording?.(), []);

            const recordKeybind = (setIsRecording: (value: boolean) => void) => {
                if (isRecordingGlobal) return;
                const keys: Set<string> = new Set();
                let longest: string[] = [];

                setIsRecording(true);
                isRecordingGlobal = true;

                const keydownListener = (e: KeyboardEvent) => {
                    const { key } = e;
                    if (!keys.has(key)) {
                        keys.add(key);
                    }
                    if (keys.size > longest.length) longest = Array.from(keys);
                };

                const keyupListener = (e: KeyboardEvent) => {
                    keys.delete(e.key);
                    if (keys.size) return;
                    cancelRecording?.();
                    if (longest.length) settings.store.hotkey = longest.map(key => key.toLowerCase());
                };

                cancelRecording = () => {
                    document.removeEventListener("keydown", keydownListener);
                    document.removeEventListener("keyup", keyupListener);
                    isRecordingGlobal = false;
                    cancelRecording = undefined;
                    setIsRecording(false);
                };
                document.addEventListener("keydown", keydownListener);
                document.addEventListener("keyup", keyupListener);
            };

            return (
                <>
                    <div className={cl("key-recorder-container")} onClick={() => recordKeybind(setIsRecording)}>
                        <div className={`${cl("key-recorder")} ${isRecording ? cl("recording") : ""}`}>
                            {formatHotkeyLabel(settings.store.hotkey)}
                            <button className={`${cl("key-recorder-button")} ${isRecording ? cl("recording-button") : ""}`} disabled={isRecording}>
                                {isRecording ? "Recording..." : "Record keybind"}
                            </button>
                        </div>
                    </div>
                </>
            );
        }
    },
    allowMouseControl: {
        description: "Allow the mouse to control the command palette.",
        type: OptionType.BOOLEAN,
        default: true
    }
});

export default definePlugin({
    name: "KeyboardNavigation",
    description: "Allows you to navigate the UI with a keyboard.",
    tags: ["Accessibility", "Shortcuts"],
    authors: [Devs.Ethan],
    settings,

    start() {
        document.addEventListener("keydown", this.event);

        if (IS_DEV) {
            registerAction({
                id: "openDevSettings",
                label: "Open Dev tab",
                callback: () => SettingsRouter.openUserSettings("equicord_patch_helper_panel"),
                registrar: "LawyerCord"
            });
        }
    },

    stop() {
        cancelRecording?.();
        document.removeEventListener("keydown", this.event);
    },

    event(e: KeyboardEvent) {
        if (isRecordingGlobal) return;

        const { hotkey } = settings.store;
        const pressedKey = e.key.toLowerCase();

        for (let i = 0; i < hotkey.length; i++) {
            const lowercasedRequiredKey = hotkey[i].toLowerCase();

            if (isModifierKey(lowercasedRequiredKey) && !e[modifiers[lowercasedRequiredKey]]) {
                return;
            }

            if (!isModifierKey(lowercasedRequiredKey) && pressedKey !== lowercasedRequiredKey) {
                return;
            }
        }

        closeAllModals();

        if (document.querySelector(`.${cl("root")}`)) return;

        openCommandPalette();
    }
});
