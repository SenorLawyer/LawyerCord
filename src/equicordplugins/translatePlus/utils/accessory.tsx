/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TextButton } from "@components/Button";
import { languages } from "@equicordplugins/translatePlus/misc/languages";
import { cl, Translation } from "@equicordplugins/translatePlus/misc/types";
import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { Icon } from "./icon";
import { translate } from "./translator";

const setters = new Map<string, Set<(translation: Translation | undefined) => void>>();

export function Accessory({ message }: { message: Message & { vencordEmbeddedBy?: string[]; }; }) {
    const [translation, setTranslation] = useState<Translation | undefined>(undefined);

    useEffect(() => {
        if (message.vencordEmbeddedBy) return;

        const listeners = setters.get(message.id) ?? new Set<(translation: Translation | undefined) => void>();
        listeners.add(setTranslation);
        setters.set(message.id, listeners);

        return () => {
            listeners.delete(setTranslation);
            if (!listeners.size) setters.delete(message.id);
        };
    }, [message.id]);

    if (!translation) return null;

    return (
        <div className={cl("accessory")}>
            <Icon width={16} height={16} />
            {Parser.parse(translation.text)}
            {" "}
            (translated from {Object.hasOwn(languages, translation.src) ? languages[translation.src] : translation.src} - <TextButton type="button" variant="link" onClick={() => setTranslation(undefined)}>Dismiss</TextButton>)
        </div>
    );
}

export async function handleTranslate(message: Message) {
    if (!message.content) return;

    const listeners = setters.get(message.id);
    if (!listeners) return;

    try {
        const translation = await translate(message.content);
        if (setters.get(message.id) === listeners)
            for (const setter of listeners) setter(translation);
    } catch (error) {
        console.error("[TranslatePlus] Failed to translate message:", error);
        if (setters.get(message.id) === listeners)
            for (const setter of listeners) setter({ src: "en", text: "Translation failed due to an error." });
    }
}
