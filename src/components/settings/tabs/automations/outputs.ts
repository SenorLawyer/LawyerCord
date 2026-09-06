/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { outputKind } from "./catalog";
import { CLIENT_EVENTS, type ClientEventType } from "./clientEvents";
import type { AutomationBlockType } from "./model";

export interface OutputField {
    path: string;
    type: string;
    description: string;
}

const USER: OutputField[] = [
    { path: "id", type: "text", description: "Discord user ID." },
    { path: "username", type: "text", description: "Account username." },
    { path: "discriminator", type: "text or absent", description: "Legacy username suffix. Modern usernames use 0." },
    { path: "global_name", type: "text or null", description: "Display name, when set." },
    { path: "displayName", type: "text", description: "Display name with username as fallback." },
    { path: "bot", type: "boolean", description: "Whether this is a bot account." },
    { path: "avatar", type: "text or null", description: "Avatar hash, not an image URL." },
    { path: "banner", type: "text or null or absent", description: "Banner hash, when this client has loaded it." },
    { path: "accent_color", type: "number or null or absent", description: "Profile accent color, when supplied." },
    { path: "public_flags", type: "number or absent", description: "Discord's public account badge flags." },
];
const PRESENCE: OutputField[] = [
    { path: "status", type: "text", description: "online, idle, dnd, or offline. Invisible users appear offline." },
    { path: "activities", type: "list", description: "Activities visible to this client. Empty when none are available." },
    { path: "activities.0.name", type: "text or absent", description: "First activity's name, such as a game or Spotify." },
    { path: "activities.0.details", type: "text or absent", description: "Details supplied by the activity." },
    { path: "activities.0.state", type: "text or absent", description: "Activity state or custom status text." },
    { path: "clientStatus", type: "object", description: "Status by connected device, when Discord supplies it." },
    { path: "clientStatus.mobile", type: "text or absent", description: "Mobile connection status." },
];
const MESSAGE: OutputField[] = [
    { path: "id", type: "text", description: "Message ID." },
    { path: "channel_id", type: "text", description: "Channel containing the message." },
    { path: "guild_id", type: "text or absent", description: "Server ID. Absent for DMs." },
    { path: "content", type: "text", description: "Message text." },
    { path: "author.id", type: "text", description: "Author's Discord user ID." },
    { path: "author.bot", type: "boolean or absent", description: "Whether the author is a bot." },
    { path: "embeds", type: "list", description: "Attached embeds." },
    { path: "components", type: "list", description: "Message buttons, menus, and other components." },
];
const CHANNEL: OutputField[] = [
    { path: "id", type: "text", description: "Channel ID." },
    { path: "name", type: "text", description: "Channel name." },
    { path: "type", type: "number", description: "Discord channel type, such as 0 for text or 2 for voice." },
    { path: "guild_id", type: "text or null", description: "Server ID, or null for a private channel." },
];
export const CLIENT_EVENT_FIELDS: OutputField[] = [
    { path: "type", type: "text", description: "Discord event name." },
    { path: "userId", type: "text", description: "User involved, or empty for channel selection." },
    { path: "channelId", type: "text", description: "Channel involved, when supplied." },
    { path: "guildId", type: "text", description: "Server involved, when supplied." },
    ...PRESENCE,
    { path: "nick", type: "text or null", description: "Nickname supplied by a member update." },
    { path: "roles", type: "list", description: "Role IDs supplied by a member update." },
    { path: "relationshipType", type: "number or null", description: "1 friend, 2 blocked, 3 incoming request, 4 outgoing request." },
];

export function eventOutputFields(type: ClientEventType): OutputField[] {
    const definition = CLIENT_EVENTS[type];
    if (type === "user-update") return [CLIENT_EVENT_FIELDS[0], CLIENT_EVENT_FIELDS[1], ...USER.filter(field => field.path !== "displayName").map(field => ({ ...field, path: `user.${field.path}`, type: `${field.type} or absent` }))];
    return CLIENT_EVENT_FIELDS.filter(field => field.path === "type"
        || definition.user && field.path === "userId"
        || definition.channel && ["channelId", "guildId"].includes(field.path)
        || type === "member-update" && ["guildId", "nick", "roles"].includes(field.path)
        || type.startsWith("relationship-") && field.path === "relationshipType"
        || type === "presence-update" && PRESENCE.some(presence => presence.path === field.path));
}

export function outputFields(type: AutomationBlockType, eventType?: ClientEventType): OutputField[] {
    switch (type) {
        case "get-user": return [...USER, ...PRESENCE];
        case "get-presence": return [{ path: "userId", type: "text", description: "User whose presence was read." }, ...PRESENCE];
        case "wait-presence": return eventOutputFields("presence-update");
        case "wait-client-event": return eventOutputFields(eventType ?? "presence-update");
        case "get-channel": case "get-selected-channel": return CHANNEL;
        case "get-member": return [
            { path: "userId", type: "text", description: "Member's user ID." },
            { path: "guildId", type: "text", description: "Server ID." },
            { path: "nick", type: "text or null", description: "Server nickname, when set." },
            { path: "roles", type: "list", description: "Member's role IDs." },
        ];
        case "fetch-messages": case "fetch-dm": case "fetch-mentions": case "fetch-unread": case "search-messages":
            return [{ path: "length", type: "number", description: "Number of messages found. May be zero." }, ...MESSAGE.map(field => ({ ...field, path: `0.${field.path}`, description: `First message: ${field.description}` }))];
        default:
            if (outputKind(type) === "message") return MESSAGE;
            if (outputKind(type) === "list") return [{ path: "length", type: "number", description: "Number of items." }, { path: "0", type: "value or absent", description: "First item. Use For each item to process the whole list." }];
            return [];
    }
}
