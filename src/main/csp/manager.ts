/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings } from "@main/settings";
import { IpcEvents } from "@shared/IpcEvents";
import { dialog, ipcMain, IpcMainInvokeEvent } from "electron";

import { CspPolicies, ImageAndCssSrc } from ".";

export type CspRequestResult = "invalid" | "cancelled" | "unchecked" | "ok" | "conflict";

export function registerCspIpcHandlers() {
    ipcMain.handle(IpcEvents.CSP_REMOVE_OVERRIDE, removeCspRule);
    ipcMain.handle(IpcEvents.CSP_REQUEST_ADD_OVERRIDE, addCspRule);
    ipcMain.handle(IpcEvents.CSP_IS_DOMAIN_ALLOWED, isDomainAllowed);
}

function getDomain(url: unknown): string | undefined {
    if (typeof url !== "string" || url.length > 2048) return;
    try {
        const { host, protocol } = new URL(url);
        if (!host || host === "__proto__" || !["http:", "https:", "ws:", "wss:"].includes(protocol) || /[;'"\\]/.test(host)) return;
        return host;
    } catch {
        return;
    }
}

function getMessage(domain: string, directives: string[], callerName: string) {
    const message = `${callerName} wants to allow connections to ${domain}`;

    let detail =
        `Unless you recognise and fully trust ${domain}, you should cancel this request!\n\n` +
        `You will have to fully close and restart ${IS_DISCORD_DESKTOP ? "Discord" : "Vesktop"} for the changes to take effect.`;

    if (directives.length === 1 && directives[0] === "connect-src") {
        return { message, detail };
    }

    const contentTypes = directives
        .filter(type => type !== "connect-src")
        .map(type => {
            switch (type) {
                case "img-src":
                    return "Images";
                case "style-src":
                    return "CSS & Themes";
                case "font-src":
                    return "Fonts";
                default:
                    throw new Error(`Illegal CSP directive: ${type}`);
            }
        })
        .sort()
        .join(", ");

    detail = `The following types of content will be allowed to load from ${domain}:\n${contentTypes}\n\n${detail}`;

    return { message, detail };
}

async function addCspRule(_: IpcMainInvokeEvent, url: unknown, directives: unknown, callerName: unknown): Promise<CspRequestResult> {
    const domain = getDomain(url);
    if (!domain || !Array.isArray(directives) || !directives.length || directives.length > ImageAndCssSrc.length
        || !directives.every(d => typeof d === "string" && ImageAndCssSrc.includes(d))
        || typeof callerName !== "string" || callerName.length > 128) {
        return "invalid";
    }

    if (Object.hasOwn(NativeSettings.store.customCspRules, domain)) {
        return "conflict";
    }

    const { checkboxChecked, response } = await dialog.showMessageBox({
        ...getMessage(domain, directives, callerName),
        type: callerName ? "info" : "warning",
        title: "LawyerCord Host Permissions",
        buttons: ["Cancel", "Allow"],
        defaultId: 0,
        cancelId: 0,
        checkboxLabel: `I fully trust ${domain} and understand the risks of allowing connections to it.`,
        checkboxChecked: false,
    });

    if (response !== 1) {
        return "cancelled";
    }

    if (!checkboxChecked) {
        return "unchecked";
    }

    if (Object.hasOwn(NativeSettings.store.customCspRules, domain)) return "conflict";
    NativeSettings.store.customCspRules[domain] = directives;
    return "ok";
}

function removeCspRule(_: IpcMainInvokeEvent, domain: unknown) {
    if (typeof domain === "string" && Object.hasOwn(NativeSettings.store.customCspRules, domain)) {
        delete NativeSettings.store.customCspRules[domain];
        return true;
    }

    return false;
}

function isDomainAllowed(_: IpcMainInvokeEvent, url: unknown, directives: unknown) {
    const domain = getDomain(url);
    if (!domain || !Array.isArray(directives) || !directives.length || directives.length > 16) return false;
    const ruleForDomain = CspPolicies[domain] ?? NativeSettings.store.customCspRules[domain];
    return Array.isArray(ruleForDomain) && directives.every(d => typeof d === "string" && ruleForDomain.includes(d));
}
