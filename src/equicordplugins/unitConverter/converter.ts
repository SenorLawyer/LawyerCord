/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from ".";

const regexes: Record<"imperial" | "metric", Record<string, {
    regex: RegExp;
    convert: (...groups: string[]) => string;
}>> = {
    // matches imperial units, converts them to metric
    imperial: {
        fahrenheit: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(-?\d+(?:\.\d+)?)°?(f)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                const c = ((parseFloat(groups[1]) - 32) * (5 / 9)).toFixed(2);
                return `${c}°C`;
            },
        },
        feetInchesMark: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+)(') ?(\d+(?:\.\d+)?)("|'')?(?![\p{L}\p{N}\p{M}_])/gu,
            convert(...groups) {
                let ftin = parseFloat(groups[1]) * 0.3048;
                ftin += parseFloat(groups[3]) * 0.0254;
                return `${ftin.toFixed(2)}m`;
            },
        },
        feetInchesWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+) *(f(?:ee|oo)?t) *(\d+(?:\.\d+)?) *(in(?:ches?)?)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                let ftin = parseFloat(groups[1]) * 0.3048;
                ftin += parseFloat(groups[3]) * 0.0254;
                return `${ftin.toFixed(2)}m`;
            },
        },
        feetWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) *(f(ee)?t)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                const ft = (parseFloat(groups[1]) * 0.3048).toFixed(2);
                return `${ft}m`;
            },
        },
        inchesWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) *(in(?:ches?)?)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                const inches = (parseFloat(groups[1]) * 2.54).toFixed(2);
                return `${inches}cm`;
            },
        },
        poundOunceWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) *(lbs?|pounds?) *(\d+(?:\.\d+)?) *(ozs?|ounces?)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                let lbs = parseFloat(groups[1]) * 0.45359237;
                lbs += parseFloat(groups[3]) * 0.028349523125;
                return `${lbs.toFixed(2)}kg`;
            }
        },
        poundWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) *(lbs?|pounds?)(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups: string[]) {
                const lbs = (parseFloat(groups[1]) * 0.45359237).toFixed(2);
                return `${lbs}kg`;
            },
        },
        ounceWord: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(ounces?|oz)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const ozs = (parseFloat(groups[1]) * 28.349523125).toFixed(2);
                return `${ozs}g`;
            },
        },
        milesPerHour: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(m(?:p|\/)h)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const mph = (parseFloat(groups[1]) * 1.609344).toFixed(2);
                return `${mph}km/h`;
            },
        }
    },
    // matches metric untis, converts them into imperial
    metric: {
        // i dont think people ever write metric units as 1m3cm or something like that
        celsius: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(-?\d+(?:\.\d+)?)\s?°?c(?![\p{L}\p{N}\p{M}_])/igu,
            convert(...groups) {
                const f = ((parseFloat(groups[1]) * (9 / 5)) + 32).toFixed(2);
                return `${f}°F`;
            }
        },
        // convert to inches
        centimeters: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(cm|centimeters?)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const cm = (parseFloat(groups[1]) / 2.54).toFixed(2);
                return `${cm}in`;
            },
        },
        // convert to feet
        meters: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(m|meters?)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const totalInches = Math.round(parseFloat(groups[1]) / 0.0254 * 100) / 100;
                const feet = Math.floor(totalInches / 12);
                const inches = totalInches % 12;
                if (feet === 0) return `${inches.toFixed(2)}in`;
                if (inches < 0.005) return `${feet}ft`;
                return `${feet}ft ${inches.toFixed(2)}in`;
            },
        },
        kilometersPerHour: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(km\/h|kmph|kph|kilometers?\/?h)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const kph = (parseFloat(groups[1]) / 1.609344).toFixed(2);
                return `${kph}mph`;
            },
        },
        // convert to miles
        kilometers: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(km|kilometers?|kms?)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const m = (parseFloat(groups[1]) / 1.609344).toFixed(2);
                return `${m}mi`;
            },
        },
        grams: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(grams?|g)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const g = (parseFloat(groups[1]) / 28.349523125).toFixed(2);
                return `${g}oz`;
            },
        },
        kilograms: {
            regex: /(?<![\p{L}\p{N}\p{M}_.])(\d+(?:\.\d+)?) ?(kg|kilo(?:gram)?s?)(?![\p{L}\p{N}\p{M}_])/giu,
            convert(...groups) {
                const kg = (parseFloat(groups[1]) / 0.45359237).toFixed(2);
                return `${kg}lb`;
            },
        },
    }

};
export function convert(message: string): string {
    let newMessage = message;
    const units = settings.store.myUnits === "imperial" ? regexes.metric : regexes.imperial;
    for (const unit of Object.values(units))
        newMessage = newMessage.replaceAll(unit.regex, unit.convert);
    return newMessage;
}
