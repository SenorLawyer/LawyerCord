/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { IconUtils, Menu, Toasts, UserProfileStore } from "@webpack/common";

interface UserContextProps {
    guildId?: string;
    user?: User;
}

const SIZE_QUERY_REGEX = /(?<=[?&]size=)\d+(?=&|#|$)/;
const CDN_SIZE = 4096;

function withCdnSize(url: string | null | undefined) {
    if (!url) return null;
    return url.replace(SIZE_QUERY_REGEX, String(CDN_SIZE));
}

async function copyUrl(label: string, url: string | null) {
    if (!url) {
        Toasts.show({
            id: Toasts.genId(),
            message: `${label} not found.`,
            type: Toasts.Type.FAILURE
        });
        return;
    }

    try {
        await copyToClipboard(url);
    } catch {
        Toasts.show({
            id: Toasts.genId(),
            message: `Could not copy ${label.toLowerCase()}.`,
            type: Toasts.Type.FAILURE
        });
        return;
    }
    Toasts.show({
        id: Toasts.genId(),
        message: `${label} copied.`,
        type: Toasts.Type.SUCCESS
    });
}

function getAvatarUrl(user: User, guildId?: string) {
    return withCdnSize(user.getAvatarURL(guildId, CDN_SIZE, true));
}

function getBannerUrl(userId: string, guildId?: string) {
    const profile = guildId
        ? UserProfileStore.getGuildMemberProfile(userId, guildId)
        : UserProfileStore.getUserProfile(userId);
    const banner = profile?.banner;
    if (!banner) return null;

    const data = { id: userId, banner, canAnimate: true, size: CDN_SIZE };
    return withCdnSize(guildId
        ? IconUtils.getGuildMemberBannerURL({ ...data, guildId })
        : IconUtils.getUserBannerURL(data));
}

const userContextPatch: NavContextMenuPatchCallback = (children, { guildId, user }: UserContextProps) => {
    if (!user) return;

    const avatarUrl = getAvatarUrl(user);
    const serverAvatarUrl = guildId ? getAvatarUrl(user, guildId) : null;
    const bannerUrl = getBannerUrl(user.id);
    const serverBannerUrl = guildId ? getBannerUrl(user.id, guildId) : null;

    children.push(
        <Menu.MenuItem id="vc-copy-user-media-urls" label="Copy User Media URL">
            <Menu.MenuItem
                id="vc-copy-user-avatar-url"
                label="Copy Avatar URL"
                action={() => copyUrl("Avatar URL", avatarUrl)}
            />
            {serverAvatarUrl && serverAvatarUrl !== avatarUrl && (
                <Menu.MenuItem
                    id="vc-copy-user-server-avatar-url"
                    label="Copy Server Avatar URL"
                    action={() => copyUrl("Server avatar URL", serverAvatarUrl)}
                />
            )}
            {bannerUrl && (
                <Menu.MenuItem
                    id="vc-copy-user-banner-url"
                    label="Copy Banner URL"
                    action={() => copyUrl("Banner URL", bannerUrl)}
                />
            )}
            {serverBannerUrl && serverBannerUrl !== bannerUrl && (
                <Menu.MenuItem
                    id="vc-copy-user-server-banner-url"
                    label="Copy Server Banner URL"
                    action={() => copyUrl("Server banner URL", serverBannerUrl)}
                />
            )}
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "CopyUserMediaUrls",
    description: "Adds user context menu items to copy avatar and profile banner URLs.",
    tags: ["Utility"],
    authors: [EquicordDevs.nobody],
    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch
    }
});
