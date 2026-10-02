/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { OverridePremiumTypeStore } from "@webpack/common";

export default definePlugin({
    name: "NoNitroUpsell",
    description: "Removes all of Discord's nitro upsells by tricking the client into thinking you have nitro.",
    tags: ["Utility"],
    authors: [Devs.thororen],
    flux: {
        CONNECTION_OPEN() {
            OverridePremiumTypeStore.getState().premiumTypeOverride = 2;
        }
    },
    start() {
        OverridePremiumTypeStore.getState().premiumTypeOverride = 2;
    },
    stop() {
        OverridePremiumTypeStore.getState().premiumTypeOverride = undefined;
    }
});
