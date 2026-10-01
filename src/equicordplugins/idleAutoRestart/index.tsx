/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, VoiceStateStore } from "@webpack/common";

const logger = new Logger("IdleAutoRestart");
const activityThrottleMs = 1_000;
const maxTimeoutMs = 2_147_483_647;

let active = false;
let lastActivity = 0;
let lastActivityUpdate = 0;
let restartTimeoutId: ReturnType<typeof setTimeout> | null = null;
let activityListenersAttached = false;

function clearRestartTimer() {
    if (restartTimeoutId === null) return;

    clearTimeout(restartTimeoutId);
    restartTimeoutId = null;
}

function getIdleMs() {
    return Math.max(settings.store.idleMinutes, 1) * 60_000;
}

function scheduleRestartCheck(delay = getIdleMs() - (Date.now() - lastActivity)) {
    clearRestartTimer();
    if (!active || !settings.store.isEnabled || VoiceStateStore.isCurrentClientInVoiceChannel()) return;

    restartTimeoutId = setTimeout(checkIdleTimeout, Math.min(Math.max(delay, 0), maxTimeoutMs));
}

function checkIdleTimeout() {
    restartTimeoutId = null;
    if (!active || !settings.store.isEnabled || VoiceStateStore.isCurrentClientInVoiceChannel()) return;

    if (Date.now() - lastActivity < getIdleMs()) {
        scheduleRestartCheck();
        return;
    }

    logger.info("Idle timeout reached, reloading client");
    location.reload();
}

function resetIdleTimer() {
    lastActivity = Date.now();
    lastActivityUpdate = lastActivity;
    scheduleRestartCheck();
}

function attachActivityListeners() {
    if (activityListenersAttached) return;

    document.addEventListener("mousemove", onActivity);
    document.addEventListener("keydown", onActivity);
    document.addEventListener("mousedown", onActivity);
    document.addEventListener("wheel", onActivity, { passive: true });
    activityListenersAttached = true;
}

function detachActivityListeners() {
    if (!activityListenersAttached) return;

    document.removeEventListener("mousemove", onActivity);
    document.removeEventListener("keydown", onActivity);
    document.removeEventListener("mousedown", onActivity);
    document.removeEventListener("wheel", onActivity);
    activityListenersAttached = false;
}

function applyEnabledState(enabled: boolean) {
    if (!active) return;
    if (enabled) {
        attachActivityListeners();
        resetIdleTimer();
    } else {
        clearRestartTimer();
        detachActivityListeners();
    }
}

function onVoiceChange() {
    if (VoiceStateStore.isCurrentClientInVoiceChannel()) clearRestartTimer();
    else if (restartTimeoutId === null) scheduleRestartCheck();
}

const settings = definePluginSettings({
    isEnabled: {
        description: "Enable automatic restart after idle",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: enabled => {
            applyEnabledState(enabled);
        },
    },
    idleMinutes: {
        description: "Minutes of inactivity before restarting (when not in VC)",
        type: OptionType.SLIDER,
        markers: [5, 10, 15, 30, 60, 120],
        default: 30,
        stickToMarkers: false,
        onChange: () => {
            if (settings.store.isEnabled) scheduleRestartCheck();
        },
    },
});

function onActivity() {
    const now = Date.now();
    if (now - lastActivityUpdate < activityThrottleMs) return;

    lastActivity = now;
    lastActivityUpdate = now;
    scheduleRestartCheck();
}

export default definePlugin({
    name: "IdleAutoRestart",
    description: "Automatically restarts the client after being idle for a configurable amount of time, but avoids restarting while you are in VC.",
    tags: ["Utility"],
    authors: [EquicordDevs.SteelTech],
    settings,

    toolboxActions() {
        return (
            <Menu.MenuItem
                id="auto-idle-restart-toggle-toolbox"
                label={settings.store.isEnabled ? "Disable Auto Idle Restart" : "Enable Auto Idle Restart"}
                action={() => {
                    settings.store.isEnabled = !settings.store.isEnabled;
                }}
            />
        );
    },

    start() {
        active = true;
        VoiceStateStore.addChangeListener(onVoiceChange);
        if (settings.store.isEnabled) applyEnabledState(true);
    },

    stop() {
        active = false;
        VoiceStateStore.removeChangeListener(onVoiceChange);
        clearRestartTimer();
        detachActivityListeners();
    },
});
