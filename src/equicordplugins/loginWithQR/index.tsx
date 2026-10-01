/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { QrCodeIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import SettingsPlugin from "@plugins/_core/settings";
import { EquicordDevs } from "@utils/constants";
import { getIntlMessage } from "@utils/discord";
import { removeFromArray } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Button } from "@webpack/common";

import openQrModal from "./ui/modals/QrModal";

export const scans = new Set<AbortController>();

const settings = definePluginSettings({
    scanQr: {
        type: OptionType.COMPONENT,
        description: "Scan a QR code",
        component() {
            if (!plugins.LoginWithQR.started)
                return (
                    <Paragraph>
                        Enable the plugin and restart your client to scan a login QR code
                    </Paragraph>
                );

            return (
                <Button size={Button.Sizes.SMALL} onClick={openQrModal}>
                    {getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")}
                </Button>
            );
        },
    },
});

export default definePlugin({
    name: "LoginWithQR",
    description: "Allows you to login to another device by scanning a login QR code, just like on mobile!",
    tags: ["Utility"],
    authors: [EquicordDevs.nexpid],

    settings,

    patches: [
        // Prevent paste event from firing when the QRModal is open
        {
            find: ".clipboardData&&(",
            replacement: {
                match: /handleGlobalPaste:(\i)(?=\}\))/,
                replace: "handleGlobalPaste:(...args)=>!$self.qrModalOpen&&$1(...args)",
            },
        },
    ],

    qrModalOpen: false,

    flux: {
        CONNECTION_OPEN() {
            scans.forEach(scan => scan.abort());
            scans.clear();
        }
    },

    start() {
        SettingsPlugin.customEntries.push({
            key: "equicord_login_with_qr",
            title: getIntlMessage("USER_SETTINGS_SCAN_QR_CODE"),
            Component: openQrModal,
            Icon: QrCodeIcon
        });
    },

    stop() {
        this.qrModalOpen = false;
        scans.forEach(scan => scan.abort());
        scans.clear();
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "equicord_login_with_qr");
    },
});
