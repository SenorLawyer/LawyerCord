/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, camila314, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Button, TextButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { DeleteIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { useAwaiter, useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByCodeLazy, findCssClassesLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Select, SelectedChannelStore, TabBar, TextInput, Tooltip, useEffect, UserStore, useState } from "@webpack/common";
import type { JSX, PropsWithChildren, ReactNode } from "react";

type IconProps = JSX.IntrinsicElements["svg"];
type KeywordEntry = { regex: string, listIds: Array<string>, listType: ListType, ignoreCase: boolean; };
type CompiledKeywordEntry = { entry: KeywordEntry, regex: RegExp, listIds: Set<string>, whitelistMode: boolean; };
type KeywordEmbed = { description?: string, title?: string, fields?: Array<{ name?: string, value?: string; }>; };

const logger = new Logger("KeywordNotify");

let generation = 0;
let started = false;

let keywordEntries: Array<KeywordEntry> = [];
let entriesLoaded = false;
let entriesLoading: Promise<KeywordEntry[]> | undefined;
let compiledKeywordEntries: Array<CompiledKeywordEntry> = [];
let keywordLog: Array<any> = [];
let storedKeywordLog: string[] = [];
const storedKeywordLogIds = new Set<string>();
let interceptor: (e: any) => void;

const recentMentionsPopoutClass = findCssClassesLazy("recentMentionsPopout", "scroller");
const tabClass = findCssClassesLazy("inboxTitle", "tab");
const Popout = findByCodeLazy("getProTip", "canCloseAllMessages:");
const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");
const KEYWORD_ENTRIES_KEY = "KeywordNotify_keywordEntries";
const KEYWORD_LOG_KEY = "KeywordNotify_log";

const cl = classNameFactory("vc-keywordnotify-");

function rebuildKeywordMatchers() {
    const nextCompiledEntries: Array<CompiledKeywordEntry> = [];

    for (const entry of keywordEntries) {
        if (!entry.regex) continue;

        try {
            const listIds = new Set<string>();
            for (const rawId of entry.listIds) {
                const id = rawId.trim();
                if (id) listIds.add(id);
            }

            nextCompiledEntries.push({
                entry,
                regex: new RegExp(entry.regex, entry.ignoreCase ? "i" : ""),
                listIds,
                whitelistMode: entry.listType === ListType.Whitelist
            });
        } catch {
        }
    }

    compiledKeywordEntries = nextCompiledEntries;
}

function isKeywordEntry(entry: unknown): entry is KeywordEntry {
    return typeof entry === "object" && entry !== null
        && "regex" in entry && typeof entry.regex === "string"
        && "listIds" in entry && Array.isArray(entry.listIds) && entry.listIds.every(id => typeof id === "string")
        && "listType" in entry && (entry.listType === ListType.BlackList || entry.listType === ListType.Whitelist)
        && "ignoreCase" in entry && typeof entry.ignoreCase === "boolean";
}

function loadKeywordEntries(): Promise<KeywordEntry[]> {
    if (entriesLoaded) return Promise.resolve(keywordEntries);
    return entriesLoading ??= DataStore.get<unknown>(KEYWORD_ENTRIES_KEY).then(entries => {
        keywordEntries = Array.isArray(entries) ? entries.filter(isKeywordEntry) : [];
        if (entries != null && (!Array.isArray(entries) || keywordEntries.length !== entries.length))
            logger.warn("Some stored keyword rules are invalid. Valid rules remain active.");
        entriesLoaded = true;
        rebuildKeywordMatchers();
        return keywordEntries;
    }).finally(() => { entriesLoading = undefined; });
}

async function persistKeywordEntries() {
    rebuildKeywordMatchers();
    await DataStore.set(KEYWORD_ENTRIES_KEY, keywordEntries);
}

function getStoredKeywordLogId(raw: string) {
    try {
        return JSON.parse(raw)?.id as string | undefined;
    } catch {
        return undefined;
    }
}

function trimStoredKeywordLog() {
    const limit = Math.max(0, settings.store.amountToKeep);
    while (storedKeywordLog.length > limit) {
        const removedId = getStoredKeywordLogId(storedKeywordLog.shift()!);
        if (removedId) storedKeywordLogIds.delete(removedId);
    }
}

async function addKeywordEntry(forceUpdate: () => void) {
    keywordEntries.push({ regex: "", listIds: [], listType: ListType.BlackList, ignoreCase: false });
    await persistKeywordEntries();
    forceUpdate();
}

async function removeKeywordEntry(idx: number, forceUpdate: () => void) {
    keywordEntries.splice(idx, 1);
    await persistKeywordEntries();
    forceUpdate();
}

function matchesRegex(str: unknown, regex: RegExp) {
    return typeof str === "string" && regex.test(str);
}

enum ListType {
    BlackList = "BlackList",
    Whitelist = "Whitelist"
}

interface BaseIconProps extends IconProps {
    viewBox: string;
}

function highlightKeywords(str: string) {
    let match: string | undefined;
    for (const { regex } of compiledKeywordEntries) {
        match = str.match(regex)?.[0];
        if (match) break;
    }

    if (!match) return [str];

    const idx = str.indexOf(match);

    return (
        <>
            <span>{str.substring(0, idx)}</span>
            <span className="highlight">{match}</span>
            <span>{str.substring(idx + match.length)}</span>
        </>
    );
}

function Collapsible({ title, children }) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div>
            <TextButton
                onClick={() => setIsOpen(!isOpen)}
                className={cl("collapsible")}>
                <div style={{ display: "flex", alignItems: "center" }}>
                    <div style={{
                        marginLeft: "auto",
                        color: "var(--text-muted)",
                        paddingRight: "5px"
                    }}>{isOpen ? "▼" : "▶"}</div>
                    <Heading tag="h4">{title}</Heading>
                </div>
            </TextButton>
            {isOpen && children}
        </div>
    );
}

