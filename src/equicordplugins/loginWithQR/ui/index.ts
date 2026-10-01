/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { classNameFactory } from "@utils/css";
import { findComponentByCodeLazy } from "@webpack";
import type { HTMLAttributes } from "react";

interface SpinnerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
    type?: "wanderingCubes";
    animated?: boolean;
    itemClassName?: string;
}

// https://github.com/Kyuuhachi/VencordPlugins/blob/main/MessageLinkTooltip/index.tsx#L11-L33
export const Spinner = findComponentByCodeLazy<SpinnerProps>('"pulsingEllipsis"');

export const cl = classNameFactory("qrlogin-");
