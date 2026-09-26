/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading, HeadingPrimary } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Devs, EquicordDevs } from "@utils/constants";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { moment, TextInput, useEffect, useState } from "@webpack/common";

import { DemoMessageContainer, type TimeFormat, timeFormats } from "./utils";
interface TimeRowProps {
    id: string;
    format: TimeFormat;
    onChange: (key: string, value: string) => void;
    pluginSettings: Partial<Record<string, string>>;
}

const FORMAT_LITERALS = /\[[^[]*\]|\\./g;
const FORMAT_SETTINGS: "formats"[] = ["formats"];

const format = (date: Date, formatTemplate: string): string => {
    const mmt = moment(date);
    if (!mmt.isValid()) return mmt.format(formatTemplate);
    const { formats } = settings.store;
    const sameDayFormat = formats?.sameDayFormat || timeFormats.sameDayFormat.default;
    const lastDayFormat = formats?.lastDayFormat || timeFormats.lastDayFormat.default;
    const lastWeekFormat = formats?.lastWeekFormat || timeFormats.lastWeekFormat.default;
    const sameElseFormat = formats?.sameElseFormat || timeFormats.sameElseFormat.default;

    let result = "";
    let offset = 0;
    for (const match of formatTemplate.matchAll(FORMAT_LITERALS)) {
        const part = match[0];
        if (part !== "[calendar]" && part !== "[relative]") continue;

        const before = formatTemplate.slice(offset, match.index);
        result += before ? mmt.format(before) : "";
        result += part === "[calendar]" ? mmt.calendar(null, {
            sameDay: sameDayFormat,
            lastDay: lastDayFormat,
            lastWeek: lastWeekFormat,
            sameElse: sameElseFormat
        }) : moment.duration({ to: mmt, from: moment() })
            .locale(mmt.locale())
            .humanize(true, { s: 60, ss: -1, m: 60 });
        offset = match.index + part.length;
    }
    const after = formatTemplate.slice(offset);
    return result + (after ? mmt.format(after) : "");
};

const timestampSubscribers = new Set<() => void>();
let timestampRefreshInterval: ReturnType<typeof setInterval> | undefined;

function subscribeTimestampRefresh(callback: () => void) {
    timestampSubscribers.add(callback);

    timestampRefreshInterval ??= setInterval(() => {
        for (const subscriber of timestampSubscribers) {
            subscriber();
        }
    }, 60_000);

    return () => {
        timestampSubscribers.delete(callback);

        if (timestampSubscribers.size === 0 && timestampRefreshInterval) {
            clearInterval(timestampRefreshInterval);
            timestampRefreshInterval = undefined;
        }
    };
}

function clearTimestampRefresh() {
    timestampSubscribers.clear();

    if (!timestampRefreshInterval) return;

    clearInterval(timestampRefreshInterval);
    timestampRefreshInterval = undefined;
}

const TimeRow = (props: TimeRowProps) => (
    <>
        <Heading>{props.format.name}</Heading>
        <Paragraph>{props.format.description}</Paragraph>
        <TextInput
            aria-label={props.format.name}
            value={props.pluginSettings[props.id] ?? props.format.default}
            onChange={value => props.onChange(props.id, value)}
        />
    </>
);

const settings = definePluginSettings({
    formats: {
        type: OptionType.COMPONENT,
        description: "Customize the timestamp formats",
        component: componentProps => {
            const [settingsState, setSettingsState] = useState(() => settings.store.formats ?? {});

            const setNewValue = (key: string, value: string) => {
                const newSettings = { ...settingsState, [key]: value };
                setSettingsState(newSettings);
                componentProps.setValue(newSettings);
            };

            return (
                <>
                    <DemoMessageContainer />
                    {Object.entries(timeFormats).map(([key, value]) => (
                        <section key={key}>
                            {key === "sameDayFormat" && (
                                <div className={Margins.bottom20}>
                                    <Divider style={{ marginBottom: "10px" }} />
                                    <Heading tag="h1">Calendar formats</Heading>
                                    <Paragraph>
                                        How to format the [calendar] value if used in the above timestamps.
                                    </Paragraph>
                                </div>
                            )}
                            <TimeRow
                                id={key}
                                format={value}
                                onChange={setNewValue}
                                pluginSettings={settingsState}
                            />
                        </section>
                    ))}
                </>);
        }
    }
}).withPrivateSettings<{
    formats: {
        cozyFormat: string;
        compactFormat: string;
        tooltipFormat: string;
        ariaLabelFormat: string;
        sameDayFormat: string;
        lastDayFormat: string;
        lastWeekFormat: string;
        sameElseFormat: string;
    };
}>();

function renderTimestamp(date: Date, type: "cozy" | "compact" | "tooltip" | "ariaLabel") {
    const forceUpdater = useForceUpdater();
    const { formats } = settings.use(FORMAT_SETTINGS);
    const key = `${type}Format` as const;
    const formatTemplate: string = formats?.[key] || timeFormats[key].default;

    useEffect(() => {
        const dynamic = Array.from(formatTemplate.matchAll(FORMAT_LITERALS))
            .some(([part]) => part === "[calendar]" || part === "[relative]");
        if (dynamic) {
            return subscribeTimestampRefresh(forceUpdater);
        }
    }, [forceUpdater, formatTemplate]);

    return format(date, formatTemplate);
}

export default definePlugin({
    name: "CustomTimestamps",
    description: "Custom timestamps on messages and tooltips",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.Rini, EquicordDevs.nvhhr, EquicordDevs.Suffocate, Devs.Obsidian],
    settings,
    settingsAboutComponent: () => (
        <div className={"vc-cmt-info-card"}>
            <HeadingPrimary>How to use:</HeadingPrimary>
            <Paragraph>
                <Link href="https://momentjs.com/docs/#/displaying/format/">Moment.js formatting documentation</Link>
                <div className={Margins.top8}>
                    Additionally you can use these in your inputs:<br />
                    <b>[calendar]</b> enables dynamic date formatting such
                    as &quot;Today&quot; or &quot;Yesterday&quot;.<br />
                    <b>[relative]</b> gives you times such as &quot;4 hours ago&quot;.<br />
                </div>
            </Paragraph>
        </div>
    ),
    patches: [
        {
            find: "#{intl::MESSAGE_EDITED_TIMESTAMP_A11Y_LABEL}",
            replacement: [
                {
                    // Aria label on timestamps
                    match: /\i.useMemo\(.{0,10}\i\.\i\)\(.{0,10}\]\)/,
                    replace: "$self.renderTimestamp(arguments[0].timestamp,'ariaLabel')"
                },
                {
                    // Timestamps on messages
                    match: /\i\.useMemo\(.{0,50}"LT".{0,30}\]\)/,
                    replace: "$self.renderTimestamp(arguments[0].timestamp,arguments[0].compact?'compact':'cozy')",
                },
                {
                    // Tooltips when hovering over message timestamps
                    match: /(__unsupportedReactNodeAsText:).{0,25}"LLLL"\)/,
                    replace: "$1$self.renderTooltip({date:arguments[0].timestamp})",
                },
            ]
        },
        {
            find: /.full,.{0,15}children:/,
            replacement: {
                // Tooltips for timestamp markdown (e.g. <t:1234567890>)
                match: /(__unsupportedReactNodeAsText:)\i.full/,
                replace: "$1$self.renderTooltip({date:new Date(arguments[0].node.timestamp*1000)})"
            }
        }
    ],

    stop() {
        clearTimestampRefresh();
    },

    renderTimestamp,
    renderTooltip: ErrorBoundary.wrap(({ date }: { date: Date; }) => renderTimestamp(date, "tooltip"), { noop: true })
});
