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
import { debounce } from "@shared/debounce";
import { EquicordDevs } from "@utils/constants";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { React, TextInput } from "@webpack/common";

interface GoogleFontMetadata {
    family: string;
    displayName: string;
    authors: string[];
    category?: number;
    popularity?: number;
    variants: Array<{
        axes: Array<{
            tag: string;
            min: number;
            max: number;
        }>;
    }>;
}

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

async function searchGoogleFonts(query: string) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const cacheKey = normalizedQuery.toLowerCase();
    const cachedResults = fontSearchCache.get(cacheKey);
    if (cachedResults) return cachedResults;

    try {
        const response = await fetch("https://fonts.google.com/$rpc/fonts.fe.catalog.actions.metadata.MetadataService/FontSearch", {
            method: "POST",
            headers: {
                "content-type": "application/json+protobuf",
                "x-user-agent": "grpc-web-javascript/0.1"
            },
            body: JSON.stringify([[normalizedQuery, null, null, null, null, null, 1], [5], null, 16])
        });

        const data = await response.json();
        if (!data?.[1]) return [];
        const fonts = data[1].map(([_, fontData]: [string, any[]]) => ({
            family: fontData[0],
            displayName: fontData[1],
            authors: fontData[2],
            category: fontData[3],
            variants: fontData[6].map((variant: any[]) => ({
                axes: variant[0].map(([tag, min, max]: [string, number, number]) => ({
                    tag, min, max
                }))
            }))
        }));

        fontSearchCache.set(cacheKey, fonts);
        if (fontSearchCache.size > MAX_FONT_SEARCH_CACHE_SIZE) {
            const oldestKey = fontSearchCache.keys().next().value;
            if (oldestKey) fontSearchCache.delete(oldestKey);
        }

        return fonts;
    } catch (err) {
        console.error("Failed to fetch fonts:", err);
        return [];
    }
}

const preloadFont = (family: string) =>
    loadFontStyle(createGoogleFontUrl(family, ":wght@400;700"));

let styleElement: HTMLStyleElement | null = null;
let fontLinkElement: HTMLLinkElement | null = null;
let fontLinkUrl: string | null = null;

const applyFont = async (fontFamily: string) => {
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
        console.error("Failed to load font:", err);
    }
};

function GoogleFontSearch({ onSelect }: { onSelect: (font: GoogleFontMetadata) => void; }) {
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState<GoogleFontMetadata[]>([]);
    const [loading, setLoading] = React.useState(false);
    const previewLinks = React.useRef<HTMLLinkElement[]>([]);
    const searchGeneration = React.useRef(0);
    const mounted = React.useRef(true);

    const clearPreviewLinks = React.useCallback(() => {
        previewLinks.current.forEach(link => link.remove());
        previewLinks.current = [];
    }, []);

    React.useEffect(() => () => {
        mounted.current = false;
        searchGeneration.current++;
        clearPreviewLinks();
    }, [clearPreviewLinks]);

    const debouncedSearch = React.useMemo(() => debounce(async (value: string) => {
        const generation = ++searchGeneration.current;
        if (!mounted.current) return;

        setLoading(true);

        if (!value) {
            clearPreviewLinks();
            setResults([]);
            setLoading(false);
            return;
        }

        const fonts = await searchGoogleFonts(value);
        if (!mounted.current || generation !== searchGeneration.current) return;

        clearPreviewLinks();
        previewLinks.current = fonts.map(f => preloadFont(f.family));
        setResults(fonts);
        setLoading(false);
    }, 300), [clearPreviewLinks]);

    const handleSearch = (e: string) => {
        setQuery(e);
        debouncedSearch(e);
    };

    return (
        <section>
            <HeadingSecondary>Search Google Fonts</HeadingSecondary>
            <Paragraph className={Margins.bottom8}>Click on any font to apply it.</Paragraph>

            <TextInput
                value={query}
                onChange={e => handleSearch(e)}
                placeholder="Search fonts..."
                disabled={loading}
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
    description: "Loads any font from Google Fonts",
    tags: ["Appearance", "Customisation"],
    authors: [EquicordDevs.vmohammad],
    settings,

    async start() {
        const savedFont = settings.store.selectedFont;
        if (savedFont) {
            await applyFont(savedFont);
        }
    },

    stop() {
        styleElement?.remove();
        styleElement = null;
        fontLinkElement?.remove();
        fontLinkElement = null;
        fontLinkUrl = null;
    }
});
