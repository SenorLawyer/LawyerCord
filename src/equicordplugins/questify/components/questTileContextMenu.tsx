/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/index";
import type { Quest } from "@vencord/discord-types";
import { Menu } from "@webpack/common";
import type { ReactNode } from "react";

import { addIgnoredQuest, questIsIgnored, removeIgnoredQuest } from "../settings/ignoredQuests";
import { q } from "../utils/ui";

export function QuestTileContextMenu(
    children: ReactNode[],
    props: { quest?: Quest; },
    isClaimedMenu: boolean = false,
): void {
    const { quest } = props;

    if (!quest) {
        return;
    }

    const isIgnored = questIsIgnored(quest.id);

    children.unshift((
        <Menu.MenuGroup>
            {!isClaimedMenu && (
                <Menu.MenuItem
                    id={q(isIgnored ? "unignore-quest" : "ignore-quest")}
                    label={isIgnored ? "Unmark as Ignored" : "Mark as Ignored"}
                    action={() => isIgnored ? removeIgnoredQuest(quest.id) : addIgnoredQuest(quest.id)}
                />
            )}
            <Menu.MenuItem
                id={q("copy-quest-id")}
                label="Copy Quest ID"
                action={() => copyToClipboard(quest.id)}
            />
        </Menu.MenuGroup>
    ));
}
