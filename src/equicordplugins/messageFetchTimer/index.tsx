/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { proxyLazy } from "@utils/lazy";
import definePlugin, { OptionType } from "@utils/types";
import { moment, React, zustandCreate } from "@webpack/common";

const pendingFetches = new Map<string, number>();
const useTimings = proxyLazy(() => zustandCreate((): Map<string, { time: number; timestamp: Date; }> => new Map()));
const TIMING_SETTINGS = ["showIcon", "showMs", "iconColor"] satisfies (keyof typeof settings.store)[];

const settings = definePluginSettings({
    showIcon: {
        type: OptionType.BOOLEAN,
        description: "Show fetch time icon in message bar",
        default: true,
    },
    showMs: {
        type: OptionType.BOOLEAN,
        description: "Show milliseconds in timing",
        default: true,
    },
    iconColor: {
        type: OptionType.STRING,
        description: "Icon color (CSS color value)",
        default: "#00d166",
    }
});

const FetchTimeButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const { showIcon, showMs, iconColor } = settings.use(TIMING_SETTINGS);
    const timing = useTimings((timings: Map<string, { time: number; timestamp: Date; }>) => timings.get(channel.id));
    if (!isMainChat || !showIcon || !timing) return null;

    const display = Math.round(timing.time / (showMs ? 1 : 1000));
    if (!showMs && display === 0) return null;
    return (
        <ChatBarButton onClick={() => { }} tooltip={`Messages loaded in ${Math.round(timing.time)}ms (${moment(timing.timestamp).fromNow()})`}>
            <FetchTimeIcon />
            <span style={{ color: iconColor }}>{display}{showMs ? "ms" : "s"}</span>
        </ChatBarButton>
    );
};

function FetchTimeIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z" />
        </svg>
    );
}

function clearTimings() {
    pendingFetches.clear();
    useTimings.setState(new Map(), true);
}

export default definePlugin({
    name: "MessageFetchTimer",
    performance: { impact: "low", description: "Records message fetch durations and retains the latest fifty channels." },
    description: "Shows how long it took to fetch messages for the current channel.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.GroupXyz],
    settings,
    chatBarButton: {
        icon: FetchTimeIcon,
        render: props => <ErrorBoundary noop><FetchTimeButton {...props} /></ErrorBoundary>
    },
    flux: {
        LOAD_MESSAGES({ channelId }: { channelId: string; }) {
            pendingFetches.set(channelId, performance.now());
        },
        LOAD_MESSAGES_SUCCESS({ channelId }: { channelId: string; }) {
            const start = pendingFetches.get(channelId);
            pendingFetches.delete(channelId);
            if (start === undefined) return;
            const time = performance.now() - start;
            if (time > 60_000) return;
            const timings = new Map(useTimings.getState());
            timings.delete(channelId);
            timings.set(channelId, { time, timestamp: new Date() });
            if (timings.size > 50) timings.delete(timings.keys().next().value);
            useTimings.setState(timings, true);
        },
        LOAD_MESSAGES_FAILURE({ channelId }: { channelId: string; }) {
            pendingFetches.delete(channelId);
        },
        LOGOUT: clearTimings,
        CONNECTION_OPEN: clearTimings
    },
    stop: clearTimings
});
