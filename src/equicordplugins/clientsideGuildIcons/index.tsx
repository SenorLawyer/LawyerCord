/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, update } from "@api/DataStore";
import { ImageIcon, ResetIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { chooseFile } from "@utils/web";
import { Guild } from "@vencord/discord-types";
import { FluxDispatcher, GuildStore, Menu, Toasts } from "@webpack/common";

import { normalizeStoredGuildIcons, readStoredGuildIcons } from "./iconStorage";

const KEY_DATASTORE = "lawyercord-clientside-guild-icons";
const IMAGE_EXTENSION_REGEX = /\.(apng|avif|gif|jpe?g|png|webp)$/i;
const MAX_ICON_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export const data = {
    icons: {} as Record<string, string>,
};

let startGeneration = 0;
let active = false;

function showToast(message: string, type: string) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type,
    });
}

function getImageType(file: File) {
    if (file.type.startsWith("image/")) return file.type;
    const extension = IMAGE_EXTENSION_REGEX.exec(file.name)?.[1].toLowerCase();
    return extension ? `image/${extension === "jpg" ? "jpeg" : extension}` : undefined;
}

function replaceRuntimeIcon(guildId: string, icon: Blob) {
    const previousIconUrl = data.icons[guildId];
    data.icons[guildId] = URL.createObjectURL(icon);
    if (previousIconUrl) URL.revokeObjectURL(previousIconUrl);
}

function revokeRuntimeIcons() {
    Object.values(data.icons).forEach(iconUrl => URL.revokeObjectURL(iconUrl));
}

function refreshGuildIcon(guildId: string) {
    (GuildStore as typeof GuildStore & { emitChange?: () => void; }).emitChange?.();

    const guild = GuildStore.getGuild(guildId);
    if (guild) {
        FluxDispatcher.dispatch({ type: "GUILD_UPDATE", guild });
    }
}

async function setGuildIcon(guild: Guild, icon: Blob | undefined, generation = startGeneration) {
    if (!active || generation !== startGeneration) return false;
    await update<unknown>(KEY_DATASTORE, value => {
        if (!active || generation !== startGeneration) return value;
        const icons = { ...readStoredGuildIcons(value) };
        if (icon) icons[guild.id] = icon;
        else delete icons[guild.id];
        return icons;
    });
    if (!active || generation !== startGeneration) return false;
    if (icon) replaceRuntimeIcon(guild.id, icon);
    else {
        URL.revokeObjectURL(data.icons[guild.id]);
        delete data.icons[guild.id];
    }
    refreshGuildIcon(guild.id);
    return true;
}

async function changeGuildIcon(guild: Guild) {
    const generation = startGeneration;
    const file = await chooseFile("image/*");
    if (!file || !active || generation !== startGeneration) return;

    const type = getImageType(file);
    if (!type) {
        showToast("Please select an image file.", Toasts.Type.FAILURE);
        return;
    }

    if (file.size > MAX_ICON_FILE_SIZE_BYTES) {
        showToast("Please select an image under 2 MB.", Toasts.Type.FAILURE);
        return;
    }

    try {
        if (await setGuildIcon(guild, file.type === type ? file : file.slice(0, file.size, type), generation))
            showToast(`Changed local icon for ${guild.name}.`, Toasts.Type.SUCCESS);
    } catch (error) {
        showToast("Failed to save that local server icon.", Toasts.Type.FAILURE);
    }
}

function getGuildId(config: unknown) {
    return typeof config === "object" && config !== null && "id" in config && typeof config.id === "string"
        ? config.id
        : undefined;
}

export default definePlugin({
    name: "ClientsideGuildIcons",
    description: "Change server icons locally from the server right-click menu.",
    tags: ["Appearance", "Customisation", "Servers"],
    authors: [EquicordDevs.nobody],
    dependencies: ["ContextMenuAPI"],
    data,

    patches: [
        {
            find: "getGuildIconURL:",
            replacement: {
                match: /(getGuildIconURL:)(\i),/,
                replace: "$1$self.getGuildIconURLHook($2),"
            },
        },
    ],

    contextMenus: {
        "guild-context": (children, { guild }) => {
            if (!guild?.id) return;

            const hasCustomIcon = Boolean(data.icons[guild.id]);

            children.splice(-1, 0, (
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="vc-change-clientside-guild-icon"
                        label="Change Clientside Icon"
                        icon={ImageIcon}
                        action={() => void changeGuildIcon(guild)}
                    />
                    {hasCustomIcon && (
                        <Menu.MenuItem
                            id="vc-reset-clientside-guild-icon"
                            label="Reset Clientside Icon"
                            icon={ResetIcon}
                            color="danger"
                            action={async () => {
                                try {
                                    if (await setGuildIcon(guild, undefined))
                                        showToast(`Reset local icon for ${guild.name}.`, Toasts.Type.SUCCESS);
                                } catch {
                                    showToast("Failed to reset that local server icon.", Toasts.Type.FAILURE);
                                }
                            }}
                        />
                    )}
                </Menu.MenuGroup>
            ));
        },
    },

    getGuildIconURLHook: (original: (...args: unknown[]) => string | null | undefined) => function (this: unknown, config: unknown, ...args: unknown[]) {
        const guildId = getGuildId(config);
        const customIcon = guildId ? data.icons[guildId] : undefined;

        if (customIcon) return customIcon;

        return original.call(this, config, ...args);
    },

    async start() {
        const generation = ++startGeneration;
        active = false;
        const storedData = await get<unknown>(KEY_DATASTORE);
        const icons = await normalizeStoredGuildIcons(storedData);
        if (generation !== startGeneration) return;

        active = true;
        data.icons = {};
        for (const [guildId, icon] of Object.entries(icons)) {
            data.icons[guildId] = URL.createObjectURL(icon);
        }
        for (const guildId in data.icons) {
            refreshGuildIcon(guildId);
        }
    },

    stop() {
        startGeneration++;
        active = false;

        const guildIds = Object.keys(data.icons);
        revokeRuntimeIcons();
        data.icons = {};

        for (const guildId of guildIds) {
            refreshGuildIcon(guildId);
        }
    }
});
