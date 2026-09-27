/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { useFixedTimer } from "@utils/react";
import { formatDurationMs } from "@utils/text";
import { Tooltip, UserStore } from "@webpack/common";

import { settings } from "./index";
import { TimerIcon } from "./TimerIcon";

const TIMER_SETTINGS: ("format" | "showSeconds" | "showRoleColor" | "trackSelf")[] = ["format", "showSeconds", "showRoleColor", "trackSelf"];

interface TimerProps {
    time: number;
    userId: string;
}

export function Timer({ time, userId }: Readonly<TimerProps>) {
    const { format, showSeconds, showRoleColor, trackSelf } = settings.use(TIMER_SETTINGS);
    const durationMs = useFixedTimer({ initialTime: time });
    if (userId === UserStore.getCurrentUser()?.id && !trackSelf) {
        // don't show for self
        return null;
    }

    const formatted = formatDurationMs(durationMs, format === "human", showSeconds);
    const defaultColorClassName = showRoleColor ? "" : "usernameFont__71dd5 username__73ce9";

    if (settings.store.showWithoutHover) {
        return <div className={classes("vc-call-timer", defaultColorClassName)}>{formatted}</div>;
    } else {
        // show as a tooltip
        return (
            <Tooltip text={formatted}>
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        onMouseEnter={onMouseEnter}
                        onMouseLeave={onMouseLeave}
                        role="tooltip"
                    >
                        <TimerIcon />
                    </div>
                )}
            </Tooltip>
        );
    }
}
