/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    AppsIcon,
    ClockIcon,
    FolderIcon,
    GameControllerIcon,
    HammerAndChiselIcon,
    HeadphonesIcon,
    IDIcon,
    LogsIcon,
    NotesIcon,
    PencilSparkleIcon,
    ReplyIcon,
    RobotIcon,
    SafetyIcon,
} from "@components/Icons";
import type { ComponentType } from "react";

import { type Automation, type AutomationBlockCategory, type AutomationBlockType, type AutomationTriggerType, BLOCK_DEFINITIONS, formatSchedule, MARKER_TYPES } from "./model";

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
    computer: LogsIcon,
    roblox: GameControllerIcon,
    codex: NotesIcon,
};

export const CATEGORY_LABELS: Record<AutomationBlockCategory, string> = {
    messages: "Messages",
    commands: "Commands",
    client: "Discord app",
    spotify: "Spotify",
    data: "Read things",
    ai: "AI",
    waits: "Wait",
    interactions: "Buttons and menus",
    flow: "Logic",
    variables: "Values",
    computer: "This computer",
    roblox: "Roblox",
    codex: "Codex",
};

export const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
    schedule: "On a schedule",
    mention: "When someone mentions me",
    message: "When a message is posted",
    dm: "When I get a DM",
    startup: "When LawyerCord starts",
    "message-edit": "When a message is edited",
    "message-delete": "When a message is deleted",
    "reaction-add": "When a reaction is added",
    "reaction-remove": "When a reaction is removed",
    "voice-join": "When someone joins a voice channel",
    "voice-leave": "When someone leaves a voice channel",
    "voice-move": "When someone switches voice channel",
    "roblox-join": "When I join a Roblox game",
    "roblox-leave": "When I leave a Roblox game",
    "process-start": "When a program starts on this computer",
    "process-exit": "When a program closes on this computer",
    "codex-start": "When Codex starts working",
    "codex-finish": "When Codex finishes",
    "codex-question": "When Codex asks me a question",
};

/** The one-line answer to "when does this run?", for cards and titles. */
export function describeTrigger(automation: Automation): string {
    if (automation.trigger.type === "schedule") return formatSchedule(automation.schedule);
    return TRIGGER_LABELS[automation.trigger.type];
}

export function blockDefinition(type: AutomationBlockType) {
    return BLOCK_DEFINITIONS.find(item => item.type === type) ?? BLOCK_DEFINITIONS[0];
}

/** Everything the palette offers. Legacy structural markers are graph edges now. */
export function paletteBlocks() {
    return BLOCK_DEFINITIONS.filter(block => block.available !== false && !MARKER_TYPES.includes(block.type));
}
