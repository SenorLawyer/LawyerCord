/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { sleep } from "@utils/misc";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { GuildChannelStore, Menu, React, RestAPI, UserStore, VoiceStateStore } from "@webpack/common";

async function runSequential(tasks: Array<() => Promise<unknown>>): Promise<void> {
    const waitAfter = Math.max(1, settings.store.waitAfter);
    const waitMs = Math.max(0, settings.store.waitSeconds * 1000);

    for (let i = 0; i < tasks.length; i++) {
        await tasks[i]();

        if ((i + 1) % waitAfter === 0 && i < tasks.length - 1 && waitMs > 0) {
            await sleep(waitMs);
        }
    }
}

function sendPatch(channel: Channel, body: Record<string, any>, bypass = false) {
    const usersVoice = VoiceStateStore.getVoiceStatesForChannel(channel.id);
    if (!usersVoice) return;

    const myId = UserStore.getCurrentUser()?.id;
    const tasks: Array<() => Promise<unknown>> = [];

    for (const key in usersVoice) {
        const userVoice = usersVoice[key];
        if (!userVoice?.userId || (!bypass && userVoice.userId === myId)) continue;

        tasks.push(() => RestAPI.patch({
            url: `/guilds/${channel.guild_id}/members/${userVoice.userId}`,
            body
        }));
    }

    if (tasks.length === 0) return;

    runSequential(tasks).catch(error => {
        console.error("VoiceChatUtilities failed to run", error);
    });
}

function mentionVoiceUsers(channel: Channel) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channel.id);
    if (!voiceStates) return;

    const seenUserIds = new Set<string>();
    const mentions: string[] = [];

    for (const key in voiceStates) {
        const userId = voiceStates[key]?.userId;
        if (!userId || userId === currentUserId || seenUserIds.has(userId)) continue;

        seenUserIds.add(userId);
        mentions.push(`<@${userId}>`);
    }

    if (mentions.length === 0) return;
    insertTextIntoChatInputBox(`${mentions.join(" ")} `);
}

interface VoiceChannelContextProps {
    channel: Channel;
}

const VoiceChannelContext: NavContextMenuPatchCallback = (children, { channel }: VoiceChannelContextProps) => {
    // only for voice and stage channels
    if (!channel || (channel.type !== 2 && channel.type !== 13)) return;
    const userCount = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id) ?? {}).length;
    if (userCount === 0) return;

    const guildChannels: { VOCAL: { channel: Channel, comparator: number; }[]; } = GuildChannelStore.getChannels(channel.guild_id);
    const voiceChannels: Channel[] = [];
    for (const { channel: voiceChannel } of guildChannels.VOCAL ?? []) {
        if (voiceChannel.id !== channel.id) voiceChannels.push(voiceChannel);
    }

    children.splice(
        -1,
        0,
        <Menu.MenuItem
            label="Voice Tools"
            key="voice-tools"
            id="voice-tools"
        >
            <Menu.MenuItem
                key="voice-tools-mention-all"
                id="voice-tools-mention-all"
                label="Mention all Users"
                action={() => mentionVoiceUsers(channel)}
            />

            <Menu.MenuItem
                key="voice-tools-disconnect-all"
                id="voice-tools-disconnect-all"
                label="Disconnect all"
                action={() => sendPatch(channel, {
                    channel_id: null,
                })}
            />

            <Menu.MenuItem
                key="voice-tools-mute-all"
                id="voice-tools-mute-all"
                label="Mute all"
                action={() => sendPatch(channel, {
                    mute: true,
                })}
            />

            <Menu.MenuItem
                key="voice-tools-unmute-all"
                id="voice-tools-unmute-all"
                label="Unmute all"
                action={() => sendPatch(channel, {
                    mute: false,
                })}
            />

            <Menu.MenuItem
                key="voice-tools-deafen-all"
                id="voice-tools-deafen-all"
                label="Deafen all"
                action={() => sendPatch(channel, {
                    deaf: true,
                })}
            />

            <Menu.MenuItem
                key="voice-tools-undeafen-all"
                id="voice-tools-undeafen-all"
                label="Undeafen all"
                action={() => sendPatch(channel, {
                    deaf: false,
                })}
            />

            <Menu.MenuItem
                label="Move all"
                key="voice-tools-move-all"
                id="voice-tools-move-all"
            >
                {voiceChannels.map(voiceChannel => {
                    return (
                        <Menu.MenuItem
                            key={voiceChannel.id}
                            id={voiceChannel.id}
                            label={voiceChannel.name}
                            action={() => sendPatch(channel, {
                                channel_id: voiceChannel.id,
                            }, true)}
                        />
                    );
                })}

            </Menu.MenuItem>
        </Menu.MenuItem>
    );
};

const settings = definePluginSettings({
    waitAfter: {
        type: OptionType.SLIDER,
        description: "Amount of API actions to perform before waiting (to avoid rate limits)",
        default: 5,
        markers: makeRange(1, 20),
    },
    waitSeconds: {
        type: OptionType.SLIDER,
        description: "Time to wait between each action (in seconds)",
        default: 2,
        markers: makeRange(1, 10, .5),
    }
});

export default definePlugin({
    name: "VoiceChatUtilities",
    description: "This plugin allows you to perform multiple actions on an entire channel (move, mute, disconnect, etc.) (originally by dutake)",
    tags: ["Chat", "Servers", "Voice"],
    authors: [Devs.D3SOX, EquicordDevs.nickwoah],

    settings,

    contextMenus: {
        "channel-context": VoiceChannelContext
    },
});
