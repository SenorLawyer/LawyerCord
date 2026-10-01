/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { registerCommands } from "../api/registry";
import { registerCustomCommands } from "./custom";
import { discordCommands } from "./discordActions";
import { equicordCommands } from "./equicord";
import { navigationCommands } from "./navigation";
import { pluginCommands } from "./pluginManagement";
import { sendDmCommand } from "./sendDm";

export { loadCustomCommands } from "./custom";

export function registerBuiltinCommands() {
    registerCommands("CommandPalette.builtin", [
        ...navigationCommands,
        ...discordCommands,
        ...pluginCommands,
        ...equicordCommands,
        sendDmCommand
    ]);

    registerCustomCommands();
}
