/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const Millis = {
    SECOND: 1e3,
    MINUTE: 6e4,
    HOUR: 36e5,
    DAY: 864e5,
    WEEK: 6048e5,
    DAYS_30: 2592e6
};

interface TimeoutOption {
    duration?: number;
    label: () => string;
}

let cachedExtraTimeouts: TimeoutOption[] | null = null;

function parseDurations(value: string): number[] {
    return value.split(",")
        .map(s => Number(s.trim()))
        .filter(value => Number.isFinite(value) && value > 0);
}

function invalidateTimeoutCache() {
    cachedExtraTimeouts = null;
}

function makeTimeout(value: number, millis: number, singular: string): Required<TimeoutOption> {
    return {
        duration: value * millis,
        label: () => `For ${value} ${value === 1 ? singular : `${singular}s`}`
    };
}

function getExtraTimeouts(): TimeoutOption[] {
    if (cachedExtraTimeouts) return cachedExtraTimeouts;

    const seconds = parseDurations(settings.store.extraSeconds);
    const minutes = parseDurations(settings.store.extraMinutes);
    const hours = parseDurations(settings.store.extraHours);
    const days = parseDurations(settings.store.extraDays);

    cachedExtraTimeouts = [
        ...seconds.map(s => makeTimeout(s, Millis.SECOND, "Second")),
        ...minutes.map(m => makeTimeout(m, Millis.MINUTE, "Minute")),
        ...hours.map(h => makeTimeout(h, Millis.HOUR, "Hour")),
        ...days.map(d => makeTimeout(d, Millis.DAY, "Day")),
        ...[1, 2, 3].map(w => makeTimeout(w, Millis.WEEK, "Week")),
        ...[2, 4].map(m => makeTimeout(m, Millis.DAYS_30, "Month")),
    ].filter(({ duration }) => Number.isSafeInteger(duration) && duration > 0 && Number.isFinite(new Date(Date.now() + duration).getTime()));

    return cachedExtraTimeouts;
}

const settings = definePluginSettings({
    showForeverOnTop: {
        type: OptionType.BOOLEAN,
        description: "Show the Forever option at the top of the list instead of the bottom.",
        default: true
    },
    extraSeconds: {
        type: OptionType.STRING,
        description: "Extra seconds to add, separated by a comma (e.g. 5, 10, 30)",
        onChange: invalidateTimeoutCache,
        default: "15, 30, 45"
    },
    extraMinutes: {
        type: OptionType.STRING,
        description: "Extra minutes to add, separated by a comma (e.g. 5, 10, 30)",
        onChange: invalidateTimeoutCache,
        default: "5, 10, 30"
    },
    extraHours: {
        type: OptionType.STRING,
        description: "Extra hours to add, separated by a comma (e.g. 2, 4, 6, 12)",
        onChange: invalidateTimeoutCache,
        default: "2, 4, 6, 12"
    },
    extraDays: {
        type: OptionType.STRING,
        description: "Extra days to add, separated by a comma (e.g. 1, 2)",
        onChange: invalidateTimeoutCache,
        default: "1, 2"
    },
});

export default definePlugin({
    name: "CustomStatusTimeouts",
    description: "Adds configurable timeout presets to the status (presence) menu.",
    tags: ["Activity", "Utility"],
    authors: [EquicordDevs.Kiri, EquicordDevs.thororen],
    settings,
    patches: [
        {
            find: "#{intl::DURATION_FOREVER}",
            replacement: {
                match: /\[(?:\{duration:[^{}]{0,150}\},){0,10}\{duration:[^{}]{0,150}#{intl::DURATION_FOREVER}\)\}\]/,
                replace: "$self.buildTimeouts($&)"
            }
        }
    ],
    buildTimeouts(existing: TimeoutOption[]) {
        const extra = getExtraTimeouts();

        return [...existing, ...extra].filter((option, index, options) => options.findIndex(other => other.duration === option.duration) === index).sort((a, b) => {
            if (a.duration === undefined) return settings.store.showForeverOnTop ? -1 : 1;
            if (b.duration === undefined) return settings.store.showForeverOnTop ? 1 : -1;
            return a.duration - b.duration;
        });
    },

    stop() {
        cachedExtraTimeouts = null;
    }
});
