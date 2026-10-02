/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import ErrorBoundary from "@components/ErrorBoundary";
import { resolveLang } from "@plugins/shikiCodeblocks.desktop/api/languages";
import { shiki } from "@plugins/shikiCodeblocks.desktop/api/shiki";
import { useTheme } from "@plugins/shikiCodeblocks.desktop/hooks/useTheme";
import { settings } from "@plugins/shikiCodeblocks.desktop/settings";
import { hex2Rgb } from "@plugins/shikiCodeblocks.desktop/utils/color";
import { cl, hljs, requireHljs, shouldUseHljs } from "@plugins/shikiCodeblocks.desktop/utils/misc";
import { useAwaiter, useIntersection } from "@utils/react";
import { React, useEffect } from "@webpack/common";

import { ButtonRow } from "./ButtonRow";
import { Code } from "./Code";
import { Header } from "./Header";

export interface ThemeBase {
    plainColor: string;
    accentBgColor: string;
    accentFgColor: string;
    backgroundColor: string;
}

export interface HighlighterProps {
    lang?: string;
    content: string;
    isPreview: boolean;
}

let didLoadHljs = false;
const SETTINGS_KEYS = ["tryHljs", "useDevIcon", "bgOpacity"] satisfies (keyof typeof settings.store)[];
export const HighlighterContainer = (props: HighlighterProps) => {
    const [_, _err, isPending] = useAwaiter(requireHljs);

    useEffect(() => {
        if (!isPending) didLoadHljs = true;
    }, [isPending]);

    if (!didLoadHljs && isPending) return null;

    return (
        <pre className={cl("container")}>
            <ErrorBoundary>
                <Highlighter {...props} />
            </ErrorBoundary>
        </pre>
    );
};

export const Highlighter = ({
    lang,
    content,
    isPreview,
}: HighlighterProps) => {
    const {
        tryHljs,
        useDevIcon,
        bgOpacity,
    } = settings.use(SETTINGS_KEYS);
    const { id: currentThemeId, theme: currentTheme } = useTheme();

    const shikiLang = lang ? resolveLang(lang) : null;
    const useHljs = shouldUseHljs({ lang, tryHljs });

    const [rootRef, isIntersecting] = useIntersection(true);

    const [highlight] = useAwaiter(async () => {
        if (!lang || !shikiLang || useHljs || !isIntersecting) return null;
        return { tokens: await shiki.tokenizeCode(content, lang), content, lang, themeId: currentThemeId };
    }, {
        fallbackValue: null,
        deps: [lang, content, currentThemeId, isIntersecting, useHljs],
    });

    const themeBase: ThemeBase = {
        plainColor: currentTheme?.fg || "var(--text-default)",
        accentBgColor:
            currentTheme?.colors?.["statusBar.background"] || (useHljs ? "#7289da" : "#007BC8"),
        accentFgColor: currentTheme?.colors?.["statusBar.foreground"] || "#FFF",
        backgroundColor:
            currentTheme?.colors?.["editor.background"] || "var(--background-base-lower)",
    };

    let langName;
    if (lang) langName = useHljs ? hljs?.getLanguage?.(lang)?.name : shikiLang?.name;

    return (
        <div
            ref={rootRef}
            className={cl("root", { plain: !langName, preview: isPreview })}
            style={{
                backgroundColor: useHljs
                    ? themeBase.backgroundColor
                    : `rgba(${hex2Rgb(themeBase.backgroundColor)
                        .concat(bgOpacity / 100)
                        .join(", ")})`,
                color: themeBase.plainColor,
            }}
        >
            <code className={cl("code")}>
                <Header
                    langName={langName}
                    useDevIcon={useDevIcon}
                    shikiLang={shikiLang}
                />
                <Code
                    theme={themeBase}
                    useHljs={useHljs}
                    lang={lang}
                    content={content}
                    tokens={highlight?.content === content && highlight.lang === lang && highlight.themeId === currentThemeId ? highlight.tokens : null}
                />
                {!isPreview && <ButtonRow
                    content={content}
                    theme={themeBase}
                />}
            </code>
        </div>
    );
};
