/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, lodash, Menu, MessageStore, openModal, Tooltip, UserStore, useStateFromStores } from "@webpack/common";

import { Boo, clearChannelFromGhost, getGhostedChannels, GHOST_SETTINGS, migrateClearedChannels } from "./Boo";
import { getChannelDisplayName, GhostedUsersModal } from "./GhostedUsersModal";
import { IconGhost } from "./IconGhost";

export const cl = classNameFactory("vc-boo-");

export const settings = definePluginSettings({
    showIndicator: {
        type: OptionType.BOOLEAN,
        description: "Show the ghost counter at the top of the server list",
        default: true,
        restartNeeded: false
    },
    showDmIcons: {
        type: OptionType.BOOLEAN,
        description: "Show ghost icons next to individual DMs",
        default: true,
        restartNeeded: false
    },
    ignoreGroupDms: {
        type: OptionType.BOOLEAN,
        description: "Exclude all group dms from ghosting",
        default: false
    },
    exemptedChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs to exempt from ghosting (right-click a DM channel to copy its ID)",
        default: "",
        restartNeeded: false
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore DMs from bots",
        default: true,
        restartNeeded: false
    },
    maxInactiveTimeMs: {
        type: OptionType.SELECT,
        description: "Only ghost DMs active within this timeframe",
        options: [
            { label: "No limit", value: 0, default: true },
            { label: "1 hour", value: 60 * 60 * 1000 },
            { label: "1 day", value: 24 * 60 * 60 * 1000 },
            { label: "1 week", value: 7 * 24 * 60 * 60 * 1000 },
            { label: "1 month", value: 30 * 24 * 60 * 60 * 1000 },
        ],
        restartNeeded: false
    }
}).withPrivateSettings<{ clearedChannels?: Record<string, string>; clearedChannelsByUser?: Record<string, Record<string, string>>; }>();

function BooIndicator() {
    const values = settings.use(GHOST_SETTINGS);
    const ghostedChannels = useStateFromStores([ChannelStore, MessageStore, UserStore], () => values.showIndicator ? getGhostedChannels() : null,
        GHOST_SETTINGS.map(key => values[key]), lodash.isEqual);
    if (!ghostedChannels?.length) return null;
    const count = ghostedChannels.length;

    const handleClick = () => {
        openModal(modalProps => (
            <ErrorBoundary>
                <GhostedUsersModal
                    modalProps={modalProps}
                    onClearGhost={clearChannelFromGhost}
                />
            </ErrorBoundary>
        ));
    };

    const getTooltipText = () => {
        if (ghostedChannels.length <= 5) {
            return ghostedChannels
                .map(id => getChannelDisplayName(id))
                .join(", ");
        }
        return `${ghostedChannels.length} Ghosted Users`;
    };

    return (
        <div id={cl("container")}>
            <Tooltip text={getTooltipText()} position="right">
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        className={cl("clickable")}
                        onMouseEnter={onMouseEnter}
                        onMouseLeave={onMouseLeave}
                        onClick={handleClick}
                    >
                        {count} <IconGhost fill="currentColor" />
                    </div>
                )}
            </Tooltip>
        </div>
    );
}

function makeContextItem(props) {
    return <Menu.MenuItem
        id="ec-ghosted-clear"
        key="ec-ghosted-clear"
        label="unghost"
        action={() => {
            clearChannelFromGhost(props.channel.id);
        }}
    />;
}

export default definePlugin({
    name: "Ghosted",
    performance: { impact: "medium", description: "Scans direct messages on store updates and adds per-channel indicators." },
    description: "A cute ghost will appear if you don't answer their DMs",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.vei, Devs.sadan, EquicordDevs.justjxke, EquicordDevs.iamme],
    settings,
    dependencies: ["ServerListAPI"],
    contextMenus: {
        "gdm-context": (menuItems, props) => {
            const group = findGroupChildrenByChildId("leave", menuItems, true);
            group?.unshift(makeContextItem(props));
        },
        "user-context": (menuItems, props) => {
            const group = findGroupChildrenByChildId("close-dm", menuItems);
            group?.push(makeContextItem(props));
        }
    },

    patches: [
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /\]:\i\|\|\i.{0,50}children:\[/,
                replace: "$&$self.renderBoo(arguments[0]),"
            }
        },
    ],

    renderBoo(props: { channel: Channel; }) {
        return (
            <ErrorBoundary noop>
                <Boo {...props} />
            </ErrorBoundary>
        );
    },

    renderIndicator() {
        return (
            <ErrorBoundary noop>
                <BooIndicator />
            </ErrorBoundary>
        );
    },

    flux: {
        CONNECTION_OPEN: migrateClearedChannels
    },

    start() {
        migrateClearedChannels();
        addServerListElement(ServerListRenderPosition.Above, this.renderIndicator);
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderIndicator);
    },
});
