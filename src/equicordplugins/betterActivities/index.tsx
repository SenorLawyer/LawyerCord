/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { migratePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { patchActivityList } from "./patch-helpers/activityList";
import { wrapActivityCards } from "./patch-helpers/popout";
import { settings } from "./settings";
import { clearFetchedApplications } from "./utils";

migratePluginSettings("BetterActivities", "MemberListActivities");

export default definePlugin({
    name: "BetterActivities",
    description: "Shows activity icons in the member list and allows showing all activities",
    authors: [Devs.D3SOX, Devs.Arjix, Devs.AutumnVN, Devs.thororen],
    tags: ["Activity"],
    settings,
    patchActivityList,
    wrapActivityCards,
    patches: [
        {
            // Patch activity icons
            find: '"ActivityStatus"),',
            replacement: [
                {
                    match: /(\i)=\i\.length\+\(\i\|\|\i\?1:0\)/,
                    replace: "$1=0",
                    predicate: () => settings.store.removeGameActivityStatus,
                },
                {
                    match: /(?<=,\i&&\(0,\i\.jsx\)\(\i,\{\}\))(?=\]\})/g,
                    replace: ",$self.patchActivityList(arguments[0])",
                    predicate: () => settings.store.memberList,
                }
            ],
        },
        {
            // Show all activities in the user popout/sidebar
            find: 'action:"PRESS_SHOW_MORE_ACTIVITY",analyticsLocations:',
            replacement: {
                match: /(?<=renderCards:)\i(?=,heading:)/,
                replace: "$self.wrapActivityCards($&)"
            },
            predicate: () => settings.store.userPopout
        },
    ],
    stop() {
        clearFetchedApplications();
    },
});
