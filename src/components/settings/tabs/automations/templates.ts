/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Automation, createAutomation, createAutomationBlock } from "./model";

export const TEMPLATE_NAMES = ["Reminder", "Filter mentions", "Roblox game log", "Codex finished", "Process a list", "Spotify controls"] as const;
export type TemplateName = typeof TEMPLATE_NAMES[number];

export const TEMPLATE_DESCRIPTIONS: Record<TemplateName, string> = {
    Reminder: "Pops up a notification every hour. Change the text and the timing.",
    "Filter mentions": "Watches for mentions and only tells you about the ones that say help.",
    "Roblox game log": "Posts the game, player count and link whenever you join a Roblox game.",
    "Codex finished": "Pops up Codex's closing message the moment a turn finishes.",
    "Process a list": "Goes through a list one item at a time. A starting point for loops.",
    "Spotify controls": "Turns shuffle on and presses play.",
};

export function createTemplate(name: TemplateName): Automation {
    const automation = { ...createAutomation(), name };
    if (name === "Reminder") {
        const notify = createAutomationBlock("notify");
        notify.config = { name: "Reminder", content: "Time for a break.", sample: {} };
        automation.blocks = [notify];
    } else if (name === "Filter mentions") {
        automation.trigger = { type: "mention" };
        const condition = createAutomationBlock("condition");
        condition.config = { sourceVariable: "triggerMessage.content", operator: "contains", compareValue: "help" };
        const notify = createAutomationBlock("notify");
        notify.config = { name: "Someone needs help", content: "{{triggerMessage.content}}", sample: {} };
        condition.next = notify.id;
        automation.blocks = [condition, notify];
    } else if (name === "Roblox game log") {
        automation.trigger = { type: "roblox-join" };
        const post = createAutomationBlock("send-message");
        post.config = { ...post.config, content: "Joined **{{game.name}}** by {{game.creator}}, {{game.playing}} playing right now.\n{{game.url}}", sample: {} };
        automation.blocks = [post];
    } else if (name === "Codex finished") {
        automation.trigger = { type: "codex-finish" };
        const notify = createAutomationBlock("notify");
        notify.config = { name: "Codex finished in {{codex.project}}", content: "{{codex.message}}", sample: {} };
        automation.blocks = [notify];
    } else if (name === "Process a list") {
        const each = createAutomationBlock("for-each");
        each.config = { input: { kind: "literal", value: ["First", "Second", "Third"] }, variable: "item" };
        const log = createAutomationBlock("log");
        log.config.content = "{{item}}";
        each.next = log.id; log.next = each.id;
        automation.blocks = [each, log];
    } else {
        const shuffle = createAutomationBlock("spotify-shuffle");
        shuffle.config.sample = {};
        const play = createAutomationBlock("spotify-play");
        play.config.sample = {};
        shuffle.next = play.id;
        automation.blocks = [shuffle, play];
    }
    automation.entryId = automation.blocks[0].id;
    return automation;
}