function ListedIds({ listIds, setListIds }) {
    const update = useForceUpdater();
    const [values] = useState(listIds);

    async function onChange(e: string, index: number) {
        values[index] = e.trim();
        setListIds(values);
        update();
    }

    const elements = values.map((currentValue: string, index: number) => {
        return (
            <Flex key={index} flexDirection="row" style={{ marginBottom: "5px" }}>
                <div style={{ flexGrow: 1 }}>
                    <TextInput
                        placeholder="ID"
                        spellCheck={false}
                        value={currentValue}
                        onChange={e => onChange(e, index)}
                    />
                </div>
                <Button
                    onClick={() => {
                        values.splice(index, 1);
                        setListIds(values);
                        update();
                    }}
                    variant="none"
                    size="iconOnly"
                    className={cl("delete")}>
                    <DeleteIcon />
                </Button>
            </Flex>
        );
    });

    return (
        <>
            {elements}
        </>
    );
}

function ListTypeSelector({ listType, setListType }: { listType: ListType, setListType: (v: ListType) => void; }) {
    return (
        <Select
            options={[
                { label: "Whitelist", value: ListType.Whitelist },
                { label: "Blacklist", value: ListType.BlackList }
            ]}
            placeholder={"Select a list type"}
            isSelected={v => v === listType}
            closeOnSelect={true}
            select={setListType}
            serialize={v => v}
        />
    );
}

function KeywordEntries() {
    const [entries, error] = useAwaiter(loadKeywordEntries);
    if (error) return <div>Could not load keyword rules. Close settings and try again.</div>;
    if (!entries) return null;
    return <KeywordEntriesEditor entries={entries} />;
}

