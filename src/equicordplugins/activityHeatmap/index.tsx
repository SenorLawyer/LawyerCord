/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { Menu, Modal, openModal, Text } from "@webpack/common";

interface MessageCreateEvent {
    optimistic?: boolean;
    message?: {
        author?: { id?: string; };
        channel_id?: string;
        guild_id?: string;
        timestamp?: string;
    };
}

const settings = definePluginSettings({}).withPrivateSettings<{
    guildIds?: string[];
    channelIds?: string[];
    userIds?: string[];
    buckets?: Record<string, number>;
}>();

let pendingBuckets: Record<string, number> = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function toggle(values: string[] | undefined, value: string) {
    const current = values ?? [];
    return current.includes(value) ? current.filter(id => id !== value) : [...current, value];
}

function flushBuckets() {
    if (!Object.keys(pendingBuckets).length) return;
    settings.store.buckets = { ...settings.store.buckets, ...pendingBuckets };
    pendingBuckets = {};
    if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }
}

function trackMessage({ optimistic, message }: MessageCreateEvent) {
    if (optimistic || !message?.channel_id || !message.author?.id) return;
    const matchesGuild = message.guild_id && settings.store.guildIds?.includes(message.guild_id);
    const matchesChannel = settings.store.channelIds?.includes(message.channel_id);
    const matchesUser = settings.store.userIds?.includes(message.author.id);
    if (!matchesGuild && !matchesChannel && !matchesUser) return;

    const date = new Date(message.timestamp ?? Date.now());
    const key = `${date.toISOString().slice(0, 10)}:${date.getHours()}`;
    pendingBuckets[key] = (pendingBuckets[key] ?? settings.store.buckets?.[key] ?? 0) + 1;
    if (saveTimer === undefined) saveTimer = setTimeout(flushBuckets, 5_000);
}

function HeatmapModal(props: RenderModalProps) {
    flushBuckets();
    const buckets = settings.store.buckets ?? {};
    const days = Array.from({ length: 28 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - 27 + index);
        return date.toISOString().slice(0, 10);
    });
    const max = Math.max(1, ...Object.values(buckets));

    return <Modal {...props} size="large" title="Activity heatmap">
        <Text variant="text-sm/normal">Tracks new messages only. Add servers, channels, or people from their context menus.</Text>
        <div className="vc-activity-heatmap-grid">
            {days.flatMap(day => Array.from({ length: 24 }, (_, hour) => {
                const count = buckets[`${day}:${hour}`] ?? 0;
                return <div key={`${day}:${hour}`} title={`${day} ${hour.toString().padStart(2, "0")}:00 · ${count} messages`} className="vc-activity-heatmap-cell" data-level={Math.ceil(count / max * 4)} />;
            }))}
        </div>
        <Text variant="text-xs/normal">{settings.store.guildIds?.length ?? 0} servers · {settings.store.channelIds?.length ?? 0} channels · {settings.store.userIds?.length ?? 0} people tracked</Text>
    </Modal>;
}

function toggleItem(label: string, checked: boolean, action: () => void) {
    return <Menu.MenuCheckboxItem id={`activity-heatmap-${label}`} label={label} checked={checked} action={action} />;
}

export default definePlugin({
    name: "ActivityHeatmap",
    description: "Shows a local hourly heatmap for selected servers, channels, and people.",
    authors: [EquicordDevs.SenorLawyer],
    tags: ["Utility"],
    settings,
    toolboxActions: {
        "Open Activity Heatmap": () => openModal(props => <HeatmapModal {...props} />),
    },
    flux: {
        MESSAGE_CREATE: trackMessage,
    },
    contextMenus: {
        "guild-context": (children, props) => {
            const guildId = String(props.guild?.id ?? "");
            if (!guildId) return;
            findGroupChildrenByChildId("leave-guild", children, true)?.push(toggleItem("Track server activity", settings.store.guildIds?.includes(guildId) ?? false, () => {
                settings.store.guildIds = toggle(settings.store.guildIds, guildId);
            }));
        },
        "channel-context": (children, props) => {
            const channelId = String(props.channel?.id ?? "");
            if (!channelId) return;
            findGroupChildrenByChildId("mute-channel", children, true)?.push(toggleItem("Track channel activity", settings.store.channelIds?.includes(channelId) ?? false, () => {
                settings.store.channelIds = toggle(settings.store.channelIds, channelId);
            }));
        },
        "user-context": (children, props) => {
            const userId = String(props.user?.id ?? "");
            if (!userId) return;
            findGroupChildrenByChildId("close-dm", children, true)?.push(toggleItem("Track this person's activity", settings.store.userIds?.includes(userId) ?? false, () => {
                settings.store.userIds = toggle(settings.store.userIds, userId);
            }));
        },
    },
    stop() {
        flushBuckets();
    },
});
