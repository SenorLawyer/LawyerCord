/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { SafetyIcon } from "@components/Icons";
import { TooltipContainer } from "@components/TooltipContainer";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import type { Guild, RoleOrUserPermission } from "@vencord/discord-types";
import { PermissionOverwriteType } from "@vencord/discord-types/enums";
import { findCssClassesLazy } from "@webpack";
import { Button, ChannelStore, Dialog, GuildMemberStore, GuildRoleStore, GuildStore, Menu, PermissionsBits, Popout, useRef, UserStore, useStateFromStores } from "@webpack/common";

import openRolesAndUsersPermissionsModal from "./components/RolesAndUsersPermissions";
import UserPermissions from "./components/UserPermissions";
import { getSortedRolesForMember, loadGetGuildPermissionSpecMap, sortPermissionOverwrites } from "./utils";

const PopoutClasses = findCssClassesLazy("container", "popoutRoleDot");
const logger = new Logger("PermissionsViewer");

export const enum PermissionsSortOrder {
    HighestRole,
    LowestRole
}

type MenuItemParentType = "user" | "channel" | "guild";

export const settings = definePluginSettings({
    permissionsSortOrder: {
        description: "The sort method used for defining which role grants an user a certain permission",
        type: OptionType.SELECT,
        options: [
            { label: "Highest Role", value: PermissionsSortOrder.HighestRole, default: true },
            { label: "Lowest Role", value: PermissionsSortOrder.LowestRole }
        ]
    },
}).withPrivateSettings<{ unsafeViewAsRole?: boolean; }>();

function MenuItem(guildId: string, id: string, type: MenuItemParentType) {
    if (type === "user" && !GuildMemberStore.isMember(guildId, id)) return null;

    return (
        <Menu.MenuItem
            id="perm-viewer-permissions"
            label="Permissions"
            action={() => {
                const guild = GuildStore.getGuild(guildId);
                if (!guild) return;

                let permissions: RoleOrUserPermission[];
                let header: string;
                switch (type) {
                    case "user": {
                        const member = GuildMemberStore.getMember(guildId, id);
                        if (!member) return;

                        permissions = getSortedRolesForMember(guild, member)
                            .map(role => ({
                                type: PermissionOverwriteType.ROLE,
                                ...role
                            }));

                        if (guild.ownerId === id) {
                            permissions.push({
                                type: PermissionOverwriteType.OWNER,
                                permissions: Object.values(PermissionsBits).reduce((prev, curr) => prev | curr, 0n)
                            });
                        }

                        header = member.nick ?? UserStore.getUser(member.userId)?.username ?? "Unknown User";
                        break;
                    }
                    case "channel": {
                        const channel = ChannelStore.getChannel(id);
                        if (!channel) return;

                        permissions = sortPermissionOverwrites(Object.values(channel.permissionOverwrites).map(({ id, allow, deny, type }) => ({
                            type,
                            id,
                            overwriteAllow: allow,
                            overwriteDeny: deny
                        })), guildId);
                        header = channel.name;
                        break;
                    }
                    case "guild":
                        permissions = GuildRoleStore.getSortedRoles(guild.id).map(role => ({
                            type: PermissionOverwriteType.ROLE,
                            ...role
                        }));
                        header = guild.name;
                        break;
                }

                openRolesAndUsersPermissionsModal(permissions, guild, header);
            }}
        />
    );
}

function makeContextMenuPatch(childId: string | string[], type: MenuItemParentType): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props) return;
        const guildId = type === "user" ? props.guildId : props.guild?.id;
        const id = type === "user" ? props.user?.id : type === "channel" ? props.channel?.id : guildId;
        if (!guildId || !id) return;

        const item = MenuItem(guildId, id, type);
        if (item == null) return;

        const group = findGroupChildrenByChildId(childId, children);
        if (group) {
            return group.push(item);
        }

        // "roles" may not be present due to the member not having any roles. In that case, add it above "Copy ID"
        if (childId === "roles") {
            children.splice(-1, 0, <Menu.MenuGroup>{item}</Menu.MenuGroup>);
        }
    };
}

export default definePlugin({
    name: "PermissionsViewer",
    description: "View the permissions a user or channel has, and the roles of a server",
    tags: ["Servers", "Roles", "Utility"],
    authors: [Devs.Nuckyz, Devs.Ven],
    settings,

    patches: [
        {
            find: "#{intl::COLLAPSE_ROLES}",
            replacement: {
                match: /(?<=\i\.id\)\),\i\(\))(?=,\i\?)/,
                replace: ",$self.ViewPermissionsButton(arguments[0])"
            }
        }
    ],

    ViewPermissionsButton: ErrorBoundary.wrap(({ className, guild, userId }: { className: string; guild: Guild; userId: string; }) => {
        const buttonRef = useRef(null);
        const [permissionsReady] = useAwaiter(loadGetGuildPermissionSpecMap, {
            fallbackValue: false,
            onError: () => logger.error("Could not load permission details.")
        });

        const guildMember = useStateFromStores([GuildMemberStore], () => GuildMemberStore.getMember(guild.id, userId), [guild.id, userId]);
        if (!guildMember || !permissionsReady) return null;

        return (
            <Popout
                position="bottom"
                align="center"
                targetElementRef={buttonRef}
                renderPopout={({ closePopout }) => (
                    <Dialog className={PopoutClasses.container} style={{ width: "500px" }}>
                        <UserPermissions guild={guild} guildMember={guildMember} closePopout={closePopout} />
                    </Dialog>
                )}
            >
                {popoutProps => (
                    <TooltipContainer text="View Permissions">
                        <Button
                            {...popoutProps}
                            aria-label="View Permissions"
                            ref={buttonRef}
                            color={Button.Colors.CUSTOM}
                            look={Button.Looks.FILLED}
                            size={Button.Sizes.NONE}
                            className={classes(className, "vc-permviewer-role-button")}
                        >
                            <SafetyIcon height="16" width="16" />
                        </Button>
                    </TooltipContainer>
                )}
            </Popout>
        );
    }, { noop: true }),

    contextMenus: {
        "user-context": makeContextMenuPatch("roles", "user"),
        "channel-context": makeContextMenuPatch(["mute-channel", "unmute-channel"], "channel"),
        "guild-context": makeContextMenuPatch("privacy", "guild"),
        "guild-header-popout": makeContextMenuPatch("privacy", "guild")
    }
});
