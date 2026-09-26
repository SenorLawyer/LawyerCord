/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { classNameToSelector } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { MessageType } from "@vencord/discord-types/enums";
import { findByPropsLazy, findCssClassesLazy } from "@webpack";
import { ChannelStore, createRoot, MessageStore, Toasts } from "@webpack/common";
import { Root } from "react-dom/client";

import ReplyNavigator from "./ReplyNavigator";
import styles from "./styles.css?managed";

export const jumper: {
    jumpToMessage(options: { channelId: string; messageId: string; flash: boolean; jumpType: "INSTANT"; }): unknown;
} = findByPropsLazy("jumpToMessage");
const channelStyles = findCssClassesLazy("channelBottomBarArea");
const FindReplyIcon = () => {
    return <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="18" height="18">
        <path
            d="M 7 3 L 7 11 C 7 11 7 12 6 12 L 5 12 C 4 12 4 12 4.983 13.115 L 8.164 17.036 C 9 18 9 18 9.844 17.018 L 12.991 13.277 C 14 12 14 12 13.006 11.985 L 12 12 C 12 12 11 12 11 11 L 11 3 C 11 2 11 2 10 2 L 8 2 C 7 2 7 2 7 3" />
    </svg>;
};
let root: Root | null = null;
let element: HTMLDivElement | null = null;

type CachedMessage = Message & { deleted?: boolean; };

function getMessageTimestamp(message: Message) {
    return new Date(message.timestamp).getTime();
}

function findReplies(message: Message) {
    const messages = MessageStore.getMessages(message.channel_id)?._array as CachedMessage[] | undefined;
    if (!messages?.length) return [];

    const authorId = message.author?.id;
    if (!authorId) return [];

    const targetTimestamp = getMessageTimestamp(message);
    const messageById = settings.store.includeAuthor ? new Map<string, CachedMessage>() : null;
    if (messageById) {
        for (const other of messages) {
            if (!other.deleted) messageById.set(other.id, other);
        }
    }

    const found: Message[] = [];
    const foundIds = new Set<string>();
    const plainMention = settings.store.includePings ? `<@${authorId}>` : "";
    const nickMention = settings.store.includePings ? `<@!${authorId}>` : "";

    for (const other of messages) {
        if (other.deleted) continue;

        const referencedMessageId = other.type === MessageType.REPLY ? other.messageReference?.message_id : undefined;
        let isReply = referencedMessageId === message.id;
        if (!isReply && getMessageTimestamp(other) <= targetTimestamp) continue;

        if (!isReply && settings.store.includePings && (other.content?.includes(plainMention) || other.content?.includes(nickMention))) {
            isReply = true;
        }

        if (!isReply && messageById) {
            isReply = referencedMessageId != null && messageById.get(referencedMessageId)?.author.id === authorId;
        }

        if (isReply && !foundIds.has(other.id)) {
            foundIds.add(other.id);
            found.push(other);
        }
    }

    return found.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
}

const settings = definePluginSettings({
    includePings: {
        type: OptionType.BOOLEAN,
        description: "Include messages that mention the author.",
        default: false
    },
    includeAuthor: {
        type: OptionType.BOOLEAN,
        description: "Include replies to other messages from the same author.",
        default: false
    },
    hideButtonIfNoReply: {
        type: OptionType.BOOLEAN,
        description: "Hide the button when no replies are found.",
        default: true
    }
});

export default definePlugin({
    name: "FindReply",
    description: "Jumps to the earliest reply to a message in a channel (lets you follow past conversations more easily).",
    dependencies: ["MessagePopoverAPI"],
    tags: ["Chat", "Shortcuts"],
    authors: [Devs.newwares],
    settings,
    managedStyle: styles,
    messagePopoverButton: {
        icon: FindReplyIcon,
        render(message) {
            if (!message.id) return null;
            if (settings.store.hideButtonIfNoReply && !findReplies(message).length) return null;
            return {
                label: "Jump to Reply",
                icon: FindReplyIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => {
                    const replies = findReplies(message);
                    if (replies.length <= 1) root?.render(null);
                    if (replies.length) {
                        const channelId = replies[0].channel_id;
                        const messageId = replies[0].id;
                        jumper.jumpToMessage({
                            channelId,
                            messageId,
                            flash: true,
                            jumpType: "INSTANT"
                        });
                        if (replies.length > 1) {
                            const className = channelStyles.channelBottomBarArea;
                            const container = className && document.querySelector(classNameToSelector(className));
                            if (!container) {
                                root?.render(null);
                                Toasts.show({
                                    id: Toasts.genId(),
                                    message: "Couldn't find the container element.",
                                    type: Toasts.Type.FAILURE
                                });
                                return;
                            }

                            element ??= document.createElement("div");
                            container.appendChild(element);
                            root ??= createRoot(element);
                            root.render(<ReplyNavigator replies={replies} />);
                        }
                    } else {
                        Toasts.show({
                            id: Toasts.genId(),
                            message: "Couldn't find a reply.",
                            type: Toasts.Type.FAILURE
                        });
                    }
                }
            };
        }
    },
    stop() {
        root?.unmount();
        root = null;
        element?.remove();
        element = null;
    },
});
