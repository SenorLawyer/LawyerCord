/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { get } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heart } from "@components/Heart";
import { PencilIcon } from "@components/Icons";
import { Margins } from "@components/margins";
import { Notice } from "@components/Notice";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { openInviteModal } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { extractAndLoadChunksLazy } from "@webpack";
import { IconUtils, Menu, openModal, UserStore } from "@webpack/common";

import { SetAvatarModal } from "./AvatarModal";

let loadController: AbortController | undefined;
const logger = new Logger("UserPFP");

const cl = classNameFactory("vc-userpfp-");
const DONO_URL = "https://ko-fi.com/coolesding";
const INVITE_LINK = "userpfp-1129784704267210844";
const USERPFP_IMG_URL = "https://raw.githubusercontent.com/UserPFP/img/";

const requireSettingsModal = extractAndLoadChunksLazy(['type:"USER_SETTINGS_MODAL_OPEN"']);
export const KEY_DATASTORE = "vencord-custom-avatars";
export const data = { avatars: {} as Record<string, string>, remoteAvatars: {} as Record<string, string> };

export function isAvatarMap(value: unknown): value is Record<string, string> {
    return isObject(value) && Object.values(value).every(url => typeof url === "string");
}

const settings = definePluginSettings({
    overrideServerAvatars: {
        type: OptionType.BOOLEAN,
        description: "Override server avatars with custom avatars or the default user avatar if no custom avatar is set.",
        default: true,
        restartNeeded: true
    },
    preferNitro: {
        description: "Which avatar to use if both default animated (Nitro) pfp and UserPFP avatars are present",
        type: OptionType.SELECT,
        options: [
            { label: "UserPFP", value: false },
            { label: "Nitro", value: true, default: true },
        ],
    },
    databaseSource: {
        description: "URL to load database from",
        type: OptionType.STRING,
        default: "https://userpfp.github.io/UserPFP/source/data.json",
        hidden: !IS_DEV,
        isValid: value => Boolean(value)
    },
});

export default definePlugin({
    name: "UserPFP",
    description: "Allows you to use an animated avatar without Nitro",
    tags: ["Appearance", "Customisation", "Servers"],
    authors: [EquicordDevs.nexpid, Devs.thororen, EquicordDevs.soapphia, EquicordDevs.sketchmyname],
    settings,
    data,
    settingsAboutComponent: () => (
        <>
            <Notice.Info className={Margins.bottom8}>
                Using the set avatar feature is local only meaning only you see it change.
            </Notice.Info>
            <Flex className={cl("settings")}>
                <Button
                    variant="link"
                    className={cl("settings-button")}
                    onClick={() => openInviteModal(INVITE_LINK)}
                >
                    Join UserPFP Server
                </Button>
                <Button
                    variant="secondary"
                    className={cl("settings-button")}
                    onClick={() => VencordNative.native.openExternal(DONO_URL)}
                >
                    Support UserPFP here <Heart className={cl("settings-heart")} />
                </Button>
            </Flex>
        </>
    ),
    patches: [
        {
            find: "getUserAvatarURL:",
            replacement: [
                {
                    match: /(getUserAvatarURL:)(\i),/,
                    replace: "$1$self.getAvatarHook($2),"
                },
                {
                    match: /(getGuildMemberAvatarURLSimple:)(\i),/,
                    replace: "$1$self.getAvatarServerHook($2),",
                    predicate: () => settings.store.overrideServerAvatars
                }
            ]
        }
    ],
    contextMenus: {
        "user-context": (children, { user }) => {
            if (!user?.id) return;

            children.push(
                <Menu.MenuSeparator />,
                <Menu.MenuItem
                    label="Set Avatar"
                    id="set-avatar"
                    icon={PencilIcon}
                    action={async () => {
                        await requireSettingsModal();
                        openModal(modalProps => <SetAvatarModal userId={user.id} modalProps={modalProps} />);
                    }}
                />
            );
        }
    },
    getAvatarHook: (original: typeof IconUtils.getUserAvatarURL) => (...args: Parameters<typeof original>) => {
        const [user, animated] = args;
        if (settings.store.preferNitro && user.avatar?.startsWith("a_")) return original(...args);
        const avatarUrl = data.avatars[user.id] || data.remoteAvatars[user.id];
        if (!avatarUrl) return original(...args);

        if (avatarUrl.startsWith("data:")) return avatarUrl;

        try {
            const res = new URL(avatarUrl);
            if (avatarUrl.startsWith(USERPFP_IMG_URL)) {
                res.searchParams.set("animated", animated ? "true" : "false");
                if (!animated) {
                    res.pathname = res.pathname.replace(/\.gifv?$/, ".png");
                }
            }
            return res.toString();
        } catch {
            return original(...args);
        }
    },
    getAvatarServerHook: (original: typeof IconUtils.getGuildMemberAvatarURLSimple) => (config: Parameters<typeof original>[0]) => {
        const { userId, avatar, size, canAnimate, canWebP } = config;
        const customUrl = data.avatars[userId] || data.remoteAvatars[userId];

        if (customUrl) return customUrl;

        if (avatar) {
            const user = UserStore.getUser(userId);
            if (user?.avatar) {
                return IconUtils.getUserAvatarURL(user, canAnimate, size, undefined, canWebP);
            }
        }

        return original(config);
    },
    async start() {
        loadController?.abort();
        const controller = loadController = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const local = await get<unknown>(KEY_DATASTORE);
            if (controller.signal.aborted) return;
            if (local === undefined) data.avatars = {};
            else if (isAvatarMap(local)) data.avatars = local;
            else logger.warn("Stored custom avatars are invalid.");
            data.remoteAvatars = {};

            timeout = setTimeout(() => {
                if (controller.signal.aborted) return;
                logger.error("Avatar database download timed out.");
                controller.abort();
            }, 30_000);
            const response = await fetch(settings.store.databaseSource, { signal: controller.signal });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error("Could not download the avatar database.");
            }
            if (!response.body) throw new Error("Empty avatar database response.");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let size = 0;
            let text = "";
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 5 * 1024 * 1024) throw new Error("Avatar database exceeds 5 MiB.");
                    text += decoder.decode(value, { stream: true });
                }
            } finally {
                try {
                    await reader.cancel();
                } finally {
                    reader.releaseLock();
                }
            }
            const remote: unknown = JSON.parse(text + decoder.decode());
            if (controller.signal.aborted) return;
            if (!isObject(remote) || !("avatars" in remote) || !isAvatarMap(remote.avatars))
                throw new Error("Invalid avatar database.");
            data.remoteAvatars = remote.avatars;
        } catch {
            if (!controller.signal.aborted) logger.error("Could not load avatars.");
        } finally {
            clearTimeout(timeout);
        }
    },
    stop() {
        loadController?.abort();
        loadController = undefined;
    }
});
