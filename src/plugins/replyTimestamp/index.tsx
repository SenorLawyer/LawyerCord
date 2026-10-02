/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { DateUtils, Timestamp } from "@webpack/common";
import type { HTMLAttributes } from "react";

const MessageClasses = findCssClassesLazy("separator", "latin24CompactTimeStamp");

function Sep(props: HTMLAttributes<HTMLElement>) {
    return <i className={MessageClasses.separator} aria-hidden={true} {...props} />;
}

type ReferencedMessage = { state: 0; message: Message; } | { state: 1 | 2; };

function ReplyTimestamp({
    referencedMessage,
    baseMessage,
}: {
    referencedMessage: ReferencedMessage,
    baseMessage: Message;
}) {
    if (referencedMessage.state !== 0) return null;
    const refTimestamp = referencedMessage.message.timestamp;
    const baseTimestamp = baseMessage.timestamp;
    const sameDay = DateUtils.isSameDay(refTimestamp, baseTimestamp);
    return (
        <Timestamp
            className="vc-reply-timestamp"
            compact={sameDay}
            timestamp={refTimestamp}
            isInline={false}
        >
            <Sep>[</Sep>
            {sameDay
                ? DateUtils.dateFormat(refTimestamp, "LT")
                : DateUtils.calendarFormat(refTimestamp)
            }
            <Sep>]</Sep>
        </Timestamp>
    );
}

export default definePlugin({
    name: "ReplyTimestamp",
    performance: {
        impact: "low",
        description: "Adds the referenced message timestamp when reply previews render."
    },
    description: "Shows a timestamp on replied-message previews",
    tags: ["Chat", "Appearance"],
    authors: [Devs.Kyuuhachi],

    patches: [
        {
            // Same find as in ValidReply
            find: "#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}",
            replacement: {
                match: /(?<=\.onClickReply,[^{}]{0,150}\}\),)(?=\i,\i,\i\])/,
                replace: "$self.ReplyTimestamp(arguments[0]),"
            }
        }
    ],

    ReplyTimestamp: ErrorBoundary.wrap(ReplyTimestamp, { noop: true }),
});
