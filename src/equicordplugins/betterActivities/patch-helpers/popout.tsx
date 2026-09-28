/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { React, useState } from "@webpack/common";
import type { ReactElement } from "react";

import { settings } from "../settings";
import { cl } from "../utils";

const STYLE_KEYS: ["allActivitiesStyle"] = ["allActivitiesStyle"];

interface ActivityCardsProps {
    cards: ReactElement[];
}

const ActivityCards = ErrorBoundary.wrap(({ cards }: ActivityCardsProps) => {
    const { allActivitiesStyle } = settings.use(STYLE_KEYS);
    const [selectedKey, setSelectedKey] = useState<ReactElement["key"]>(null);
    const index = Math.max(0, cards.findIndex(card => card.key === selectedKey));

    if (!cards.length) return null;
    if (allActivitiesStyle === "list") return <div className={cl("activity-list")}>{cards}</div>;

    return <>
        {cards[index]}
        {cards.length > 1 && <div className={cl("controls")}>
            <Button size="small" onClick={() => setSelectedKey(cards[(index + cards.length - 1) % cards.length].key)}>
                Previous
            </Button>
            <div className={cl("controls-carousel")}>
                {cards.map((card, position) => <Button
                    key={card.key}
                    size="min"
                    variant="none"
                    aria-label={`Show activity ${position + 1}`}
                    aria-pressed={position === index}
                    className={cl("controls-dot", { "controls-selected": position === index })}
                    onClick={() => setSelectedKey(card.key)}
                />)}
            </div>
            <Button size="small" onClick={() => setSelectedKey(cards[(index + 1) % cards.length].key)}>
                Next
            </Button>
        </div>}
    </>;
}, { noop: true });

export function wrapActivityCards(renderCards: (props: { className: string; }) => ReactElement[]) {
    return (props: { className: string; }) => {
        const cards = renderCards(props);
        return cards.length ? [<ActivityCards key="activities" cards={cards} />] : [];
    };
}
