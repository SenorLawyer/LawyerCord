/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TextButton } from "@components/Button";
import { GoogleLanguages } from "@plugins/translate/languages";
import { Message } from "@vencord/discord-types";
import { Parser, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { Icon } from "./icon";
import { translate } from "./translator";

type Translation = Awaited<ReturnType<typeof translate>>;

const languages = { ...GoogleLanguages, tp: "Toki Pona", sh: "Shavian" };
const setters = new Map<string, { listeners: Set<(translation: Translation | undefined) => void>; request?: symbol; }>();

export function Accessory({ message }: { message: Message & { vencordEmbeddedBy?: string[]; }; }) {
    const key = `${message.id}:${message.content}`;
    const [translation, setTranslation] = useState<Translation | undefined>(undefined);

    useEffect(() => {
        if (message.vencordEmbeddedBy) return;

        const entry = setters.get(key) ?? { listeners: new Set<(translation: Translation | undefined) => void>() };
        entry.listeners.add(setTranslation);
        setters.set(key, entry);

        return () => {
            entry.listeners.delete(setTranslation);
            if (!entry.listeners.size) setters.delete(key);
        };
    }, [key]);

    if (!translation) return null;

    return (
        <div className="eq-trans-accessory">
            <Icon width={16} height={16} />
            {Parser.parse(translation.text)}
            {" "}
            (translated from {Object.hasOwn(languages, translation.src) ? languages[translation.src] : translation.src} - <TextButton type="button" variant="link" onClick={() => setTranslation(undefined)}>Dismiss</TextButton>)
        </div>
    );
}

export async function handleTranslate(message: Message) {
    if (!message.content) return;

    const key = `${message.id}:${message.content}`;
    const entry = setters.get(key);
    if (!entry) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    const request = entry.request = Symbol();

    try {
        const translation = await translate(message.content);
        if (setters.get(key) === entry && entry.request === request && UserStore.getCurrentUser()?.id === userId)
            for (const setter of entry.listeners) setter(translation);
    } catch {
        if (setters.get(key) === entry && entry.request === request && UserStore.getCurrentUser()?.id === userId)
            showToast("Could not translate this message.", Toasts.Type.FAILURE);
    }
}