function KeywordEntriesEditor({ entries }: { entries: KeywordEntry[]; }) {
    const update = useForceUpdater();
    const [values] = useState(entries);

    async function setRegex(index: number, value: string) {
        if (values !== keywordEntries) return;
        keywordEntries[index].regex = value;
        await persistKeywordEntries();
        update();
    }

    async function setListType(index: number, value: ListType) {
        if (values !== keywordEntries) return;
        keywordEntries[index].listType = value;
        await persistKeywordEntries();
        update();
    }

    async function setListIds(index: number, value: Array<string>) {
        if (values !== keywordEntries) return;
        keywordEntries[index].listIds = value ?? [];
        await persistKeywordEntries();
        update();
    }

    async function setIgnoreCase(index: number, value: boolean) {
        if (values !== keywordEntries) return;
        keywordEntries[index].ignoreCase = value;
        await persistKeywordEntries();
        update();
    }

    const elements = keywordEntries.map((entry, i) => {
        return (
            <>
                <Collapsible title={`Keyword Entry ${i + 1}`}>
                    <Flex flexDirection="row">
                        <div style={{ flexGrow: 1 }}>
                            <TextInput
                                placeholder="example|regex"
                                spellCheck={false}
                                value={values[i].regex}
                                onChange={e => setRegex(i, e)}
                            />
                        </div>
                        <Button
                            onClick={() => { if (values === keywordEntries) removeKeywordEntry(i, update); }}
                            variant="none"
                            size="iconOnly"
                            className={cl("delete")}>
                            <DeleteIcon />
                        </Button>
                    </Flex>
                    <FormSwitch
                        title="Ignore Case"
                        className={cl("ignoreCaseSwitch")}
                        value={values[i].ignoreCase}
                        onChange={() => {
                            setIgnoreCase(i, !values[i].ignoreCase);
                        }}
                    />
                    <Heading tag="h5">Whitelist/Blacklist</Heading>
                    <Flex flexDirection="row">
                        <div style={{ flexGrow: 1 }}>
                            <ListedIds listIds={values[i].listIds} setListIds={e => setListIds(i, e)} />
                        </div>
                    </Flex>
                    <div className={[Margins.top8, Margins.bottom8].join(" ")} />
                    <Flex flexDirection="row">
                        <Button onClick={() => {
                            if (values !== keywordEntries) return;
                            values[i].listIds.push("");
                            update();
                        }}>Add ID</Button>
                        <div style={{ flexGrow: 1 }}>
                            <ListTypeSelector listType={values[i].listType} setListType={e => setListType(i, e)} />
                        </div>
                    </Flex>
                </Collapsible>
            </>
        );
    });

    return (
        <>
            {elements}
            <div><Button onClick={() => { if (values === keywordEntries) addKeywordEntry(update); }}>Add Keyword Entry</Button></div>
        </>
    );
}

function Icon({ height = 24, width = 24, className, children, viewBox, ...svgProps }: PropsWithChildren<BaseIconProps>) {
    return (
        <svg
            className={classes(className, "vc-icon")}
            role="img"
            width={width}
            height={height}
            viewBox={viewBox}
            {...svgProps}
        >
            {children}
        </svg>
    );
}

// Ideally I would just add this to Icons.tsx, but I cannot as this is a user-plugin :/
function DoubleCheckmarkIcon(props: IconProps) {
    // noinspection TypeScriptValidateTypes
    return (
        <Icon
            {...props}
            className={classes(props.className, "vc-double-checkmark-icon")}
            viewBox="0 0 24 24"
            width={16}
            height={16}
        >
            <path fill="currentColor"
                d="M16.7 8.7a1 1 0 0 0-1.4-1.4l-3.26 3.24a1 1 0 0 0 1.42 1.42L16.7 8.7ZM3.7 11.3a1 1 0 0 0-1.4 1.4l4.5 4.5a1 1 0 0 0 1.4-1.4l-4.5-4.5Z"
            />
            <path fill="currentColor"
                d="M21.7 9.7a1 1 0 0 0-1.4-1.4L13 15.58l-3.3-3.3a1 1 0 0 0-1.4 1.42l4 4a1 1 0 0 0 1.4 0l8-8Z"
            />
        </Icon>
    );
}

const settings = definePluginSettings({
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages from bots",
        default: true
    },
    amountToKeep: {
        type: OptionType.NUMBER,
        description: "Amount of messages to keep in the log",
        default: 50
    },
    keywords: {
        type: OptionType.COMPONENT,
        description: "Manage keywords",
        component: () => <KeywordEntries />
    }
});

interface KeywordMenuProps {
    plugin: {
        onUpdate(): void;
        renderMsg(props: object): ReactNode;
        deleteKeyword(id: string): void;
        discardMessage(id: string): void;
    };
    onJump: unknown;
}

