/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message, MessageJSON } from "@vencord/discord-types";

export interface DiscordMessageCreateEvent {
    optimistic?: boolean;
    type?: string;
    message: Message | MessageJSON;
}

export interface ControlPanelUser {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
}

export interface ControlPanelGuild {
    id: string;
    name: string;
    iconUrl: string | null;
    memberCount: number;
    channelCount: number;
}

export interface ControlPanelChannel {
    id: string;
    guildId: string | null;
    name: string;
    type: number;
    guildName: string | null;
}

export interface ControlPanelPlugin {
    name: string;
    description: string;
    enabled: boolean;
    required: boolean;
    dependencies: string[];
    settingsCount: number;
}

export interface ControlPanelSnapshot {
    capturedAt: string;
    user: ControlPanelUser | null;
    guilds: ControlPanelGuild[];
    channels: ControlPanelChannel[];
    directMessageCount: number;
    friendCount: number;
    blockedCount: number;
    plugins: ControlPanelPlugin[];
    secureMessaging: {
        enabled: boolean;
        protocol: string;
        deviceVerification: boolean;
        forwardSecrecy: boolean;
        migrationStatus: string;
    };
}

export interface IndexedDiscordMessage {
    id: string;
    channelId: string;
    guildId: string | null;
    channelName: string;
    guildName: string | null;
    authorId: string;
    authorName: string;
    content: string;
    timestamp: string;
    editedTimestamp: string | null;
    attachmentCount: number;
    embedCount: number;
    jumpUrl: string;
}

export interface PrivacyInventoryEntry {
    name: string;
    externalDomains: string[];
    storage: string[];
    permissions: string[];
}
