/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { Devs } from "@utils/constants";
import { classNameToSelector, createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { filters, findCssClassesLazy, waitFor, waitForSubscriptions } from "@webpack";

let style: HTMLStyleElement | undefined;
const selectors = new Set<string>();
const mediaClasses = [
    ["imageContainer", "imageContent"],
    ["imageContainer", "backgroundImage"],
    ["wrapperPaused", "wrapperPlaying"]
].map(names => ({ name: names[0], classes: findCssClassesLazy(...names), filter: filters.byClassNames(...names) }));

const settings = definePluginSettings({
    blurAmount: {
        type: OptionType.NUMBER,
        description: "Blur Amount (in pixels)",
        default: 10,
        isValid: value => Number.isFinite(Number(value)) && Number(value) >= 0 || "Enter a number of zero or greater.",
        onChange: setCss
    },
    blurAllChannels: {
        type: OptionType.BOOLEAN,
        description: "Blur attachments in all channels (not just NSFW)",
        default: false
    },
});

function setCss() {
    if (!style || !selectors.size) return;
    const { blurAmount } = settings.store;
    style.textContent = `
        ${Array.from(selectors, selector => `.vc-nsfw-img ${selector}`).join(",\n")} {
            filter: blur(${Number.isFinite(blurAmount) && blurAmount >= 0 ? blurAmount : 10}px);
            transition: filter 0.2s;

            &:hover {
                filter: blur(0);
            }
        }
        `;
}

export default definePlugin({
    name: "BlurNSFW",
    description: "Blur attachments in NSFW channels until hovered",
    tags: ["Privacy", "Appearance"],
    authors: [Devs.Ven],
    isModified: true,
    settings,

    patches: [
        {
            find: "}renderStickersAccessories(",
            replacement: [
                {
                    match: /(?<=\.jsxs\)\("div",\{(?=[^{}]{0,150}\bid:\(0,\i\.\i\)\(\i\))[^{}]{0,150}\bclassName:)/,
                    replace: '(this?.props?.channel?.nsfw || $self.settings.store.blurAllChannels ? "vc-nsfw-img ": "")+'
                }
            ]
        }
    ],

    start() {
        style = createAndAppendStyle("VcBlurNsfw", managedStyleRootNode);

        for (const { name, classes, filter } of mediaClasses) {
            waitFor(filter, () => {
                selectors.add(classNameToSelector(classes[name]));
                setCss();
            });
        }
    },

    stop() {
        for (const { filter } of mediaClasses) waitForSubscriptions.delete(filter);
        selectors.clear();
        style?.remove();
        style = undefined;
    }
});
