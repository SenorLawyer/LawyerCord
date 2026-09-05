/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { Logger } from "@utils/Logger";

import { hexToHSL } from "./colorUtils";
const VARS_STYLE_ID = "vc-clientTheme-vars";
const OVERRIDES_STYLE_ID = "vc-clientTheme-overrides";
type StyleId = typeof VARS_STYLE_ID | typeof OVERRIDES_STYLE_ID;

const styleCache: Partial<Record<StyleId, HTMLStyleElement>> = {};
const logger = new Logger("ClientTheme");
let activeRequest: AbortController | undefined;

export function createOrUpdateThemeColorVars(color: string) {
    if (!activeRequest) return;
    const { hue, saturation, lightness } = hexToHSL(color);

    createOrUpdateStyle(VARS_STYLE_ID, `:root {
        --theme-h: ${hue};
        --theme-s: ${saturation}%;
        --theme-l: ${lightness}%;
    }`);
}

export async function startClientTheme(color: string) {
    activeRequest?.abort();
    const request = activeRequest = new AbortController();
    createOrUpdateThemeColorVars(color);
    const styles = await getDiscordStyles(request.signal);
    if (!request.signal.aborted) createColorsOverrides(styles);
}

export function disableClientTheme() {
    activeRequest?.abort();
    activeRequest = undefined;
    styleCache[VARS_STYLE_ID]?.remove();
    styleCache[OVERRIDES_STYLE_ID]?.remove();
    delete styleCache[VARS_STYLE_ID];
    delete styleCache[OVERRIDES_STYLE_ID];
}

function createOrUpdateStyle(styleId: StyleId, css: string) {
    const style = styleCache[styleId] ??= createAndAppendStyle(styleId, managedStyleRootNode);
    style.textContent = css;
}

/**
 * @returns A string containing all the CSS styles from the Discord client.
 */
async function getDiscordStyles(signal: AbortSignal): Promise<string> {
    const styleLinkNodes = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');

    const cssTexts = await Promise.all(Array.from(styleLinkNodes, async node => {
        if (!node.href)
            return "";

        try {
            const response = await fetch(node.href, { signal });
            if (!response.ok) throw new Error(`Stylesheet request failed with status ${response.status}`);
            return await response.text();
        } catch (error) {
            if (!signal.aborted) logger.warn("Failed to load stylesheet", error);
            return "";
        }
    }));

    return cssTexts.filter(Boolean).join("\n");
}

const VISUAL_REFRESH_COLORS_VARIABLES_REGEX = /(--neutral-\d{1,3}?-hsl):.+?([\d.]+?)%;/g;

function createColorsOverrides(styles: string) {
    const visualRefreshColorsLightness = {} as Record<string, number>;

    for (const [, colorVariableName, lightness] of styles.matchAll(VISUAL_REFRESH_COLORS_VARIABLES_REGEX)) {
        visualRefreshColorsLightness[colorVariableName] = parseFloat(lightness);
    }

    const lightThemeBaseLightness = visualRefreshColorsLightness["--neutral-2-hsl"];
    const darkThemeBaseLightness = visualRefreshColorsLightness["--neutral-69-hsl"];
    if (!Number.isFinite(lightThemeBaseLightness) || !Number.isFinite(darkThemeBaseLightness)) {
        logger.warn("Could not find the client theme base colors");
        return;
    }

    createOrUpdateStyle(OVERRIDES_STYLE_ID, [
        `.theme-light {\n ${generateNewColorVars(visualRefreshColorsLightness, lightThemeBaseLightness)} \n}`,
        `.theme-dark {\n ${generateNewColorVars(visualRefreshColorsLightness, darkThemeBaseLightness)} \n}`,
    ].join("\n\n"));
}

function generateNewColorVars(colorsLightess: Record<string, number>, baseLightness: number) {
    return Object.entries(colorsLightess).map(([colorVariableName, lightness]) => {
        const lightnessOffset = lightness - baseLightness;
        const plusOrMinus = lightnessOffset >= 0 ? "+" : "-";

        return `${colorVariableName}: var(--theme-h) var(--theme-s) calc(var(--theme-l) ${plusOrMinus} ${Math.abs(lightnessOffset).toFixed(2)}%);`;
    }).join("\n");
}
