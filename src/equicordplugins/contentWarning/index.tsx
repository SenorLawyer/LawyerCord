/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, camila314, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Flex } from "@components/Flex";
import { HeadingTertiary } from "@components/Heading";
import { DeleteIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { useAwaiter, useForceUpdater } from "@utils/react";
import { escapeRegExp } from "@utils/text";
import definePlugin, { OptionType } from "@utils/types";
import { Button, TextInput, useState } from "@webpack/common";

const cl = classNameFactory("vc-content-warning-");
const logger = new Logger("ContentWarning");

const WORDS_KEY = "ContentWarning_words";
const REVEAL_SETTINGS: "onClick"[] = ["onClick"];

let triggerWords = [""];
let triggerWordRegex: RegExp | null = null;
let wordsPromise: Promise<void> | undefined;

function loadTriggerWords() {
    if (wordsPromise) return wordsPromise;
    const pending = DataStore.get<unknown>(WORDS_KEY).then(raw => {
        if (wordsPromise !== pending) return;
        const words = raw ?? [];
        if (!Array.isArray(words) || !words.every((word: unknown) => typeof word === "string")) {
            throw new Error("Invalid saved trigger words.");
        }
        triggerWords = words;
        if (triggerWords.at(-1) !== "") triggerWords.push("");
        compileTriggerWords();
    });
    wordsPromise = pending;
    return pending;
}

function compileTriggerWords() {
    const escapedWords: string[] = [];
    for (const rawWord of triggerWords) {
        const word = rawWord.trim();
        if (word) escapedWords.push(escapeRegExp(word));
    }

    triggerWordRegex = escapedWords.length
        ? new RegExp(escapedWords.join("|"))
        : null;
}

function saveTriggerWords() {
    compileTriggerWords();
    void DataStore.set(WORDS_KEY, triggerWords);
}

function hasTriggerWord(content: string) {
    return triggerWordRegex?.test(content) ?? false;
}

function TriggerContainer({ child }) {
    const [visible, setVisible] = useState(false);
    const { onClick } = settings.use(REVEAL_SETTINGS);

    if (visible) {
        return child;
    } else {
        return (
            <div
                className={cl("container", { hover: !onClick })}
                onClick={() => onClick && setVisible(true)}
            >
                {child}
            </div >
        );
    }
}

function FlaggedInput({ index, forceUpdate }) {
    const isLast = index === triggerWords.length - 1;

    const updateValue = v => {
        triggerWords[index] = v;

        if (isLast) {
            triggerWords.push("");
        }

        saveTriggerWords();
        forceUpdate();
    };

    const removeSelf = () => {
        triggerWords = triggerWords.slice(0, index).concat(triggerWords.slice(index + 1));
        saveTriggerWords();
        forceUpdate();
    };

    return (<Flex flexDirection="row">
        <div style={{ flexGrow: 1 }}>
            <TextInput
                placeholder="Word"
                spellCheck={false}
                value={triggerWords[index]}
                onChange={updateValue}
            />
        </div>

        {isLast ? null : <Button
            onClick={removeSelf}
            aria-label="Delete word"
            look={Button.Looks.FILLED}
            size={Button.Sizes.SMALL}
            style={{
                padding: 0,
                color: "var(--primary-400)",
                transition: "color 0.2s ease-in-out"
            }}>
            <DeleteIcon />
        </Button>}
    </Flex>);
}

function FlaggedWords() {
    const forceUpdate = useForceUpdater();
    const [, error, pending] = useAwaiter(loadTriggerWords);

    if (pending) return <BaseText>Loading words...</BaseText>;
    if (error) return <BaseText>Words could not be loaded. Restart Discord to try again.</BaseText>;

    const inputs = triggerWords.map((_, idx) => {
        return (
            <FlaggedInput
                key={idx}
                index={idx}
                forceUpdate={forceUpdate}
            />
        );
    });

    return (
        <>
            <HeadingTertiary>Flagged Words</HeadingTertiary>
            {inputs}
        </>
    );
}

const settings = definePluginSettings({
    flagged: {
        type: OptionType.COMPONENT,
        component: () => <FlaggedWords />,
    },
    onClick: {
        type: OptionType.BOOLEAN,
        description: "Only show trigger content on click instead of hover",
        default: false,
    }
});

export default definePlugin({
    name: "ContentWarning",
    authors: [EquicordDevs.camila314],
    description: "Allows you to specify certain trigger words that will be blurred by default. Hovering/Clicking on the blurred content will reveal it.",
    tags: ["Appearance", "Utility"],
    settings,
    patches: [
        {
            find: ".VOICE_HANGOUT_INVITE?",
            group: true,
            replacement: [
                {
                    match: /(?=\(0,\i\.jsxs\)\("div",\{id:\(0,\i\.\i\)\(\i\),ref:)/,
                    replace: "$self.modify(arguments[0].message,"
                },
                {
                    match: /WITH_CONTENT\}\)\]\}\)/,
                    replace: "$&)"
                }
            ]
        }
    ],

    modify(message, child) {
        if (hasTriggerWord(message.content)) {
            return <TriggerContainer key={`${message.id}:${message.content}`} child={child} />;
        } else {
            return child;
        }
    },

    start() {
        return loadTriggerWords().catch(() => logger.error("Could not load trigger words."));
    },

    stop() {
        wordsPromise = undefined;
    }
});
