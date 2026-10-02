/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { CallStore, FluxDispatcher, Menu, Tooltip, UserStore } from "@webpack/common";

interface CallUpdate {
    type: string;
    channelId?: string;
    ringing?: string[];
    ongoingRings?: string[];
}

const ignoredChannelIds = new Set<string>();
let permanentlyIgnoredChannelIds = new Set<string>();
let started = false;
const cl = classNameFactory("vc-ignore-calls-");
const Deafen = findComponentByCodeLazy("0-1.02-.1H3.05a9");

function shouldIgnore(channelId: string) {
    return ignoredChannelIds.has(channelId) || permanentlyIgnoredChannelIds.has(channelId);
}

function filterCall(event: CallUpdate) {
    if (event.type !== "CALL_CREATE" && event.type !== "CALL_UPDATE") return;
    if (!event.channelId || !shouldIgnore(event.channelId)) return;
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return;
    if (event.ringing?.includes(currentUserId)) event.ringing = event.ringing.filter(id => id !== currentUserId);
    if (event.ongoingRings?.includes(currentUserId)) event.ongoingRings = event.ongoingRings.filter(id => id !== currentUserId);
}

function ignoreCall(channelId: string) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const call = CallStore.getCall(channelId);
    if (!currentUserId || !call?.ringing.includes(currentUserId)) return;
    FluxDispatcher.dispatch({
        type: "CALL_UPDATE",
        channelId,
        ringing: call.ringing.filter(id => id !== currentUserId),
        messageId: call.messageId,
        region: call.region
    });
}

const ContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel; }) => {
    if (!channel) return;

    children.push(
        <>
            <Menu.MenuSeparator />
            <Menu.MenuCheckboxItem
                id="vc-ignore-calls-temp"
                label="Temporarily Ignore Calls"
                checked={ignoredChannelIds.has(channel.id)}
                action={() => {
                    const ignored = ignoredChannelIds.has(channel.id);
                    if (ignored)
                        ignoredChannelIds.delete(channel.id);
                    else {
                        ignoredChannelIds.add(channel.id);
                        ignoreCall(channel.id);
                    }
                }}
            />
            <Menu.MenuCheckboxItem
                id="vc-ignore-calls-perm"
                label="Permanently Ignore Calls"
                checked={permanentlyIgnoredChannelIds.has(channel.id)}
                action={() => {
                    let updated = settings.store.permanentlyIgnoredUsers.split(",").map(s => s.trim()).filter(Boolean);
                    if (updated.includes(channel.id)) {
                        updated = updated.filter(id => id !== channel.id);
                    } else {
                        updated.push(channel.id);
                    }
                    settings.store.permanentlyIgnoredUsers = updated.join(", ");
                }}
            />
        </>
    );
};

const settings = definePluginSettings({
    permanentlyIgnoredUsers: {
        type: OptionType.STRING,
        description: "Comma separated DM channel IDs whose calls should be ignored.",
        onChange: value => {
            permanentlyIgnoredChannelIds = new Set(value.split(",").map(id => id.trim()).filter(Boolean));
            if (started) {
                for (const channelId of permanentlyIgnoredChannelIds) ignoreCall(channelId);
            }
        },
        default: "",
    },
});

export default definePlugin({
    name: "IgnoreCalls",
    description: "Allows you to ignore calls from specific users or dm groups.",
    tags: ["Voice"],
    authors: [EquicordDevs.TheArmagan, Devs.thororen],
    settings,
    patches: [
        {
            find: "#{intl::INCOMING_CALL_ELLIPSIS}",
            replacement: {
                match: /(?<=onCallJoined:\(\).{0,150})\(\i\)\}\),className:\i\.\i\}\)/,
                replace: "$&,$self.renderIgnore(arguments[0].channel)"
            }
        }
    ],
    contextMenus: {
        "user-context": ContextMenuPatch,
        "gdm-context": ContextMenuPatch,
    },
    start() {
        started = true;
        permanentlyIgnoredChannelIds = new Set(settings.store.permanentlyIgnoredUsers.split(",").map(id => id.trim()).filter(Boolean));
        FluxDispatcher.addInterceptor(filterCall);
        for (const call of CallStore.getCalls()) {
            if (shouldIgnore(call.channelId)) ignoreCall(call.channelId);
        }
    },
    stop() {
        started = false;
        const index = FluxDispatcher._interceptors.indexOf(filterCall);
        if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
        ignoredChannelIds.clear();
        permanentlyIgnoredChannelIds.clear();
    },
    flux: {
        CONNECTION_OPEN() {
            ignoredChannelIds.clear();
        }
    },
    renderIgnore(channel: Channel) {
        if (shouldIgnore(channel.id)) return null;

        return (
            <ErrorBoundary>
                <Tooltip text="Ignore">
                    {({ onMouseEnter, onMouseLeave }) => (
                        <Button
                            className={cl("button")}
                            size="small"
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            onClick={() => ignoreCall(channel.id)}
                        >
                            <Deafen color={"var(--interactive-icon-active)"} />
                        </Button>
                    )}
                </Tooltip>
            </ErrorBoundary>
        );
    }
});
