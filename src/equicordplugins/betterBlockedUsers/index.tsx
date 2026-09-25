/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { getIntlMessage, openUserProfile } from "@utils/discord";
import definePlugin from "@utils/types";
import { Button, React, TextInput, UserStore } from "@webpack/common";
import type { ReactNode } from "react";

export default definePlugin({
    name: "BetterBlockedUsers",
    description: "Allows you to search in blocked users list and makes names selectable in settings.",
    tags: ["Appearance", "Shortcuts"],
    authors: [EquicordDevs.TheArmagan],
    patches: [
        {
            find: '"],{numberOfBlockedUsers:',
            group: true,
            replacement: [
                {
                    match: /(?<=\(0,\i\.jsx\)\(\i,\{listType:(\i),numberOfUsers:\i\.length\}\),)/,
                    replace: "$1==='blocked'?$self.renderSearchInput(vcSearch,vcSetSearch):null,"
                },
                {
                    match: /(?<=\.globalName\?\i\.username:null\}\)\]\}\)\]\}\),)\(0,\i\.jsx\)\(\i\.\i,\{.{0,150}?,loading:\i\}\)/,
                    replace: "$self.renderUser(arguments[0].userId,$&)",
                },
                {
                    match: /(?<=userIds:(\i),listType:(\i)\}=\i,\[\i,\i\]=(\i)\.useState\(\d+\);)/,
                    replace: "let[vcSearch,vcSetSearch]=$3.useState(\"\");$1=$self.getFilteredUsers($1,$2,vcSearch);"
                },
            ]
        }
    ],
    renderSearchInput(value: string, setValue: (value: string) => void) {
        return <ErrorBoundary noop><div className="vc-bbu-search">
            <TextInput
                placeholder="Search users..."
                style={{ width: "200px" }}
                onChange={setValue}
                value={value}
            />
        </div></ErrorBoundary>;
    },
    renderUser(userId: string, rest: ReactNode) {
        return (
            <div style={{ display: "flex", gap: "8px" }}>
                <Button color={Button.Colors.PRIMARY} onClick={() => openUserProfile(userId)}>
                    {getIntlMessage("SHOW_USER_PROFILE")}
                </Button>
                {rest}
            </div>
        );
    },
    getFilteredUsers(userIds: string[], listType: string, search: string) {
        search = search.toLowerCase().trim();
        if (listType !== "blocked" || !search) return userIds;
        return userIds.filter(id => {
            const user = UserStore.getUser(id);
            if (!user) return id === search;
            return id === search || user.username.toLowerCase().includes(search) || user.globalName?.toLowerCase().includes(search);
        });
    }
});
