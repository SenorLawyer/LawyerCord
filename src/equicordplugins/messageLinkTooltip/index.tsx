/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Message } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, Constants, MessageStore, RestAPI, Tooltip, useEffect, UserStore,useState, useStateFromStores } from "@webpack/common";

const MessageDisplayCompact = getUserSettingLazy<boolean>("textAndImages", "messageDisplayCompact")!;

interface ChannelMessageProps {
    id: string;
    message: Message;
    channel: Channel;
    subscribeToComponentDispatch: boolean;
    compact: boolean;
}

interface MessagePreviewProps {
    channelId: string;
    messageId: string;
}

interface FetchedMessage extends MessagePreviewProps {
    userId: string;
    session: symbol;
    message: Message | null;
}

const ChannelMessage = findComponentByCodeLazy<ChannelMessageProps>("isFirstMessageInForumPost", "trackAnnouncementViews");
const DISPLAY_SETTINGS: ["display"] = ["display"];
const logger = new Logger("MessageLinkTooltip");
let session: symbol | undefined;

const settings = definePluginSettings({
    onLink: {
        description: "Show tooltip when hovering over message links",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true,
    },
    onReply: {
        description: "Show tooltip when hovering over message replies",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true,
    },
    onForward: {
        description: "Show tooltip when hovering over forwarded messages",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true,
    },
    display: {
        description: "Display style",
        type: OptionType.SELECT,
        options: [
            {
                label: "Same as message",
                value: "auto",
                default: true
            },
            {
                label: "Compact",
                value: "compact"
            },
            {
                label: "Cozy",
                value: "cozy"
            },
        ]
    },
});

export default definePlugin({
    name: "MessageLinkTooltip",
    description: "Adds a tooltip with a message preview when hovering over message links, replies, and forwarded messages.",
    tags: ["Appearance", "Chat"],
    authors: [Devs.Kyuuhachi],
    dependencies: ["UserSettingsAPI"],

    settings,

    start() { session = Symbol(); },
    stop() { session = undefined; },

    patches: [
        {
            find: '"channelMention",children:[null',
            replacement: {
                match: /(?<=\.jsxs\)\()(\i\.\i),\{(?=role:"link")/,
                replace: "$self.MentionTooltip,{Component:$1,vcProps:arguments[0],"
            },
            predicate: () => settings.store.onLink,
        },
        {
            find: "#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}",
            replacement: {
                // Should match two places
                match: /(\i\.\i),\{(?=className:\i\(\)\(\i\.\i,\i\.\i)/g,
                replace: "$self.ReplyTooltip,{Component:$1,vcProps:arguments[0],"
            },
            predicate: () => settings.store.onReply,
        },
        {
            find: "#{intl::MESSAGE_FORWARDED}",
            replacement: {
                match: /(\i\.\i),\{(?=className:\i\.\i,onClick:\i)/g,
                replace: "$self.ForwardTooltip,{Component:$1,vcProps:arguments[0],"
            },
            predicate: () => settings.store.onForward,
        },
    ],

    MentionTooltip({ Component, vcProps, ...props }) {
        return withTooltip(Component, props, vcProps.messageId, vcProps.channelId);
    },

    ReplyTooltip({ Component, vcProps, ...props }) {
        const mess = vcProps.baseMessage.messageReference;
        return withTooltip(Component, props, mess?.message_id, mess?.channel_id);
    },

    ForwardTooltip({ Component, vcProps, ...props }) {
        const mess = vcProps.message.messageReference;
        return withTooltip(Component, props, mess?.message_id, mess?.channel_id);
    },
});

function withTooltip(Component, props, messageId, channelId) {
    if (!messageId) return <Component {...props} />;
    return <Tooltip
        tooltipClassName="c98-message-link-tooltip"
        text={
            <ErrorBoundary>
                <MessagePreview
                    channelId={channelId}
                    messageId={messageId}
                />
            </ErrorBoundary>
        }>
        {({ onMouseEnter, onMouseLeave }) => (
            <Component {...props} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />
        )}
    </Tooltip>;
}

function MessagePreview({ channelId, messageId }: MessagePreviewProps) {
    const channel = useStateFromStores([ChannelStore], () => ChannelStore.getChannel(channelId), [channelId]);
    const message = useMessage(channelId, messageId);
    const rawCompact = MessageDisplayCompact.useSetting();

    const { display } = settings.use(DISPLAY_SETTINGS);
    const compact = display === "compact" ? true : display === "cozy" ? false : rawCompact;

    if (!channel || message === null) return <span>Message unavailable.</span>;
    if (!message) return <span>Loading...</span>;

    return <ChannelMessage
        id={`message-link-tooltip-${messageId}`}
        message={message}
        channel={channel}
        subscribeToComponentDispatch={false}
        compact={compact}
    />;
}

function useMessage(channelId: string, messageId: string) {
    const cachedMessage = useStateFromStores(
        [MessageStore],
        () => MessageStore.getMessage(channelId, messageId),
        [channelId, messageId]
    );
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const [fetched, setFetched] = useState<FetchedMessage>();
    useEffect(() => {
        if (cachedMessage || !userId || !session) return;
        const currentSession = session;
        let cancelled = false;
        const isCurrent = () => !cancelled && session === currentSession && UserStore.getCurrentUser()?.id === userId;
        void (async () => {
            try {
                const res = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query: { limit: 1, around: messageId },
                    retries: 2,
                });
                if (!isCurrent()) return;
                const { body } = res;
                const rawMessage = Array.isArray(body)
                    ? body.find((value: unknown) => isObject(value) && "id" in value && value.id === messageId && "channel_id" in value && value.channel_id === channelId)
                    : undefined;
                const message: Message | undefined = rawMessage && MessageStore.getMessages(channelId).receiveMessage(rawMessage).get(messageId);
                setFetched({ channelId, messageId, userId, session: currentSession, message: message ?? null });
            } catch (error) {
                if (!isCurrent()) return;
                logger.error("Could not load message preview", error);
                setFetched({ channelId, messageId, userId, session: currentSession, message: null });
            }
        })();
        return () => { cancelled = true; };
    }, [cachedMessage, channelId, messageId, userId]);
    return cachedMessage ?? (fetched?.channelId === channelId && fetched.messageId === messageId && fetched.userId === userId && fetched.session === session ? fetched.message : undefined);
}