function KeywordMenu({ plugin, onJump }: KeywordMenuProps) {
    const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());

    const [tempLogs, setKeywordLog] = useState(keywordLog);
    useEffect(() => {
        if (!started) return;
        const update = () => setKeywordLog(Array.from(keywordLog));
        plugin.onUpdate = update;
        update();
        return () => {
            if (plugin.onUpdate === update) plugin.onUpdate = () => { };
        };
    }, [plugin]);

    const messageRender = (e: Message & { _keyword?: boolean; }, t: unknown) => {
        e._keyword = true;

        e.customRenderedContent = {
            content: highlightKeywords(e.content)
        };

        const msg = plugin.renderMsg({
            message: e,
            gotoMessage: t,
            dismissible: true
        });

        return [msg];
    };

    return (
        <>
            <Popout
                className={classes(recentMentionsPopoutClass.recentMentionsPopout)}
                scrollerClassName={classes(recentMentionsPopoutClass.scroller)}
                renderHeader={() => null}
                renderMessage={messageRender}
                channel={channel}
                onJump={onJump}
                onFetch={() => null}
                onCloseMessage={(id: string) => {
                    plugin.deleteKeyword(id);
                    plugin.discardMessage(id);
                }}
                loadMore={() => null}
                messages={tempLogs}
                renderEmptyState={() => null}
                canCloseAllMessages={true}
            />
        </>
    );
}

