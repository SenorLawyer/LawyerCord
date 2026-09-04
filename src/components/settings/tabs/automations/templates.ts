/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Automation, createAutomation, createAutomationBlock } from "./model";

export const TEMPLATE_NAMES = ["Reminder", "Filter mentions", "Process a list", "Spotify controls"] as const;

export function createTemplate(name: typeof TEMPLATE_NAMES[number]): Automation {
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
