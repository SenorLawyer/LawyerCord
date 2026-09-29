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
import { makeLazy } from "@utils/lazy";
import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import definePlugin, { OptionType } from "@utils/types";
import { Message, ReactionEmoji, User } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, lodash, React, RestAPI, useEffect, useLayoutEffect, UserStore, UserSummaryItem, useStateFromStores } from "@webpack/common";

interface ReactionCacheEntry {
    fetched: boolean;
    users: Map<string, User>;
}

interface ReactionScroller {
    scrollCounter: number;
    setAutomaticAnchor(anchor: null): void;
}

interface ReactionProps {
    message: Message;
    emoji: ReactionEmoji;
    type: number;
}

const MAX_PENDING_REACTION_FETCHES = 50;
const AVATAR_SETTINGS: "avatarClick"[] = ["avatarClick"];
const MessageReactionsStore = findStoreLazy("MessageReactionsStore");

const getScrollerContext = makeLazy(() => React.createContext<ReactionScroller | null>(null));
const queue = new Queue(MAX_PENDING_REACTION_FETCHES);
let fetchGeneration = 0;
let reactions: Record<string, ReactionCacheEntry> = {};

function getEmojiKey(emoji: Pick<ReactionEmoji, "id" | "name">) {
    return emoji.name + (emoji.id ? `:${emoji.id}` : "");
}

function getReactionsWithQueue(msg: Message, e: ReactionEmoji, type: number) {
    const key = `${msg.id}:${e.name}:${e.id ?? ""}:${type}`;
    const cache = reactions[key] ??= { fetched: false, users: new Map() };
    const userId = UserStore.getCurrentUser()?.id;
    if (!cache.fetched && userId) {
        const generation = fetchGeneration;
        queue.unshift(async () => {
            if (generation !== fetchGeneration || userId !== UserStore.getCurrentUser()?.id || cache.fetched) return;
            cache.fetched = true;
            try {
                const res = await RestAPI.get({
                    url: Constants.Endpoints.REACTIONS(msg.channel_id, msg.id, getEmojiKey(e)),
                    query: { limit: 100, type },
                    oldFormErrors: true
                });
                if (generation !== fetchGeneration || userId !== UserStore.getCurrentUser()?.id) {
                    cache.fetched = false;
                    return;
                }
                for (const user of res.body) {
                    FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
                }
                FluxDispatcher.dispatch({
                    type: "MESSAGE_REACTION_ADD_USERS",
                    channelId: msg.channel_id,
                    messageId: msg.id,
                    users: res.body,
                    emoji: e,
                    reactionType: type
                });
            } catch (error) {
                cache.fetched = false;
                throw error;
            } finally {
                await sleep(250);
            }
        });
    }

    return cache.users;
}

function handleClickAvatar(event: React.UIEvent<HTMLElement, Event>) {
    event.stopPropagation();
}

function ReactionUsers({ message, emoji, type }: ReactionProps) {
    const { avatarClick } = settings.use(AVATAR_SETTINGS);
    const scroller = React.useContext(getScrollerContext());
    const key = `${message.id}:${emoji.name}:${emoji.id ?? ""}:${type}`;
    const { userIds, guildId, generation, userId } = useStateFromStores([MessageReactionsStore, UserStore, ChannelStore], () => {
        const userIds = Array.from(reactions[key]?.users.keys() ?? []);
        const guildId = ChannelStore.getChannel(message.channel_id)?.guild_id;
        return {
            userIds,
            guildId,
            generation: fetchGeneration,
            userId: UserStore.getCurrentUser()?.id,
            users: userIds.map(id => {
                const user = UserStore.getUser(id);
                return user && {
                    id: user.id,
                    username: user.username,
                    globalName: user.globalName,
                    discriminator: user.discriminator,
                    avatar: user.avatar,
                    guildAvatar: guildId ? user.guildMemberAvatars?.[guildId] : undefined
                };
            })
        };
    }, [key, message.channel_id], lodash.isEqual);

    useLayoutEffect(() => { // bc need to prevent autoscrolling
        if (scroller && scroller.scrollCounter > 0) {
            scroller.setAutomaticAnchor(null);
        }
    });

    useEffect(() => {
        getReactionsWithQueue(message, emoji, type);
    }, [message.id, message.channel_id, emoji.id, emoji.name, type, generation, userId]);

    const users: User[] = [];

    for (const id of userIds) {
        const user = UserStore.getUser(id);
        if (user) users.push(user);
    }

    return (
        <div
            style={{ marginLeft: "0.5em", transform: "scale(0.9)" }}
            onClick={avatarClick ? handleClickAvatar : undefined}
            onKeyPress={avatarClick ? handleClickAvatar : undefined}
        >
            <UserSummaryItem
                users={users}
                guildId={guildId}
                renderIcon={false}
                max={5}
                showDefaultAvatarsForNullUsers
                showUserPopout={avatarClick}
            />
        </div>
    );
}

const settings = definePluginSettings({
    avatarClick: {
        description: "Open profiles by clicking reaction avatars.",
        type: OptionType.BOOLEAN,
        default: false
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
            find: "useConversationScroll must be used inside <ConversationScrollProvider>",
            replacement: {
                match: /(?<=return\(0,(\i)\.jsx\)\(\i\.Provider,\{(?:value:\i,)?children:)\i(?=(?:,value:\i)?\}\)\}function \i\(\)\{let \i=\i\.useContext\(\i\);if\(null==\i\)throw Error\("useConversationScroll)/,
                replace: "(0,$1.jsx)($self.ScrollerContext.Provider,{value:arguments[0].scrollManager,children:$&})"
            }
        }
    ],

    renderUsers: ErrorBoundary.wrap((props: ReactionProps) => {
        return props.message.reactions.length > 10
            ? null
            : <ReactionUsers {...props} />;
    }, { noop: true }),

    get ScrollerContext() {
        return getScrollerContext();
    },

    set reactions(value: Record<string, ReactionCacheEntry>) {
        fetchGeneration++;
        reactions = value;
    },

    stop() {
        fetchGeneration++;
    }
});
