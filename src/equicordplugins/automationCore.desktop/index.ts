/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "AutomationCore",
    description: "Stores automation credentials in the operating system vault and runs approved AI requests.",
    authors: [EquicordDevs.SenorLawyer],
    required: true,
    hidden: true,
});
