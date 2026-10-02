/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Constants, FluxDispatcher, RestAPI, UserStore } from "@webpack/common";

const enum ReferencedMessageState {
    Loaded,
    NotLoaded,
    Deleted
}

interface Reply {
    baseAuthor: User,
    baseMessage: Message;
    channel: Channel;
    referencedMessage: { state: ReferencedMessageState; };
    compact: boolean;
    isReplyAuthorBlocked: boolean;
}

const fetching = new Map<string, string>();
const logger = new Logger("ValidReply");
let generation = 0;
let ReplyStore: any;

function clearFetching() {
    generation++;
    fetching.clear();
}

const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");

export default definePlugin({
    name: "ValidReply",
    description: 'Fixes "Message could not be loaded" upon hovering over the reply',
    tags: ["Chat", "Utility"],
    authors: [Devs.newwares],
    stop: clearFetching,
    flux: {
        LOGOUT: clearFetching,
        CONNECTION_OPEN: clearFetching
    },
    patches: [
        {
            // Same find as in ReplyTimestamp
            find: "#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}",
            replacement: {
                match: /#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}\)/,
                replace: "$&,onMouseEnter:()=>$self.fetchReply(arguments[0])"
            }
        },
        {
            find: "ReferencedMessageStore",
            replacement: [
                {
                    match: /_channelCaches=new Map;/,
                    replace: "$&_=$self.setReplyStore(this);"
                }
            ]
        }
    ],

    setReplyStore(store: any) {
        ReplyStore = store;
    },

    async fetchReply(reply: Reply) {
        const { channel_id: channelId, message_id: messageId } = reply.baseMessage.messageReference!;

        if (fetching.has(messageId)) {
            return;
        }
        fetching.set(messageId, channelId);
        const owner = generation;
        const accountId = UserStore.getCurrentUser()?.id;

        RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: {
                limit: 1,
                around: messageId
            },
            retries: 2
        })
            .then(res => {
                if (owner !== generation || accountId !== UserStore.getCurrentUser()?.id) return;
                const reply: Message | undefined = res?.body?.[0];
                if (!reply) return;

                if (reply.id !== messageId) {
                    ReplyStore.set(channelId, messageId, {
                        state: ReferencedMessageState.Deleted
                    });

                    FluxDispatcher.dispatch({
                        type: "MESSAGE_DELETE",
                        channelId: channelId,
                        message: messageId
                    });
                } else {
                    ReplyStore.set(reply.channel_id, reply.id, {
                        state: ReferencedMessageState.Loaded,
                        message: createMessageRecord(reply)
                    });

                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: reply
                    });
                }
            })
            .catch(error => logger.warn("Could not load the referenced message.", error))
            .finally(() => {
                if (owner === generation) fetching.delete(messageId);
            });
    }
});
