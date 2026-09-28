/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Message } from "@vencord/discord-types";
import { Alerts, ChannelStore, useEffect, useState } from "@webpack/common";

import userpluginInstaller, { Native, OpenSettingsModule, settings } from "..";
import { CLONE_LINK_REGEX, showInstallFinishedAlert, WHITELISTED_SHARE_CHANNELS } from "../misc/constants";

interface Props {
    message: Message;
}

export default function UserpluginInstallButton({ message }: Props) {
    const [plugins, setPlugins] = useState<{
        directory?: string;
    }[]>([]);
    useEffect(() => {
        const { plugins } = userpluginInstaller;

        setPlugins(plugins.value());
        const cid = plugins.registerCallback(setPlugins);
        return () => plugins.deregisterCallback(cid);
    }, []);
    const allowedChannels = [...WHITELISTED_SHARE_CHANNELS, ...(settings.store.allowlistedChannels || "").split(",").map(id => id.trim()).filter(Boolean)];
    const parentId = ChannelStore.getChannel(message.channel_id)?.parent_id;
    if (!allowedChannels.includes(message.channel_id) && !(parentId && allowedChannels.includes(parentId)))
        return null;
    const gitLink = message.content.match(CLONE_LINK_REGEX);
    if (!gitLink) return null;
    const idpl = gitLink.includes("plugins.nin0.dev") ? 1 : 0;
    const installed = plugins.some(p => p.directory === gitLink[[3, 6][idpl]]);
    return <>
        <div style={{ display: "flex" }}>
            <Button style={{
                marginTop: "5px"
            }}
                variant={installed ? "secondary" : "primary"}
                onClick={async () => {
                    if (installed) return void OpenSettingsModule.openUserSettings("vencord_userplugins_panel");
                    try {
                        const { name, native } = await Native.initPluginInstall(gitLink[0], gitLink[[1, 4][idpl]], gitLink[[2, 5][idpl]], gitLink[[3, 6][idpl]]);
                        showInstallFinishedAlert(name, native);
                    }
                    catch (e) {
                        const error = String(e);
                        if (error.includes("silentStop")) return;
                        Alerts.show({
                            title: "Install error",
                            body: error
                        });
                    }
                }}>
                {installed ? "Manage plugins" : "Install plugin"}
            </Button>
        </div>
    </>;
}
