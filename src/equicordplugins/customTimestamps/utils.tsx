/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import type { Message, User, UserJSON } from "@vencord/discord-types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { Button, useRef, UserStore, useState } from "@webpack/common";

export type TimeFormat = {
    name: string;
    description: string;
    default: string;
    offset: number;
};
interface MessagePreviewProps {
    author: Partial<User> & { nick: string; };
    message: Message;
    compact: boolean;
    isGroupStart: boolean;
    className: string;
    hideSimpleEmbedContent: boolean;
}

interface PreviewMessage {
    author: User | UserJSON;
    timestamp: string;
}

interface DemoMessageProps {
    msgId: string;
    compact: boolean;
    message: string;
    date: Date;
}

const MessagePreview = findComponentByCodeLazy<MessagePreviewProps>(/previewGuildId:\i,preview:\i,/);
const createBotMessage: (options: { messageId: string; content: string; channelId: string; }) => PreviewMessage = findByCodeLazy('username:"Clyde"');
const populateMessagePrototype: (message: PreviewMessage) => Message = findByCodeLazy("isProbablyAValidSnowflake", "messageReference:");

export const timeFormats: Record<string, TimeFormat> = {
    cozyFormat: {
        name: "Cozy mode",
        description: "Time format to use in messages on cozy mode",
        default: "[calendar]",
        offset: 0,
    },
    compactFormat: {
        name: "Compact mode",
        description: "Time format on compact mode and hovering messages",
        default: "LT",
        offset: 0,
    },
    tooltipFormat: {
        name: "Tooltip",
        description: "Time format to use on tooltips",
        default: "LLLL • [relative]",
        offset: 0,
    },
    ariaLabelFormat: {
        name: "Aria label",
        description: "Time format to use on aria labels",
        default: "[calendar]",
        offset: 0,
    },
    sameDayFormat: {
        name: "Same day",
        description: "[calendar] format for today",
        default: "[Today at] HH:mm:ss",
        offset: 0,
    },
    lastDayFormat: {
        name: "Last day",
        description: "[calendar] format for yesterday",
        default: "[Yesterday at] HH:mm:ss",
        offset: -1000 * 60 * 60 * 24,
    },
    lastWeekFormat: {
        name: "Last week",
        description: "[calendar] format for within the last week",
        default: "ddd DD.MM.YYYY HH:mm:ss",
        offset: -1000 * 60 * 60 * 24 * 6, // setting an offset of a week exactly pushes it into "older date" territory as soon as a second passes
    },
    sameElseFormat: {
        name: "Older date",
        description: "[calendar] format for older dates",
        default: "ddd DD.MM.YYYY HH:mm:ss",
        offset: -1000 * 60 * 60 * 24 * 31,
    }
};

const DemoMessage = (props: DemoMessageProps) => {
    const user = UserStore.getCurrentUser();
    const message = createBotMessage({ messageId: props.msgId, content: props.message, channelId: "1337" });
    message.author = user;
    message.timestamp = props.date.toISOString();
    return (
        <div className="vc-cmt-demo-message">
            <MessagePreview
                author={{ ...user, nick: user.globalName || user.username }}
                message={populateMessagePrototype(message)}
                compact={props.compact}
                isGroupStart={true}
                className="vc-cmt-demo-message-preview"
                hideSimpleEmbedContent={true}
            />
        </div>
    );
};

export const DemoMessageContainer = ErrorBoundary.wrap(() => {
    const [isCompact, setIsCompact] = useState(false);
    const today = useRef<Date>(new Date());
    const yesterday = useRef<Date>(new Date(Date.now() + timeFormats.lastDayFormat.offset));
    const lastWeek = useRef<Date>(new Date(Date.now() + timeFormats.lastWeekFormat.offset));
    const aMonthAgo = useRef<Date>(new Date(Date.now() + timeFormats.sameElseFormat.offset));

    return (
        <div className="vc-cmt-demo-message-container">
            <Button look={Button.Looks.LINK} size={Button.Sizes.SMALL} onClick={() => setIsCompact(!isCompact)}>
                Switch to {isCompact ? "cozy" : "compact"} mode
            </Button>
            <DemoMessage compact={isCompact} msgId={"1337"}
                message="This message was sent a month ago"
                date={aMonthAgo.current} />
            <DemoMessage compact={isCompact} msgId={"1338"} message={"This message was sent in the last week"}
                date={lastWeek.current} />
            <DemoMessage compact={isCompact} msgId={"1339"} message={"Hover over timestamps to see tooltip formats"}
                date={yesterday.current} />
            <DemoMessage compact={isCompact} msgId={"1340"} message={"Edit the formats below to see them live update here"}
                date={today.current} />
        </div>
    );
}, { noop: true });
