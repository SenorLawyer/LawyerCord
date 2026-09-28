/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { parseUrl } from "@utils/misc";
import { React, TextInput, useEffect, useState } from "@webpack/common";

const cl = classNameFactory("vc-settings-theme-");

export interface OnlineThemesSectionProps {
    enableOnlineThemes: boolean;
    setEnableOnlineThemes: (value: boolean) => void;
    currentThemeLink: string;
    setCurrentThemeLink: (value: string) => void;
    addThemeLink: (link: string) => void;
}

export function OnlineThemesSection({
    enableOnlineThemes,
    setEnableOnlineThemes,
    currentThemeLink,
    setCurrentThemeLink,
    addThemeLink
}: OnlineThemesSectionProps) {
    const [validation, setValidation] = useState<{ link: string; error: string | null; } | null>(null);

    useEffect(() => {
        if (!currentThemeLink || !enableOnlineThemes) return;
        const controller = new AbortController();
        setValidation(null);

        (async () => {
            try {
                const url = parseUrl(currentThemeLink);
                if (!url || !["https:", "http:"].includes(url.protocol))
                    throw new Error("Enter an HTTP or HTTPS URL.");
                const response = await fetch(currentThemeLink, { signal: controller.signal });
                await response.body?.cancel();
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const contentType = response.headers.get("Content-Type");
                if (!contentType?.startsWith("text/css") && !contentType?.startsWith("text/plain"))
                    throw new Error("Not a CSS file. Use the raw link.");
                if (!controller.signal.aborted) setValidation({ link: currentThemeLink, error: null });
            } catch (error) {
                if (!controller.signal.aborted)
                    setValidation({ link: currentThemeLink, error: error instanceof Error ? error.message : String(error) });
            }
        })();

        return () => controller.abort();
    }, [currentThemeLink, enableOnlineThemes]);

    const result = validation?.link === currentThemeLink ? validation : null;
    const themeLinkValid = !!result && result.error === null;
    return (
        <>
            <Heading className={Margins.top20}>Online Themes</Heading>
            <Paragraph className={Margins.bottom16}>
                Load themes directly from URLs instead of local files. Online themes auto-update when the source changes, so you always have the latest version without manual downloads.
            </Paragraph>
            <FormSwitch
                title="Enable Online Themes"
                description="Toggle online theme loading. When disabled, all online themes will be turned off and you won't be able to add new ones."
                value={enableOnlineThemes}
                onChange={setEnableOnlineThemes}
            />

            <Notice.Info className={Margins.bottom16} style={{ width: "100%" }}>
                Looking for themes? Check out <Link href="https://betterdiscord.app/themes">BetterDiscord Themes</Link> or search on <Link href="https://github.com/search?q=discord+theme">GitHub</Link>. When downloading from BetterDiscord, click "Download" and place the .theme.css file into your themes folder.
            </Notice.Info>

            <div className={cl("link-row")}>
                <TextInput
                    placeholder="https://example.com/theme.css"
                    value={currentThemeLink}
                    onChange={setCurrentThemeLink}
                    disabled={!enableOnlineThemes}
                />
                <Button onClick={() => addThemeLink(currentThemeLink)} disabled={!themeLinkValid || !enableOnlineThemes}>
                    Add
                </Button>
            </div>
            {currentThemeLink && (
                <div className={Margins.top8}>
                    <Paragraph>{!enableOnlineThemes ? "Online themes are disabled." : !result ? "Checking..." : result.error ?? "Valid!"}</Paragraph>
                </div>
            )}
        </>
    );
}
