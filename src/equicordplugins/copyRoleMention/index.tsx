/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import { getCurrentGuild } from "@utils/discord";
import definePlugin from "@utils/types";
import type { Guild, Role } from "@vencord/discord-types";
import { GuildRoleStore, Menu } from "@webpack/common";

interface RoleContextProps {
    guild?: Guild;
    role?: Role;
}

interface DevContextProps {
    id?: string;
}

function copyRoleMention(roleId: string) {
    copyToClipboard(`<@&${roleId}>`);
}

function addCopyRoleMentionItem(children: React.ReactNode[], role: Role, guildId?: string) {
    if (!role.id || role.id === guildId) return;

    children.push(
        <Menu.MenuItem
            id="vc-copy-role-mention"
            label="Copy Role Mention"
            action={() => copyRoleMention(role.id)}
        />
    );
}

const roleContextPatch: NavContextMenuPatchCallback = (children, { guild, role }: RoleContextProps) => {
    if (!role) return;

    addCopyRoleMentionItem(children, role, guild?.id);
};

const devContextPatch: NavContextMenuPatchCallback = (children, { id }: DevContextProps) => {
    if (!id) return;

    const guild = getCurrentGuild();
    if (!guild) return;

    const role = GuildRoleStore.getRole(guild.id, id);
    if (!role) return;

    addCopyRoleMentionItem(children, role, guild.id);
};

export default definePlugin({
    name: "CopyRoleMention",
    performance: { impact: "low", description: "Adds a copy action when role menus open." },
    description: "Adds context menu items to copy role mentions.",
    tags: ["Chat", "Roles", "Utility"],
    authors: [EquicordDevs.nobody],
    contextMenus: {
        "guild-settings-role-context": roleContextPatch,
        "dev-context": devContextPatch
    }
});
