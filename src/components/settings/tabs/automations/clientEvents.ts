/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FluxEvents } from "@vencord/discord-types";

export const CLIENT_EVENT_TYPES = ["presence-update", "typing-start", "channel-select", "user-update", "member-update", "relationship-add", "relationship-remove"] as const;
export type ClientEventType = typeof CLIENT_EVENT_TYPES[number];

export const CLIENT_EVENTS: Record<ClientEventType, { event: FluxEvents; label: string; description: string; channel: boolean; user: boolean; }> = {
    "presence-update": { event: "PRESENCE_UPDATES", label: "Presence updated", description: "A visible user's status or activities are updated. Discord only supplies presence for users this client can see.", channel: false, user: true },
    "typing-start": { event: "TYPING_START", label: "Someone starts typing", description: "Discord reports typing in a channel.", channel: true, user: true },
    "channel-select": { event: "CHANNEL_SELECT", label: "Channel opened", description: "You open a channel in this client.", channel: true, user: false },
    "user-update": { event: "USER_UPDATE", label: "User updated", description: "Discord updates a user's account details.", channel: false, user: true },
    "member-update": { event: "GUILD_MEMBER_UPDATE", label: "Server member updated", description: "Discord updates a member's nickname or roles.", channel: false, user: true },
    "relationship-add": { event: "RELATIONSHIP_ADD", label: "Relationship added or changed", description: "A friend request, friendship, or blocked relationship is added or changed.", channel: false, user: true },
    "relationship-remove": { event: "RELATIONSHIP_REMOVE", label: "Relationship removed", description: "A friendship, friend request, or blocked relationship is removed.", channel: false, user: true },
};

export function isClientEventType(value: unknown): value is ClientEventType {
    return CLIENT_EVENT_TYPES.some(type => type === value);
}
