/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    AppsIcon,
    ClockIcon,
    FolderIcon,
    HammerAndChiselIcon,
    HeadphonesIcon,
    IDIcon,
    PencilSparkleIcon,
    ReplyIcon,
    RobotIcon,
    SafetyIcon,
} from "@components/Icons";
import type { ComponentType } from "react";

import { type AutomationBlockCategory, type AutomationBlockType, BLOCK_DEFINITIONS, MARKER_TYPES } from "./model";

interface IconProps {
    width?: number;
    height?: number;
}

/** One icon per category, so a node's job reads before its label does. */
export const BLOCK_ICONS: Record<AutomationBlockCategory, ComponentType<IconProps>> = {
    messages: ReplyIcon,
    commands: HammerAndChiselIcon,
    client: AppsIcon,
    spotify: HeadphonesIcon,
    data: FolderIcon,
    ai: PencilSparkleIcon,
    waits: ClockIcon,
    interactions: RobotIcon,
    flow: SafetyIcon,
    variables: IDIcon,
};

export const CATEGORY_LABELS: Record<AutomationBlockCategory, string> = {
    messages: "Messages",
    commands: "Commands",
    client: "Client",
    spotify: "Spotify",
    data: "Read data",
    ai: "AI",
    waits: "Waiting",
    interactions: "Interactions",
    flow: "Logic",
    variables: "Variables",
};

export function blockDefinition(type: AutomationBlockType) {
    return BLOCK_DEFINITIONS.find(item => item.type === type) ?? BLOCK_DEFINITIONS[0];
}

/** Everything the palette offers. Legacy structural markers are graph edges now. */
export function paletteBlocks() {
    return BLOCK_DEFINITIONS.filter(block => block.available !== false && !MARKER_TYPES.includes(block.type));
}