export default definePlugin({
    name: "KeywordNotify",
    performance: { impact: "medium", description: "Matches message events against configured expressions and saves matching notifications." },
    authors: [EquicordDevs.camila314, EquicordDevs.x3rt],
    description: "Sends a notification if a given message matches certain keywords or regexes",
    tags: ["Chat", "Notifications"],
    settings,
    patches: [
        {
            find: "#{intl::UNREADS_TAB_LABEL})}",
            group: true,
            replacement: [
                {
                    match: /#{intl::Fn6Odn::raw}\)\}\)\}\):null/,
                    replace: "$&,$self.keywordTabBar()"
                },
                {
                    match: /:(\i)===\i\.\i\.MENTIONS\?\(0,.{0,500}null}/,
                    replace: ": $1 === 8 ? $self.keywordClearButton() $&"
                },
                {
                    match: /:(\i)===\i\.\i\.MENTIONS\?\(0,.{0,500}onJump:(\i)}\)/,
                    replace: ": $1 === 8 ? $self.tryKeywordMenu($2) $&"
                }
            ]
        },
        {
            find: "#{intl::RECENT_MENTIONS_EMPTY_STATE_TIP}",
            replacement: [
                {
                    match: /function (\i)\(\i\){let{message:\i,onJump/,
                    replace: "$self.renderMsg = $1; $&"
                },
                {
                    match: /onClick:\(\)=>(\i\.\i\.deleteRecentMention\((\i)\.id\))/,
                    replace: "onClick: () => $2._keyword ? $self.deleteKeyword($2.id) : $1"
                }
            ]
        },
    ],

    onUpdate() { },
    renderMsg: (_props: object): ReactNode => null,

    async start() {
        const current = ++generation;
        started = true;
        this.onUpdate = () => null;
        await loadKeywordEntries();
        if (current !== generation) return;
        const logs = await DataStore.get(KEYWORD_LOG_KEY) ?? [];
        if (current !== generation) return;
        rebuildKeywordMatchers();
        storedKeywordLog = logs;
        storedKeywordLogIds.clear();
        storedKeywordLog.forEach(raw => {
            try {
                const message = JSON.parse(raw);
                if (message?.id) storedKeywordLogIds.add(message.id);
                this.addToLog(message);
            } catch (err) {
                console.error(err);
            }
        });

        interceptor = (e: any) => {
            return this.modify(e);
        };

        FluxDispatcher.addInterceptor(interceptor);
    },

    stop() {
        generation++;
        started = false;
        keywordLog = [];
        this.onUpdate();
        this.onUpdate = () => { };
        compiledKeywordEntries = [];
        storedKeywordLog = [];
        storedKeywordLogIds.clear();
        const index = FluxDispatcher._interceptors.indexOf(interceptor);
        if (index > -1) {
            FluxDispatcher._interceptors.splice(index, 1);
        }
    },

    applyKeywordEntries(m: Message) {
        if (!compiledKeywordEntries.length) return;

        let matches = false;
        let guildId: string | null | undefined;
        const { ignoreBots } = settings.store;

        for (const entry of compiledKeywordEntries) {
            let listed = entry.listIds.has(m.channel_id) || entry.listIds.has(m.author.id);
            if (!listed && entry.listIds.size) {
                if (guildId === undefined) guildId = ChannelStore.getChannel(m.channel_id)?.guild_id ?? null;
                if (guildId !== null) listed = entry.listIds.has(guildId);
            }

            if (!entry.whitelistMode && listed) {
                continue;
            }
            if (entry.whitelistMode && !listed) {
                continue;
            }

            if (ignoreBots && m.author.bot && (!entry.whitelistMode || !entry.listIds.has(m.author.id))) {
                continue;
            }

            if (matchesRegex(m.content, entry.regex)) {
                matches = true;
            } else {
                for (const embed of (m.embeds as KeywordEmbed[] | undefined) ?? []) {
                    if (matchesRegex(embed.description, entry.regex) || matchesRegex(embed.title, entry.regex)) {
                        matches = true;
                        break;
                    } else if (embed.fields != null) {
                        for (const field of embed.fields) {
                            if (matchesRegex(field.value, entry.regex) || matchesRegex(field.name, entry.regex)) {
                                matches = true;
                                break;
                            }
                        }
                    }
                    if (matches) break;
                }
            }

            if (matches) break;
        }

        if (matches) {
            const id = UserStore.getCurrentUser()?.id;
            if (id != null) {
                // @ts-ignore
                m.mentions.push({ id: id });
            }

            if (m.author.id !== id) {
                this.storeMessage(m);
                this.addToLog(m);
            }
        }
    },
    storeMessage(m: Message) {
        if (!started) return;
        if (m == null)
            return;

        if (storedKeywordLogIds.has(m.id)) return;

        storedKeywordLog.push(JSON.stringify(m));
        storedKeywordLogIds.add(m.id);
        trimStoredKeywordLog();

        DataStore.set(KEYWORD_LOG_KEY, storedKeywordLog);
    },
    discardMessage(id: string) {
        if (!started) return;
        storedKeywordLog = storedKeywordLog.filter(raw => getStoredKeywordLogId(raw) !== id);
        storedKeywordLogIds.delete(id);

        DataStore.set(KEYWORD_LOG_KEY, storedKeywordLog);
    },
    addToLog(m: Message) {
        if (!started || m == null || keywordLog.some(e => e.id === m.id))
            return;

        let messageRecord: any;
        try {
            messageRecord = createMessageRecord(m);
        } catch (err) {
            console.error(err);
            return;
        }

        keywordLog.push(messageRecord);
        keywordLog.sort((a, b) => b.timestamp - a.timestamp);

        const limit = Math.max(0, settings.store.amountToKeep);
        while (keywordLog.length > limit) {
            keywordLog.pop();
        }

        this.onUpdate();
    },

    deleteKeyword(id: string) {
        if (!started) return;
        keywordLog = keywordLog.filter(e => e.id !== id);
        this.onUpdate();
    },

    keywordTabBar() {
        return (
            <TabBar.Item className={classes(tabClass.tab)} id={8}>
                Keywords
            </TabBar.Item>
        );
    },

    keywordClearButton() {
        return (
            <Tooltip text="Clear All">
                {({ onMouseLeave, onMouseEnter }) => (
                    <Button
                        variant="secondary"
                        size="iconOnly"
                        onMouseLeave={onMouseLeave}
                        onMouseEnter={onMouseEnter}
                        onClick={() => {
                            if (!started) return;
                            keywordLog = [];
                            storedKeywordLog = [];
                            storedKeywordLogIds.clear();
                            DataStore.set(KEYWORD_LOG_KEY, storedKeywordLog);
                            this.onUpdate();
                        }}>
                        <DoubleCheckmarkIcon />
                    </Button>
                )}
            </Tooltip>
        );
    },

    tryKeywordMenu(onJump: unknown) {
        return <ErrorBoundary noop><KeywordMenu plugin={this} onJump={onJump} /></ErrorBoundary>;
    },

    modify(e) {
        if (e.type === "MESSAGE_CREATE" || e.type === "MESSAGE_UPDATE") {
            this.applyKeywordEntries(e.message);
        } else if (e.type === "LOAD_MESSAGES_SUCCESS") {
            for (let msg = 0; msg < e.messages.length; ++msg) {
                this.applyKeywordEntries(e.messages[msg]);
            }
        }
    }
});
