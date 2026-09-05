/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";

import { settings } from "./settings";

type GlobalBadge = Record<"mod" | "tooltip" | "badge", string>;

let GlobalBadges: Record<string, GlobalBadge[]> = {};
let loadGeneration = 0;
export const INVITE_LINK = "kwHCJPxp8t";
export const cl = classNameFactory("vc-global-badges-");
export const serviceMap: Record<string, string> = {
    badgevault: "BadgeVault",
    nekocord: "Nekocord",
    reviewdb: "ReviewDB",
    aero: "Aero",
    aliucord: "Aliucord",
    raincord: "Raincord",
    velocity: "Velocity",
    enmity: "Enmity",
    paicord: "Paicord",
    bunny: "Bunny",
    goosemod: "GooseMod",
    replugged: "Replugged",
    betterdiscord: "BetterDiscord",
    vendroidenhanced: "VendroidEnhanced",
    revenge: "Revenge",
    record: "ReCord",
    vencord: "Vencord",
    equicord: "Equicord"
};

const blockedMods = ["vencord", "equicord"];

export function cancelBadgeLoad() {
    loadGeneration++;
}

export async function loadBadges() {
    const generation = ++loadGeneration;
    const url = settings.store.apiUrl.endsWith("/") ? settings.store.apiUrl + "users" : settings.store.apiUrl + "/users";
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Badge request failed: ${response.status}`);
    const data: unknown = await response.json();
    if (!isObject(data) || !("users" in data) || !isObject(data.users)
        || !Object.values(data.users).every(badges => Array.isArray(badges)
            && badges.every(badge => isObject(badge)
                && "mod" in badge && typeof badge.mod === "string"
                && "tooltip" in badge && typeof badge.tooltip === "string"
                && "badge" in badge && typeof badge.badge === "string")
        )) throw new Error("Invalid global badge response");

    if (generation === loadGeneration) GlobalBadges = data.users as Record<string, GlobalBadge[]>;
}

export function refreshBadges() {
    return loadBadges().catch(error => new Logger("GlobalBadges").error("Failed to refresh badges", error));
}

export function getBadges(userId: string) {
    const conditionalMods = {
        aero: settings.store.showAero,
        velocity: settings.store.showVelocity,
        badgevault: settings.store.showCustom,
        nekocord: settings.store.showNekocord,
        reviewdb: settings.store.showReviewDB,
        aliucord: settings.store.showAliucord,
        raincord: settings.store.showRaincord,
        enmity: settings.store.showEnmity,
        paicord: settings.store.showPaicord,
        bunny: settings.store.showBunny,
        goosemod: settings.store.showGooseMod,
        replugged: settings.store.showReplugged,
        betterdiscord: settings.store.showBetterDiscord,
        vendroidenhanced: settings.store.showVendroidEnhanced,
        revenge: settings.store.showRevenge,
        record: settings.store.showReCord
    };
    const { showModStyle } = settings.store;
    return GlobalBadges[userId]?.filter(({ mod }) => mod && !blockedMods.includes(mod)
        && (!Object.hasOwn(conditionalMods, mod) || conditionalMods[mod])
    ).map(badge => {
        const mod = Object.hasOwn(serviceMap, badge.mod) ? serviceMap[badge.mod] : badge.mod;
        const prefix = showModStyle === "prefix" ? `${mod} - ` : "";
        const suffix = showModStyle === "suffix" ? ` - ${mod}` : "";
        return { ...badge, tooltip: prefix + badge.tooltip + suffix };
    });
}
