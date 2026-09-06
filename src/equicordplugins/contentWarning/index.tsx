/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, camila314, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { HeadingTertiary } from "@components/Heading";
import { DeleteIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { useForceUpdater } from "@utils/react";
import { escapeRegExp } from "@utils/text";
import definePlugin, { OptionType } from "@utils/types";
import { Button, TextInput, useState } from "@webpack/common";

const cl = classNameFactory("vc-content-warning-");

const WORDS_KEY = "ContentWarning_words";

let triggerWords = [""];
let triggerWordRegex: RegExp | null = null;

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
    const { onClick } = settings.store;

    if (visible) {
        return child;
    } else {
        return (
            <div
                className={cl("container")}
                onClick={() => onClick && setVisible(true)}
                onMouseEnter={event => {
                    if (!onClick) {
                        event.currentTarget.className = cl("enter");
                    }
                }}
                onMouseLeave={event => {
                    if (!onClick) {
                        event.currentTarget.className = cl("leave");
                    }
                }}
            >
                {child}
            </div >
        );
    }
}

function FlaggedInput({ index, forceUpdate }) {
    const [value, setValue] = useState(triggerWords[index]);

    if (value !== triggerWords[index]) {
        setValue(triggerWords[index]);
    }

    const isLast = index === triggerWords.length - 1;

    const updateValue = v => {
        triggerWords[index] = v;
        setValue(v);

        if (isLast) {
            triggerWords.push("");
            forceUpdate();
        }

        saveTriggerWords();
    };

    const removeSelf = () => {
        if (triggerWords.length === 1) {
            return;
        }
        triggerWords = triggerWords.slice(0, index).concat(triggerWords.slice(index + 1));
        saveTriggerWords();
        forceUpdate();
    };

    return (<Flex flexDirection="row">
        <div style={{ flexGrow: 1 }}>
            <TextInput
                placeholder="Word"
                spellCheck={false}
                value={value}
                onChange={updateValue}
            />
        </div>

        <Button
            onClick={removeSelf}
            look={Button.Looks.FILLED}
            size={Button.Sizes.SMALL}
            style={{
                padding: 0,
                color: "var(--primary-400)",
                transition: "color 0.2s ease-in-out",
                opacity: isLast ? "0%" : "100%"
            }}>
            <DeleteIcon />
        </Button>
    </Flex>);
}

function FlaggedWords() {
    const forceUpdate = useForceUpdater();

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
            replacement: {
                match: /(compact:\i}=\i.+?)(\(0,.+\}\)\]\}\))/,
                replace: "$1 $self.modify(arguments[0].message,$2)"
            }
        }
    ],

    modify(message, child) {
        if (hasTriggerWord(message.content)) {
            return <TriggerContainer child={child} />;
        } else {
            return child;
        }
    },

    async start() {
        triggerWords = await DataStore.get(WORDS_KEY) ?? [""];
        compileTriggerWords();
    }
});
