/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, migratePluginSetting } from "@api/Settings";
import { Card } from "@components/Card";
import { HeadingSecondary, HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { lodash, React, TextInput } from "@webpack/common";

interface GoogleFontMetadata {
    family: string;
    displayName: string;
    authors: string[];

}

const logger = new Logger("FontLoader");

const MAX_FONT_SEARCH_CACHE_SIZE = 25;
const fontSearchCache = new Map<string, GoogleFontMetadata[]>();

const createGoogleFontUrl = (family: string, options = "") =>
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${options}&display=swap`;

const loadFontStyle = (url: string) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);

    return link;
};

async function searchGoogleFonts(query: string, signal: AbortSignal) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const cacheKey = normalizedQuery.toLowerCase();
    const cachedResults = fontSearchCache.get(cacheKey);
    if (cachedResults) return cachedResults;

    try {
        const response = await fetch("https://fonts.google.com/$rpc/fonts.fe.catalog.actions.metadata.MetadataService/FontSearch", {
            method: "POST",
            signal,
            headers: {
                "content-type": "application/json+protobuf",
                "x-user-agent": "grpc-web-javascript/0.1"
            },
            body: JSON.stringify([[normalizedQuery, null, null, null, null, null, 1], [5], null, 16])
        });

        if (!response.ok) throw new Error("Font search failed.");
        const data: unknown = await response.json();
        if (signal.aborted || !Array.isArray(data) || !Array.isArray(data[1])) return [];
        const fonts: GoogleFontMetadata[] = data[1].flatMap((entry: unknown) => {
            if (!Array.isArray(entry) || !Array.isArray(entry[1])) return [];
            const [family, displayName, authors] = entry[1];
            if (typeof family !== "string" || typeof displayName !== "string"
                || !Array.isArray(authors) || !authors.every(author => typeof author === "string")) return [];
            return [{ family, displayName, authors }];
        });

        fontSearchCache.set(cacheKey, fonts);
        if (fontSearchCache.size > MAX_FONT_SEARCH_CACHE_SIZE) {
            const oldestKey = fontSearchCache.keys().next().value;
            if (oldestKey) fontSearchCache.delete(oldestKey);
        }

        return fonts;
    } catch (err) {
        if (!signal.aborted) logger.warn("Could not search Google Fonts.", err);
        return [];
    }
}

const preloadFont = (family: string) =>
    loadFontStyle(createGoogleFontUrl(family, ":wght@400;700"));

let styleElement: HTMLStyleElement | null = null;
let fontLinkElement: HTMLLinkElement | null = null;
let fontLinkUrl: string | null = null;

const applyFont = (fontFamily: string) => {
    if (!fontFamily) {
        styleElement?.remove();
        styleElement = null;
        fontLinkElement?.remove();
        fontLinkElement = null;
        fontLinkUrl = null;
        return;
    }

    try {
        if (!styleElement) {
            styleElement = document.createElement("style");
            document.head.appendChild(styleElement);
        }

        const nextFontLinkUrl = createGoogleFontUrl(fontFamily, ":wght@300;400;500;600;700");
        if (fontLinkUrl !== nextFontLinkUrl) {
            fontLinkElement?.remove();
            fontLinkElement = loadFontStyle(nextFontLinkUrl);
            fontLinkUrl = nextFontLinkUrl;
        }

        const escapedFontFamily = CSS.escape(fontFamily);
        styleElement.textContent = `
            * {
                --font-primary: ${escapedFontFamily}, sans-serif !important;
                --font-display: ${escapedFontFamily}, sans-serif !important;
                --font-headline: ${escapedFontFamily}, sans-serif !important;
                ${settings.store.applyOnCodeBlocks ? `--font-code: ${escapedFontFamily}, monospace !important;` : ""}
            }
        `;
    } catch (err) {
        logger.error("Could not apply the selected font.", err);
    }
};

function GoogleFontSearch({ onSelect }: { onSelect: (font: GoogleFontMetadata) => void; }) {
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState<GoogleFontMetadata[]>([]);
    const [loading, setLoading] = React.useState(false);
    const previewLinks = React.useRef<HTMLLinkElement[]>([]);
    const clearPreviewLinks = React.useCallback(() => {
        previewLinks.current.forEach(link => link.remove());
        previewLinks.current = [];
    }, []);

    React.useEffect(() => clearPreviewLinks, [clearPreviewLinks]);
    React.useEffect(() => {
        const controller = new AbortController();
        if (!query.trim()) {
            clearPreviewLinks();
            setResults([]);
            setLoading(false);
            return;
        }
        const search = lodash.debounce(async () => {
            setLoading(true);
            const fonts = await searchGoogleFonts(query, controller.signal);
            if (controller.signal.aborted) return;
            clearPreviewLinks();
            previewLinks.current = fonts.map(font => preloadFont(font.family));
            setResults(fonts);
            setLoading(false);
        }, 300);
        search();
        return () => {
            search.cancel();
            controller.abort();
        };
    }, [query, clearPreviewLinks]);

    return (
        <section>
            <HeadingSecondary>Search Google Fonts</HeadingSecondary>
            <Paragraph className={Margins.bottom8}>Click on any font to apply it.</Paragraph>

            <TextInput
                value={query}
                onChange={setQuery}
                placeholder="Search fonts..."
                aria-busy={loading}
            />

            {results.length > 0 && (
                <div className={classes(Margins.top8, "eq-googlefonts-results")}>
                    {results.map(font => (
                        <Card
                            key={font.family}
                            className={classes("eq-googlefonts-card", Margins.bottom8)}
                            onClick={() => onSelect(font)}
                        >
                            <div className="eq-googlefonts-preview" style={{ fontFamily: font.family }}>
                                <HeadingTertiary>{font.displayName}</HeadingTertiary>
                                <Paragraph>The quick brown fox jumps over the lazy dog</Paragraph>
                            </div>
                            {font.authors?.length && (
                                <Paragraph className={Margins.top8} style={{ opacity: 0.7 }}>
                                    by {font.authors.join(", ")}
                                </Paragraph>
                            )}
                        </Card>
                    ))}
                </div>
            )}
        </section>
    );
}

migratePluginSetting("FontLoader", "applyOnCodeBlocks", "applyOnClodeBlocks");
const settings = definePluginSettings({
    selectedFont: {
        type: OptionType.STRING,
        description: "Currently selected font",
        default: "",
        hidden: true
    },
    fontSearch: {
        type: OptionType.COMPONENT,
        description: "Search and select Google Fonts",
        component: () => (
            <GoogleFontSearch
                onSelect={font => {
                    settings.store.selectedFont = font.family;
                    applyFont(font.family);
                }}
            />
        )
    },
    applyOnCodeBlocks: {
        type: OptionType.BOOLEAN,
        description: "Apply the font to code blocks",
        default: false,
        onChange: () => void applyFont(settings.store.selectedFont)
    }
});

export default definePlugin({
    name: "FontLoader",
    performance: { impact: "low", description: "Loads a selected font and searches font previews while settings are open." },
    description: "Loads any font from Google Fonts",
    tags: ["Appearance", "Customisation"],
    authors: [EquicordDevs.vmohammad],
    settings,

    start() {
        applyFont(settings.store.selectedFont);
    },

    stop() {
        applyFont("");
    }
});
