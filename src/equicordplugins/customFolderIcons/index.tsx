/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 sadan
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { parseUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import type { ReactNode } from "react";

import { makeContextItem } from "./components";
import { settings } from "./settings";
import { folderProp, int2rgba } from "./util";

interface FolderIconProps {
    folderNode: { id: string; color: number; };
    original: ReactNode;
}

const SETTINGS: ("folderIcons" | "solidIcon")[] = ["folderIcons", "solidIcon"];

export default definePlugin({
    name: "CustomFolderIcons",
    description: "Customize folder icons with any png",
    tags: ["Appearance", "Customisation", "Organisation"],
    authors: [EquicordDevs.sadan],
    settings,
    patches: [
        {
            find: "#{intl::GUILD_FOLDER_TOOLTIP_A11Y_LABEL}",
            replacement: {
                match: /(\(0,\i\.jsx\)\(\i,\{folderNode:(\i),hovered:\i,sorting:\i\}\))/,
                replace: "$self.replace({folderNode:$2,original:$1})"
            }
        },
    ],
    contextMenus: {
        "guild-context": (menuItems, props: folderProp) => {
            if (!("folderId" in props)) return;
            menuItems.push(makeContextItem(props));
        }
    },
    replace: ErrorBoundary.wrap((props: FolderIconProps) => {
        const { folderIcons, solidIcon } = settings.use(SETTINGS);
        const data = folderIcons?.[props.folderNode.id];
        if (!data || !parseUrl(data.url)) return props.original;
        return (
            <div
                style={{
                    backgroundColor: int2rgba(props.folderNode.color, solidIcon ? 1 : .4),
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    width: "100%",
                    height: "100%"
                }}
            >
                <img alt="" src={data.url} width={`${data.size ?? 100}%`} height={`${data.size ?? 100}%`} />
            </div>
        );
    }, { noop: true })
});
