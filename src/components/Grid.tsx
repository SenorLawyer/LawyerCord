/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CSSProperties, JSX } from "react";

interface Props {
    columns: number;
    gap?: string;
    inline?: boolean;
}

export function Grid({ columns, gap, inline, style: customStyle, ...props }: Props & JSX.IntrinsicElements["div"]) {
    const style: CSSProperties = {
        display: inline ? "inline-grid" : "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap,
        ...customStyle
    };

    return (
        <div {...props} style={style}>
            {props.children}
        </div>
    );
}
