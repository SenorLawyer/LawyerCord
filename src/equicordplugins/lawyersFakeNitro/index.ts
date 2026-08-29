/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LawyersFakeNitro",
    description: "Unlocks high-quality streaming without changing other Nitro features.",
    authors: [EquicordDevs.SenorLawyer],

    patches: [
        {
            find: "canStreamQuality:function",
            replacement: {
                match: /(?<=canStreamQuality:function\(\i,\i\)\{)/,
                replace: "return true;"
            }
        }
    ]
});
