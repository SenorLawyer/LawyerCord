/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "StopAutoUnread",
    performance: { impact: "low", description: "Skips automatic channel notification upgrades." },
    description: 'Stops Discord from automatically bumping a channels notification setting to "All Messages"',
    tags: ["Notifications"],
    authors: [EquicordDevs.SobakinTech],
    patches: [
        {
            find: "}maybeAutoUpgradeChannel(",
            replacement: {
                match: /maybeAutoUpgradeChannel\(\i\){/,
                replace: "$&return !1;"
            }
        }
    ]
});
