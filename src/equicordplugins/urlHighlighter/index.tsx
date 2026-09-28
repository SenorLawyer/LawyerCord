/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ColorPicker, TextInput } from "@webpack/common";

interface PatternEntry {
    pattern: string;
    color: string;
}

interface CompiledPatternEntry extends PatternEntry {
    regex: RegExp;
}

const DEFAULT_COLOR = "#eb7396";

const cl = classNameFactory("vc-url-hl-");

const TrashIcon = findComponentByCodeLazy("2.81h8.36a3");
const PlusIcon = findComponentByCodeLazy("0v-5h5a1");

const hexToInt = (hex: string): number => parseInt(hex.replace("#", ""), 16);
const intToHex = (n: number): string => "#" + n.toString(16).padStart(6, "0");
let compiledPatternsKey = "";
let compiledPatterns: CompiledPatternEntry[] = [];

function updatePatterns(patterns: PatternEntry[]) {
    settings.store.patterns = patterns;
}

const PatternsComponent = ErrorBoundary.wrap(() => {
    const { patterns } = settings.store;

    return (
        <section>
            <Heading>URL Patterns</Heading>
            {patterns.map((entry, i) => (
                <div key={i} className={cl("pattern-wrapper")}>
                    <TextInput
                        value={entry.pattern}
                        onChange={v => {
                            const nextPatterns = [...patterns];
                            nextPatterns[i] = { ...entry, pattern: v };
                            updatePatterns(nextPatterns);
                        }}
                        placeholder="*.example.com"
                    />
                    <div className={cl("color-picker")}>
                        <ColorPicker
                            color={hexToInt(entry.color)}
                            onChange={(c: number) => {
                                const nextPatterns = [...patterns];
                                nextPatterns[i] = { ...entry, color: intToHex(c) };
                                updatePatterns(nextPatterns);
                            }}
                            showEyeDropper={false}
                        />
                    </div>
                    <Button
                        className={cl("remove-button")}
                        variant="secondary"
                        size="small"
                        onClick={() => {
                            updatePatterns(patterns.filter((_, index) => index !== i));
                        }}
                    >
                        <TrashIcon className={cl("icon")} />
                    </Button>
                </div>
            ))}
            <Button
                onClick={() => updatePatterns([...patterns, { pattern: "", color: DEFAULT_COLOR }])}
                className={cl("add-button")}
                variant="secondary"
                size="small"
            >
                <PlusIcon className={cl("icon")} /> Add New
            </Button>
        </section>
    );
}, { noop: true });

const settings = definePluginSettings({
    patterns: {
        type: OptionType.COMPONENT,
        description: "URL patterns to highlight using glob patterns.",
        default: [] as PatternEntry[],
        component: PatternsComponent
    },
    boldUrls: {
        type: OptionType.BOOLEAN,
        description: "Make highlighted URLs bold.",
        default: false
    },
    highlightEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Also highlight URLs in embed content.",
        default: false
    }
});

function globToRegex(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(escaped, "i");
}

function getCompiledPatterns() {
    const { patterns } = settings.store;
    const cacheKey = patterns
        .map(({ pattern, color }) => `${pattern}\u0000${color}`)
        .join("\u0001");

    if (compiledPatternsKey === cacheKey) return compiledPatterns;

    compiledPatternsKey = cacheKey;
    compiledPatterns = patterns.flatMap(entry => {
        const pattern = entry.pattern.trim();
        if (!pattern) return [];

        return [{ ...entry, regex: globToRegex(pattern) }];
    });

    return compiledPatterns;
}

function getMatchingPattern(url: string): PatternEntry | null {
    for (const entry of getCompiledPatterns()) {
        if (entry.regex.test(url)) return entry;
    }
    return null;
}

export default definePlugin({
    name: "UrlHighlighter",
    description: "Highlights URLs in messages that match your patterns.",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.prism],
    settings,

    patches: [
        {
            find: ".MASKED_LINK),",
            replacement: {
                match: /,children:\i\?\?\i/,
                replace: "$&,...$self.getProps(arguments[0])"
            }
        }
    ],

    getProps(props: { href?: string; title?: string; }) {
        if (!props.href) return {};
        if (!settings.store.highlightEmbeds && props.href !== props.title) return {};

        const match = getMatchingPattern(props.href);
        if (!match) return {};

        return {
            className: cl(settings.store.boldUrls ? "marked" : "highlight"),
            style: { "--vc-url-hl-color": match.color } as React.CSSProperties
        };
    }
});
