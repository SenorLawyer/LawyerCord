/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { ImageIcon, ResetIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { chooseFile } from "@utils/web";
import { Guild } from "@vencord/discord-types";
import { FluxDispatcher, GuildStore, Menu, Toasts } from "@webpack/common";

import { normalizeStoredGuildIcons } from "./iconStorage";

const KEY_DATASTORE = "lawyercord-clientside-guild-icons";
const IMAGE_EXTENSION_REGEX = /\.(apng|avif|gif|jpe?g|png|webp)$/i;
const MAX_ICON_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export const data = {
    icons: {} as Record<string, string>,
};

let startGeneration = 0;
let storedIcons: Record<string, Blob> = {};

function showToast(message: string, type: string) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type,
    });
}

function isImageFile(file: File) {
    return file.type.startsWith("image/") || IMAGE_EXTENSION_REGEX.test(file.name);
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

async function saveGuildIcon(guild: Guild, icon: Blob) {
    const nextStoredIcons = { ...storedIcons, [guild.id]: icon };
    await set(KEY_DATASTORE, nextStoredIcons);
    storedIcons = nextStoredIcons;
    replaceRuntimeIcon(guild.id, icon);
    refreshGuildIcon(guild.id);
}

async function deleteGuildIcon(guild: Guild) {
    if (!storedIcons[guild.id]) return;

    const nextStoredIcons = { ...storedIcons };
    delete nextStoredIcons[guild.id];
    await set(KEY_DATASTORE, nextStoredIcons);

    storedIcons = nextStoredIcons;
    URL.revokeObjectURL(data.icons[guild.id]);
    delete data.icons[guild.id];
    refreshGuildIcon(guild.id);
}

async function changeGuildIcon(guild: Guild) {
    const file = await chooseFile("image/*");
    if (!file) return;

    if (!isImageFile(file)) {
        showToast("Please select an image file.", Toasts.Type.FAILURE);
        return;
    }

    if (file.size > MAX_ICON_FILE_SIZE_BYTES) {
        showToast("Please select an image under 2 MB.", Toasts.Type.FAILURE);
        return;
    }

    try {
        await saveGuildIcon(guild, file);
        showToast(`Changed local icon for ${guild.name}.`, Toasts.Type.SUCCESS);
    } catch (error) {
        showToast("Failed to save that local server icon.", Toasts.Type.FAILURE);
    }
}

function getGuildId(config: unknown) {
    return typeof config === "object" && config !== null && "id" in config
        ? String((config as { id?: string; }).id)
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
                                await deleteGuildIcon(guild);
                                showToast(`Reset local icon for ${guild.name}.`, Toasts.Type.SUCCESS);
                            }}
                        />
                    )}
                </Menu.MenuGroup>
            ));
        },
    },

    getGuildIconURLHook: (original: (...args: any[]) => string | null | undefined) => function (this: unknown, config: unknown, ...args: any[]) {
        const guildId = getGuildId(config);
        const customIcon = guildId ? data.icons[guildId] : undefined;

        if (customIcon) return customIcon;

        return original.call(this, config, ...args);
    },

    async start() {
        const generation = ++startGeneration;
        const storedData = await get<unknown>(KEY_DATASTORE);
        const normalized = await normalizeStoredGuildIcons(storedData);
        if (normalized.needsWrite) await set(KEY_DATASTORE, normalized.icons);
        if (generation !== startGeneration) return;

        storedIcons = normalized.icons;
        data.icons = {};
        for (const [guildId, icon] of Object.entries(storedIcons)) {
            data.icons[guildId] = URL.createObjectURL(icon);
        }
        for (const guildId in data.icons) {
            refreshGuildIcon(guildId);
        }
    },

    stop() {
        startGeneration++;

        const guildIds = Object.keys(data.icons);
        revokeRuntimeIcons();
        data.icons = {};
        storedIcons = {};

        for (const guildId of guildIds) {
            refreshGuildIcon(guildId);
        }
    }
});
