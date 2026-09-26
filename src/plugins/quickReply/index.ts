/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import NoBlockedMessagesPlugin from "@plugins/noBlockedMessages";
import NoReplyMentionPlugin from "@plugins/noReplyMention";
import { Devs, IS_MAC } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { ChannelStore, ComponentDispatch, FluxDispatcher as Dispatcher, MessageActions, MessageStore, MessageTypeSets, PermissionsBits, PermissionStore, RelationshipStore, SelectedChannelStore, UserStore } from "@webpack/common";

let currentlyReplyingId: string | null = null;
let currentlyEditingId: string | null = null;

const enum MentionOptions {
    DISABLED,
    ENABLED,
    NO_REPLY_MENTION_PLUGIN
}

const settings = definePluginSettings({
    shouldMention: {
        type: OptionType.SELECT,
        description: "Ping reply by default",
        options: [
            {
                label: "Follow NoReplyMention plugin (if enabled)",
                value: MentionOptions.NO_REPLY_MENTION_PLUGIN,
                default: true
            },
            { label: "Enabled", value: MentionOptions.ENABLED },
            { label: "Disabled", value: MentionOptions.DISABLED },
        ]
    },
    ignoreBlockedAndIgnored: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages by blocked/ignored users when navigating",
        default: true
    }
});

export default definePlugin({
    name: "QuickReply",
    authors: [Devs.fawn, Devs.Ven, Devs.pylix],
    description: "Reply to (ctrl + up/down) and edit (ctrl + shift + up/down) messages via keybinds",
    tags: ["Chat", "Shortcuts"],
    settings,

    start() {
        document.addEventListener("keydown", onKeydown);
    },

    stop() {
        document.removeEventListener("keydown", onKeydown);
    },

    flux: {
        DELETE_PENDING_REPLY() {
            currentlyReplyingId = null;
        },
        MESSAGE_END_EDIT() {
            currentlyEditingId = null;
        },
        CHANNEL_SELECT() {
            currentlyReplyingId = null;
            currentlyEditingId = null;
        },
        MESSAGE_START_EDIT: onStartEdit,
        CREATE_PENDING_REPLY: onCreatePendingReply
    }
});

function onStartEdit({ messageId, _isQuickEdit }: any) {
    if (_isQuickEdit) return;
    currentlyEditingId = messageId;
}

function onCreatePendingReply({ message, _isQuickReply }: { message: Message; _isQuickReply: boolean; }) {
    if (_isQuickReply) return;

    currentlyReplyingId = message.id;
}

const isCtrl = (e: KeyboardEvent) => IS_MAC ? e.metaKey : e.ctrlKey;
const isAltOrMeta = (e: KeyboardEvent) => e.altKey || (!IS_MAC && e.metaKey);

function onKeydown(e: KeyboardEvent) {
    const isUp = e.key === "ArrowUp";
    if (!isUp && e.key !== "ArrowDown") return;
    if (!isCtrl(e) || isAltOrMeta(e)) return;

    e.preventDefault();

    if (e.shiftKey)
        nextEdit(isUp);
    else
        nextReply(isUp);
}

function jumpIfOffScreen(channelId: string, messageId: string) {
    const element = document.getElementById("message-content-" + messageId);
    if (!element) return;

    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight);
    const rect = element.getBoundingClientRect();
    const isOffscreen = rect.bottom < 150 || rect.top - vh >= -150;

    if (isOffscreen) {
        MessageActions.jumpToMessage({
            channelId,
            messageId,
            flash: false,
            jumpType: "INSTANT"
        });
    }
}

function getNextMessage(isUp: boolean, isReply: boolean) {
    const messages: Message[] = MessageStore.getMessages(SelectedChannelStore.getChannelId())?._array ?? [];

    const meId = UserStore.getCurrentUser()?.id;
    if (!meId) return null;

    const hasNoBlockedMessages = isPluginEnabled(NoBlockedMessagesPlugin.name);

    const isEligibleMessage = (m: Message) => {
        if (m.deleted) return false;
        if (!isReply && m.author.id !== meId) return false; // editing only own messages
        if (!MessageTypeSets.REPLYABLE.has(m.type) || m.hasFlag(MessageFlags.EPHEMERAL)) return false;
        if (settings.store.ignoreBlockedAndIgnored && RelationshipStore.isBlockedOrIgnored(m.author.id)) return false;
        if (hasNoBlockedMessages && NoBlockedMessagesPlugin.isSuppressed(m).suppressed) return false;

        return true;
    };

    const findNextNonDeleted = (id: string | null) => {
        const idx = messages.findIndex(m => m.id === id);
        if (idx === -1) {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (isEligibleMessage(messages[i])) return messages[i];
            }
            return null;
        }

        const step = isUp ? -1 : 1;
        for (let i = idx + step; i >= 0 && i < messages.length; i += step) {
            if (isEligibleMessage(messages[i])) return messages[i];
        }
        return null;
    };

    if (isReply) {
        const msg = findNextNonDeleted(currentlyReplyingId);
        currentlyReplyingId = msg?.id ?? null;
        return msg;
    } else {
        const msg = findNextNonDeleted(currentlyEditingId);
        currentlyEditingId = msg?.id ?? null;
        return msg;
    }
}

function shouldMention(message: Message) {
    switch (settings.store.shouldMention) {
        case MentionOptions.NO_REPLY_MENTION_PLUGIN:
            if (!isPluginEnabled(NoReplyMentionPlugin.name)) return true;
            return NoReplyMentionPlugin.shouldMention(message, false);
        case MentionOptions.DISABLED:
            return false;
        default:
            return true;
    }
}

// handle next/prev reply
function nextReply(isUp: boolean) {
    const currChannel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!currChannel) return;
    if (currChannel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, currChannel)) return;

    const message = getNextMessage(isUp, true);

    if (!message) {
        return void Dispatcher.dispatch({
            type: "DELETE_PENDING_REPLY",
            channelId: SelectedChannelStore.getChannelId(),
        });
    }

    const channel = ChannelStore.getChannel(message.channel_id);
    const meId = UserStore.getCurrentUser()?.id;
    if (!channel || !meId) return;

    Dispatcher.dispatch({
        type: "CREATE_PENDING_REPLY",
        channel,
        message,
        shouldMention: shouldMention(message),
        showMentionToggle: !channel.isPrivate() && message.author.id !== meId,
        _isQuickReply: true
    });

    ComponentDispatch.dispatchToLastSubscribed("TEXTAREA_FOCUS");
    jumpIfOffScreen(channel.id, message.id);
}

// handle next/prev edit
function nextEdit(isUp: boolean) {
    const currChannel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!currChannel) return;
    if (currChannel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, currChannel)) return;
    const message = getNextMessage(isUp, false);

    if (!message) {
        return Dispatcher.dispatch({
            type: "MESSAGE_END_EDIT",
            channelId: SelectedChannelStore.getChannelId()
        });
    }

    Dispatcher.dispatch({
        type: "MESSAGE_START_EDIT",
        channelId: message.channel_id,
        messageId: message.id,
        content: message.content,
        _isQuickEdit: true
    });

    jumpIfOffScreen(message.channel_id, message.id);
}
