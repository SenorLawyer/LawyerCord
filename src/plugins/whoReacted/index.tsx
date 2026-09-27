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

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { CustomEmoji, Message, ReactionEmoji, User } from "@vencord/discord-types";
import { ChannelStore, Constants, FluxDispatcher, React, RestAPI, useEffect, useLayoutEffect, UserStore, UserSummaryItem } from "@webpack/common";

interface ReactionCacheEntry {
    fetched: boolean;
    users: Map<string, User>;
}

interface ReactionProps {
    message: Message;
    emoji: CustomEmoji;
    type: number;
}

const MAX_PENDING_REACTION_FETCHES = 50;

let Scroll: any = null;
const queue = new Queue(MAX_PENDING_REACTION_FETCHES);
let fetchGeneration = 0;
let reactions: Record<string, ReactionCacheEntry> = {};

function fetchReactions(msg: Message, emoji: ReactionEmoji, type: number) {
    const key = getEmojiKey(emoji);
    return RestAPI.get({
        url: Constants.Endpoints.REACTIONS(msg.channel_id, msg.id, key),
        query: {
            limit: 100,
            type
        },
        oldFormErrors: true
    })
        .then(res => {
            for (const user of res.body) {
                FluxDispatcher.dispatch({
                    type: "USER_UPDATE",
                    user
                });
            }

            FluxDispatcher.dispatch({
                type: "MESSAGE_REACTION_ADD_USERS",
                channelId: msg.channel_id,
                messageId: msg.id,
                users: res.body,
                emoji,
                reactionType: type
            });
        })
        .catch(console.error)
        .finally(() => sleep(250));
}

function getEmojiKey(emoji: Pick<ReactionEmoji, "id" | "name">) {
    return emoji.name + (emoji.id ? `:${emoji.id}` : "");
}

function getReactionsWithQueue(msg: Message, e: ReactionEmoji, type: number) {
    const key = `${msg.id}:${getEmojiKey(e)}:${type}`;
    const cache = reactions[key] ??= { fetched: false, users: new Map() };
    if (!cache.fetched) {
        const generation = fetchGeneration;
        queue.unshift(() => {
            if (generation !== fetchGeneration) return;
            return fetchReactions(msg, e, type);
        });
        cache.fetched = true;
    }

    return cache.users;
}

function handleClickAvatar(event: React.UIEvent<HTMLElement, Event>) {
    event.stopPropagation();
}

function ReactionUsers({ message, emoji, type }: ReactionProps) {
    const forceUpdate = useForceUpdater();
    const emojiKey = getEmojiKey(emoji);

    useLayoutEffect(() => { // bc need to prevent autoscrolling
        if (Scroll?.scrollCounter > 0) {
            Scroll.setAutomaticAnchor(null);
        }
    });

    useEffect(() => {
        const cb = (e: any) => {
            if (e?.messageId === message.id && e.reactionType === type && e.emoji && getEmojiKey(e.emoji) === emojiKey)
                forceUpdate();
        };
        FluxDispatcher.subscribe("MESSAGE_REACTION_ADD_USERS", cb);

        return () => FluxDispatcher.unsubscribe("MESSAGE_REACTION_ADD_USERS", cb);
    }, [message.id, type, emojiKey, forceUpdate]);

    const reactions = getReactionsWithQueue(message, emoji, type);
    const users: User[] = [];

    for (const id of reactions.keys()) {
        const user = UserStore.getUser(id);
        if (user) users.push(user);
    }

    return (
        <div
            style={{ marginLeft: "0.5em", transform: "scale(0.9)" }}
        >
            <div
                onClick={handleClickAvatar}
                onKeyDown={handleClickAvatar}
                style={settings.store.avatarClick ? {} : { pointerEvents: "none" }}
            >
                <UserSummaryItem
                    users={users}
                    guildId={ChannelStore.getChannel(message.channel_id)?.guild_id}
                    renderIcon={false}
                    max={5}
                    showDefaultAvatarsForNullUsers
                    showUserPopout
                />
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    avatarClick: {
        description: "Toggle clicking avatars in reactions",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "WhoReacted",
    description: "Renders the avatars of users who reacted to a message",
    tags: ["Reactions", "Chat", "Appearance"],
    authors: [Devs.Ven, Devs.KannaDev, Devs.newwares],
    isModified: true,
    settings,
    patches: [
        {
            find: ",reactionRef:",
            replacement: {
                match: /(\i)\?null:\(0,\i\.jsx\)\(\i\.\i,{className:\i\.reactionCount,[^{}]{0,100}}\),/,
                replace: "$&$1?null:$self.renderUsers({emoji:arguments[0].emoji,message:arguments[0].message,type:arguments[0].type}),"
            }
        },
        {
            find: '"MessageReactionsStore"',
            replacement: {
                match: /CONNECTION_OPEN:function\(\){(\i)={}/,
                replace: "$&;$self.reactions=$1;"
            }
        },
        {

            find: "cleanAutomaticAnchor(){",
            replacement: {
                match: /constructor\(\i\)\{(?=.{0,100}(?:automaticAnchor|\.messages\.loadingMore))/,
                replace: "$&$self.setScrollObj(this);"
            }
        }
    ],

    renderUsers: ErrorBoundary.wrap((props: ReactionProps) => {
        return props.message.reactions.length > 10
            ? null
            : <ReactionUsers {...props} />;
    }, { noop: true }),

    setScrollObj(scroll: any) {
        Scroll = scroll;
    },

    set reactions(value: any) {
        reactions = value;
    },

    stop() {
        fetchGeneration++;
        Scroll = null;
    }
});
