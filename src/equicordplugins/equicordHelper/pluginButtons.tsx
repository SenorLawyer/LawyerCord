/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { isEquicordGuild, isEquicordSupport } from "@utils/misc";
import { Message } from "@vencord/discord-types";
import { Button, showToast, Toasts } from "@webpack/common";

import { toggleEnabled } from "./utils";

const logger = new Logger("LawyerCordHelper");

export const PluginButtons = ErrorBoundary.wrap(function PluginButtons({ message }: { message: Message; }) {
    const msg = message.content?.toLowerCase() ?? "";

    const startsWithEnabled = msg.startsWith("enable");
    const startsWithDisabled = msg.startsWith("disable");
    if (!(startsWithEnabled || startsWithDisabled) || !isEquicordGuild(message.channel_id) || !isEquicordSupport(message.author.id)) return null;

    const contentWords = (msg.match(/`\w+`/g) ?? []).map(e => e.slice(1, -1));
    if (!contentWords.length) return null;
    const matchedPlugin = Object.keys(plugins)
        .filter(name => contentWords.includes(name.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
    if (!matchedPlugin) return null;
    const pluginData = plugins[matchedPlugin];
    if (pluginData.required || pluginData.name.endsWith("API")) return null;

    const isEnabled = isPluginEnabled(matchedPlugin);

    let label = `${matchedPlugin} is already ${isEnabled ? "enabled" : "disabled"}`;
    let disabled = true;

    if ((startsWithDisabled && isEnabled) || (startsWithEnabled && !isEnabled)) {
        label = `${isEnabled ? "Disable" : "Enable"} ${matchedPlugin}`;
        disabled = false;
    }

    return (
        <div className="vc-plugins-action-buttons">
            <Button
                key="vc-plugin-toggle"
                color={disabled ? Button.Colors.PRIMARY : (isEnabled ? Button.Colors.RED : Button.Colors.GREEN)}
                disabled={disabled}
                size={Button.Sizes.SMALL}
                onClick={async () => {
                    try {
                        const success = await toggleEnabled(matchedPlugin);
                        if (success) showToast(`${label}`, Toasts.Type.SUCCESS);
                    } catch (e) {
                        logger.error("Error while toggling:", e);
                        showToast(`Failed to ${label.toLowerCase()}`, Toasts.Type.FAILURE);
                    }
                }}
            >
                {label}
            </Button>
        </div>
    );
}, { noop: true });
