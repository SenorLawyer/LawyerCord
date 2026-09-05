/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BadgePosition, ProfileBadge } from "@api/Badges";
import { Button } from "@components/Button";
import { BadgeContextMenu } from "@plugins/_api/badges";
import { Devs, EquicordDevs } from "@utils/constants";
import { openInviteModal } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { ContextMenuApi, React, Toasts } from "@webpack/common";

import { settings } from "./settings";
import { cancelBadgeLoad, cl, getBadges, INVITE_LINK, loadBadges, refreshBadges } from "./utils";

let intervalId: ReturnType<typeof setInterval> | undefined;

export default definePlugin({
    name: "GlobalBadges",
    description: "Adds global badges from other client mods",
    tags: ["Appearance"],
    authors: [Devs.HypedDomi, EquicordDevs.Wolfie, Devs.thororen],
    settings,
    settingsAboutComponent: () => (
        <Button
            variant="link"
            className={cl("settings-button")}
            onClick={() => openInviteModal(INVITE_LINK)}
        >
            Join GlobalBadges Server
        </Button>
    ),
    start() {
        clearInterval(intervalId);
        intervalId = setInterval(refreshBadges, 1000 * 60 * 30);
        void refreshBadges();
    },
    stop() {
        cancelBadgeLoad();
        clearInterval(intervalId);
        intervalId = undefined;
    },
    toolboxActions: {
        async "Refetch Global Badges"() {
            try {
                await loadBadges();
                Toasts.show({ id: Toasts.genId(), message: "Successfully refetched global badges!", type: Toasts.Type.SUCCESS });
            } catch (error) {
                new Logger("GlobalBadges").error("Failed to refresh badges", error);
                Toasts.show({ id: Toasts.genId(), message: "Could not refresh global badges. Try again later.", type: Toasts.Type.FAILURE });
            }
        }
    },
    getGlobalBadges(userId: string) {
        return getBadges(userId)?.map((badge, idx) => ({
            id: `global_badges_badge_${idx}`,
            iconSrc: badge.badge,
            description: badge.tooltip,
            position: BadgePosition.START,
            props: {
                style: {
                    borderRadius: "50%",
                    transform: "scale(0.9)"
                }
            },
            onContextMenu(event, badge) {
                ContextMenuApi.openContextMenu(event, () => <BadgeContextMenu badge={badge} />);
            },
        } satisfies ProfileBadge));
    }
});
