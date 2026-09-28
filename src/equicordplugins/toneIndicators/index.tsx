/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { escapeRegExp } from "@utils/text";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";
import { type ReactNode } from "react";

import indicatorsDefault from "./indicators";
import ToneIndicator from "./ToneIndicator";

type IndicatorCache = {
    prefix: string;
    rawCustomIndicators: string;
    customIndicators: Record<string, string>;
    indicatorRegex: RegExp;
    quickTestRegex: RegExp;
};

let indicatorCache: IndicatorCache | null = null;

const settings = definePluginSettings({
    prefix: {
        type: OptionType.STRING,
        description: "Prefix character(s) for tone indicators.",
        default: "/",
    },
    customIndicators: {
        type: OptionType.STRING,
        description: "Custom tone indicators (format: jk=Joking; srs=Serious)",
        default: "",
    },
});

function parseCustomIndicators(raw: string): Record<string, string> {
    const result: Record<string, string> = Object.create(null);

    raw.split(/;\s*/).forEach(entry => {
        const [key, ...rest] = entry.split("=");
        if (key && rest.length > 0) {
            result[key.trim().toLowerCase()] = rest.join("=").trim();
        }
    });

    return result;
}

function getEscapedPrefix(prefix: string) {
    const escapedPrefix = escapeRegExp(prefix);

    return /[*_~`|]/.test(prefix)
        ? `(?:\\\\${escapedPrefix}|${escapedPrefix})`
        : escapedPrefix;
}

function getIndicatorCache() {
    const prefix = settings.store.prefix || "/";
    const rawCustomIndicators = settings.store.customIndicators || "";
    if (
        indicatorCache &&
        indicatorCache.prefix === prefix &&
        indicatorCache.rawCustomIndicators === rawCustomIndicators
    ) return indicatorCache;

    const customIndicators = parseCustomIndicators(rawCustomIndicators);
    const allIndicators = new Set<string>();

    indicatorsDefault.forEach((_, key) => {
        allIndicators.add(key.replace(/^_/, ""));
    });
    Object.keys(customIndicators).forEach(key => {
        allIndicators.add(key.replace(/^_/, ""));
    });

    const escaped: string[] = [];
    for (const indicator of allIndicators) {
        escaped.push(escapeRegExp(indicator));
    }
    escaped.sort((a, b) => b.length - a.length);

    const escapedPattern = escaped.join("|");

    const escapedPrefix = getEscapedPrefix(prefix);
    indicatorCache = {
        prefix,
        rawCustomIndicators,
        customIndicators,
        indicatorRegex: new RegExp(`(?:^|\\s)${escapedPrefix}(${escapedPattern})(?=\\s|$|[^\\s\\w/])`, "giu"),
        quickTestRegex: new RegExp(`${escapedPrefix}[\\p{L}_]+`, "iu")
    };

    return indicatorCache;
}

function getIndicator(text: string): string | null {
    text = text.toLowerCase();
    const { customIndicators } = getIndicatorCache();

    return (
        customIndicators[text] ||
        customIndicators[`_${text}`] ||
        indicatorsDefault.get(text) ||
        indicatorsDefault.get(`_${text}`) ||
        null
    );
}

function splitTextWithIndicators(text: string): ReactNode[] {
    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    const { indicatorRegex: regex, prefix } = getIndicatorCache();
    let match: RegExpExecArray | null;

    regex.lastIndex = 0;
    while ((match = regex.exec(text))) {
        const indicator = match[1];
        const desc = getIndicator(indicator);

        const fullMatch = match[0];
        const leadingWhitespace = fullMatch.match(/^(\s*)/)?.[1] ?? "";

        const matchStart = match.index;
        const matchEnd = regex.lastIndex;

        if (matchStart > lastIndex) {
            nodes.push(text.slice(lastIndex, matchStart));
        }

        if (desc) {
            if (leadingWhitespace) nodes.push(leadingWhitespace);
            nodes.push(
                <ToneIndicator
                    key={`ti-${matchStart}`}
                    prefix={prefix}
                    indicator={indicator}
                    desc={desc}
                />,
            );
        } else {
            nodes.push(fullMatch);
        }

        lastIndex = matchEnd;
    }

    if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

    return nodes;
}

function patchChildrenTree(children: any): any {
    const transform = (node: any): any => {
        if (node == null) return node;

        if (typeof node === "string") {
            if (!getIndicatorCache().quickTestRegex.test(node)) return node;
            const parts = splitTextWithIndicators(node);
            return parts.length === 1 ? parts[0] : parts;
        }

        if (node?.props?.children != null) {
            const c = node.props.children;
            if (Array.isArray(c)) {
                node.props.children = c.map(transform).flat();
            } else {
                node.props.children = transform(c);
            }
            return node;
        }

        return node;
    };

    if (Array.isArray(children)) return children.map(transform).flat();
    return transform(children);
}

export default definePlugin({
    name: "ToneIndicators",
    description: "Show tooltips for tone indicators like /srs, /gen, etc. in sent messages.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.justjxke],
    settings,

    patches: [
        {
            find: '["strong","em","u","text","inlineCode","s","spoiler"]',
            replacement: [
                {
                    match: /(?=return\{hasSpoilerEmbeds:\i,.{0,15}content:(\i))/,
                    replace: "$1=$self.patchToneIndicators($1);",
                },
            ],
        },
    ],

    patchToneIndicators(content: any): any {
        try {
            return patchChildrenTree(content);
        } catch {
            return content;
        }
    },
});
