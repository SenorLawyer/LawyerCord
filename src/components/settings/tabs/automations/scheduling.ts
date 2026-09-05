/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CronExpressionParser } from "cron-parser";

import { type Automation, getNextRunAt, type Schedule } from "./model";

export function scheduleExpression(schedule: Schedule): string {
    if (schedule.mode === "cron") {
        const expression = schedule.cron?.trim() ?? "";
        if (expression.split(/\s+/).length !== 5 || /[H?@]/.test(expression)) throw new Error("Enter a five-field cron expression without random fields.");
        return expression;
    }
    const time = schedule.time ?? "09:00";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Enter a time in HH:mm format.");
    const [hour, minute] = time.split(":").map(Number);
    const days = schedule.weekdays ?? [1, 2, 3, 4, 5];
    if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Choose at least one weekday.");
    return `${minute} ${hour} * * ${days.join(",")}`;
}

export function validateSchedule(schedule: Schedule): string | undefined {
    try {
        if (schedule.timezone) new Intl.DateTimeFormat("en", { timeZone: schedule.timezone });
        if (!Number.isFinite(schedule.startAt)) throw new Error("Choose a valid start date.");
        for (const value of [schedule.activeStart, schedule.activeEnd]) if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Active hours use HH:mm times.");
        if (Boolean(schedule.activeStart) !== Boolean(schedule.activeEnd)) throw new Error("Set both active hours or leave both blank.");
        if (schedule.mode === "cron" || schedule.mode === "calendar") CronExpressionParser.parse(scheduleExpression(schedule), { tz: schedule.timezone });
        else if (!Number.isFinite(schedule.interval) || schedule.interval <= 0) throw new Error("The schedule interval must be positive.");
    } catch (error) { return error instanceof Error ? error.message : "The schedule is invalid."; }
    return undefined;
}

export function inActiveHours(schedule: Schedule, timestamp: number): boolean {
    if (!schedule.activeStart || !schedule.activeEnd || schedule.activeStart === schedule.activeEnd) return true;
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(timestamp);
    return schedule.activeStart < schedule.activeEnd
        ? time >= schedule.activeStart && time < schedule.activeEnd
        : time >= schedule.activeStart || time < schedule.activeEnd;
}

export function nextOccurrence(automation: Automation, after: number): number {
    const { schedule } = automation;
    const error = validateSchedule(schedule);
    if (error) throw new Error(error);
    const expression = schedule.mode === "calendar" || schedule.mode === "cron"
        ? CronExpressionParser.parse(scheduleExpression(schedule), { currentDate: Math.max(after, schedule.startAt - 1), tz: schedule.timezone })
        : undefined;
    let cursor = after;
    for (let attempt = 0; attempt < 10_000; attempt++) {
        const next = expression ? expression.next().getTime()
            : schedule.startAt > cursor ? schedule.startAt : getNextRunAt(schedule, cursor);
        if (inActiveHours(schedule, next)) return next;
        cursor = next;
    }
    throw new Error("No occurrence falls within the active hours. Adjust the schedule.");
}

export function schedulePreview(automation: Automation, now = Date.now()): number[] {
    const values: number[] = [];
    let cursor = now;
    for (let index = 0; index < 5; index++) {
        cursor = nextOccurrence(automation, cursor);
        values.push(cursor);
    }
    return values;
}
