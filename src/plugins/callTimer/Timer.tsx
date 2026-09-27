/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { useFixedTimer } from "@utils/react";
import { formatDurationMs } from "@utils/text";
import { Tooltip } from "@webpack/common";

import { settings } from "./index";
import { TimerIcon } from "./TimerIcon";

export function Timer({ time }: Readonly<{ time: number; }>) {
    const durationMs = useFixedTimer({ initialTime: time });
    const formatted = formatDurationMs(durationMs, settings.store.format === "human", settings.store.showSeconds);
    const defaultColorClassName = settings.store.showRoleColor ? "" : "usernameFont__71dd5 username__73ce9";

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
