/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { isNonNullish } from "@utils/guards";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { AuthenticationStore, SnowflakeUtils, Tooltip } from "@webpack/common";

type FillValue = ("status-danger" | "status-warning" | "status-positive" | "text-muted");
type Fill = [FillValue, FillValue, FillValue];

const DISCORD_KT_DELAY = 1471228928;
const DISCORD_KT_GRACE_MS = 86400000;
const TROLL_LIMIT = 2 * 60 * 1000;
const DISCORD_KT_FILL: Fill = ["status-positive", "status-positive", "text-muted"];
const MUTED_FILL: Fill = ["text-muted", "text-muted", "text-muted"];
const DANGER_FILL: Fill = ["status-danger", "text-muted", "text-muted"];
const WARNING_FILL: Fill = ["status-warning", "status-warning", "text-muted"];
const DURATION_UNITS = [
    { singular: "day", plural: "days", millis: 60 * 60 * 24 * 1000 },
    { singular: "hour", plural: "hours", millis: 60 * 60 * 1000, modulo: 24 },
    { singular: "minute", plural: "minutes", millis: 60 * 1000, modulo: 60 },
    { singular: "second", plural: "seconds", millis: 1000, modulo: 60 },
    { singular: "millisecond", plural: "milliseconds", millis: 1, modulo: 1000 },
] as const;

export default definePlugin({
    name: "MessageLatency",
    performance: {
        impact: "low",
        description: "Compares message timestamps and adds latency indicators during message rendering."
    },
    description: "Displays an indicator for messages that took ≥n seconds to send",
    tags: ["Chat", "Utility"],
    authors: [Devs.arHSM],

    settings: definePluginSettings({
        latency: {
            type: OptionType.NUMBER,
            description: "Threshold in seconds for latency indicator",
            default: 2
        },
        detectDiscordKotlin: {
            type: OptionType.BOOLEAN,
            description: "Detect old Discord Android clients",
            default: true
        },
        showMillis: {
            type: OptionType.BOOLEAN,
            description: "Show milliseconds",
            default: false
        },
        ignoreSelf: {
            type: OptionType.BOOLEAN,
            description: "Don't add indicator to your own messages",
            default: false
        }
    }),

    patches: [
        {
            find: "showCommunicationDisabledStyles",
            replacement: {
                match: /(message:(\i),avatar:\i,username:\(0,\i.jsxs\)\(\i.Fragment,\{children:\[)(\i&&)/,
                replace: "$1$self.Tooltip()({ message: $2 }),$3"
            }
        }
    ],

    stringDelta(delta: number, showMillis: boolean) {
        let text = "";
        const andBefore = showMillis ? "millisecond" : "second";

        for (const unit of DURATION_UNITS) {
            if (!showMillis && unit.singular === "millisecond") continue;

            const rawValue = Math.floor(delta / unit.millis);
            const value = "modulo" in unit ? rawValue % unit.modulo : rawValue;
            if (value <= 0) continue;

            if (text) text += unit.singular === andBefore ? " and " : " ";
            text += `${value} ${value === 1 ? unit.singular : unit.plural}`;
        }

        return text || "0 seconds";
    },

    latencyTooltipData(message: Message) {
        const { latency, detectDiscordKotlin, showMillis, ignoreSelf } = this.settings.store;
        const { id, nonce } = message;

        // Message wasn't received through gateway
        if (!isNonNullish(nonce)) return null;

        // Bots basically never send a nonce, and if someone does do it then it's usually not a snowflake
        if (message.author.bot) return null;

        if (ignoreSelf && message.author.id === AuthenticationStore.getId()) return null;

        let isDiscordKotlin = false;
        let delta = SnowflakeUtils.extractTimestamp(id) - SnowflakeUtils.extractTimestamp(nonce); // milliseconds
        if (!showMillis) {
            delta = Math.round(delta / 1000) * 1000;
        }

        // Old Discord Android clients have a delay of around 17 days
        // This is a workaround for that
        if (-delta >= DISCORD_KT_DELAY - DISCORD_KT_GRACE_MS) {
            // One day of padding for good measure
            isDiscordKotlin = detectDiscordKotlin;
            delta += DISCORD_KT_DELAY;
        }

        // Thanks dziurwa (I hate you)
        // This is when the user's clock is ahead
        // Can't do anything if the clock is behind
        const abs = Math.abs(delta);
        const ahead = abs !== delta;
        const latencyMillis = latency * 1000;

        const stringDelta = abs >= latencyMillis ? this.stringDelta(abs, showMillis) : null;

        const fill: Fill = isDiscordKotlin
            ? DISCORD_KT_FILL
            : delta >= TROLL_LIMIT || ahead
                ? MUTED_FILL
                : delta >= (latencyMillis * 2)
                    ? DANGER_FILL
                    : WARNING_FILL;

        return (abs >= latencyMillis || isDiscordKotlin) ? { delta: stringDelta, ahead, fill, isDiscordKotlin } : null;
    },

    Tooltip() {
        return ErrorBoundary.wrap(({ message }: { message: Message; }) => {
            const d = this.latencyTooltipData(message);

            if (!isNonNullish(d)) return null;

            let text: string;
            if (!d.delta) {
                text = "User is suspected to be on an old Discord Android client";
            } else {
                text = (d.ahead ? `This user's clock is ${d.delta} ahead.` : `This message was sent with a delay of ${d.delta}.`) + (d.isDiscordKotlin ? " User is suspected to be on an old Discord Android client." : "");
            }

            return <Tooltip
                text={text}
                position="top"
            >
                {props => <this.Icon delta={d.delta} fill={d.fill} props={props} />}
            </Tooltip>;
        }, { noop: true });
    },

    Icon({ delta, fill, props }: {
        delta: string | null;
        fill: Fill,
        props: {
            onClick(): void;
            onMouseEnter(): void;
            onMouseLeave(): void;
            onContextMenu(): void;
            onFocus(): void;
            onBlur(): void;
            "aria-label"?: string;
        };
    }) {
        return <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            role="img"
            fill="none"
            style={{ marginRight: "8px", verticalAlign: -1 }}
            aria-label={delta ?? "Old Discord Android client"}
            aria-hidden="false"
            {...props}
        >
            <path
                fill={`var(--${fill[0]})`}
                d="M4.8001 12C4.8001 11.5576 4.51344 11.2 4.16023 11.2H2.23997C1.88676 11.2 1.6001 11.5576 1.6001 12V13.6C1.6001 14.0424 1.88676 14.4 2.23997 14.4H4.15959C4.5128 14.4 4.79946 14.0424 4.79946 13.6L4.8001 12Z"
            />
            <path
                fill={`var(--${fill[1]})`}
                d="M9.6001 7.12724C9.6001 6.72504 9.31337 6.39998 8.9601 6.39998H7.0401C6.68684 6.39998 6.40011 6.72504 6.40011 7.12724V13.6727C6.40011 14.0749 6.68684 14.4 7.0401 14.4H8.9601C9.31337 14.4 9.6001 14.0749 9.6001 13.6727V7.12724Z"
            />
            <path
                fill={`var(--${fill[2]})`}
                d="M14.4001 2.31109C14.4001 1.91784 14.1134 1.59998 13.7601 1.59998H11.8401C11.4868 1.59998 11.2001 1.91784 11.2001 2.31109V13.6888C11.2001 14.0821 11.4868 14.4 11.8401 14.4H13.7601C14.1134 14.4 14.4001 14.0821 14.4001 13.6888V2.31109Z"
            />
        </svg>;
    }
});
