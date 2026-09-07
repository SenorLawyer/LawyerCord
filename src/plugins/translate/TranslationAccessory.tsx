/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { TextButton } from "@components/Button";
import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { TranslateIcon } from "./TranslateIcon";
import { cl, TranslationValue } from "./utils";

const TranslationSetters = new Map<string, Set<(v: TranslationValue) => void>>();

export function handleTranslate(messageId: string, data: TranslationValue) {
    for (const setter of TranslationSetters.get(messageId) ?? [])
        setter(data);
}

export function TranslationAccessory({ message }: { message: Message & { vencordEmbeddedBy?: string[]; }; }) {
    const [translation, setTranslation] = useState<TranslationValue>();

    useEffect(() => {
        // Ignore MessageLinkEmbeds messages
        if (message.vencordEmbeddedBy) return;

        const setters = TranslationSetters.get(message.id) ?? new Set<(value: TranslationValue) => void>();
        setters.add(setTranslation);
        TranslationSetters.set(message.id, setters);

        return () => {
            setters.delete(setTranslation);
            if (!setters.size)
                TranslationSetters.delete(message.id);
        };
    }, []);

    if (!translation) return null;

    return (
        <span className={cl("accessory")}>
            <TranslateIcon width={16} height={16} className={cl("accessory-icon")} />
            {Parser.parse(translation.text)}
            <br />
            (translated from {translation.sourceLanguage} - <TextButton type="button" variant="link" onClick={() => setTranslation(undefined)}>Dismiss</TextButton>)
        </span>
    );
}
