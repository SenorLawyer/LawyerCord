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
            regex: /(-?\d+(?:\.\d+)?)°?(f)(?!\w)/ig,
            convert(...groups) {
                const c = ((parseFloat(groups[1]) - 32) * (5 / 9)).toFixed(2);
                return `${c}°C`;
            },
        },
        feetInchesMark: {
            regex: /(\d+)(') ?(\d+(?:\.\d+)?)("|'')?/g,
            convert(...groups) {
                let ftin = parseFloat(groups[1]) / 3.281;
                ftin += parseFloat(groups[3]) / 39.37;
                return `${ftin.toFixed(2)}m`;
            },
        },
        feetInchesWord: {
            regex: /(\d+) *(f(?:ee|oo)?t) *(\d+(?:\.\d+)?) *(in(?:ches?)?)/ig,
            convert(...groups) {
                let ftin = parseFloat(groups[1]) / 3.281;
                ftin += parseFloat(groups[3]) / 39.37;
                return `${ftin.toFixed(2)}m`;
            },
        },
        feetWord: {
            regex: /(\d+(?:\.\d+)?) *(f(ee)?t)(?! *\d)/ig,
            convert(...groups) {
                const ft = (parseFloat(groups[1]) / 3.281).toFixed(2);
                return `${ft}m`;
            },
        },
        inchesWord: {
            regex: /(?<!\d+ *(?:f(?:ee|oo)?t) *)(\d+(?:\.\d+)?) *(in(?:ches?)?)/ig,
            convert(...groups) {
                const inches = (parseFloat(groups[1]) * 2.54).toFixed(2);
                return `${inches}cm`;
            },
        },
        poundOunceWord: {
            regex: /(\d+(?:\.\d+)?) *(lbs?|pounds?) *(\d+(?:\.\d+)?) *(ozs?|ounces?)/ig,
            convert(...groups) {
                let lbs = parseFloat(groups[1]) / 2.205;
                lbs += parseFloat(groups[3]) / 35.274;
                return `${lbs.toFixed(2)}kg`;
            }
        },
        poundWord: {
            regex: /(\d+(?:\.\d+)?) *(lbs?|pounds?)(?! ?\d)/ig,
            convert(...groups: string[]) {
                const lbs = (parseFloat(groups[1]) / 2.205).toFixed(2);
                return `${lbs}kg`;
            },
        },
        ounceWord: {
            regex: /(\d+(?:\.\d+)?) ?(ounces?|oz)(?!\w)/gi,
            convert(...groups) {
                const ozs = (parseFloat(groups[1]) * 28.35).toFixed(2);
                return `${ozs}g`;
            },
        },
        milesPerHour: {
            regex: /(\d+(?:\.\d+)?) ?(m(?:p|\/)h)/gi,
            convert(...groups) {
                const mph = (parseFloat(groups[1]) * 1.609).toFixed(2);
                return `${mph}km/h`;
            },
        }
    },
    // matches metric untis, converts them into imperial
    metric: {
        // i dont think people ever write metric units as 1m3cm or something like that
        celsius: {
            regex: /(-?\d+(?:\.\d+)?)\s?°?c(?!\w)/ig,
            convert(...groups) {
                const f = ((parseFloat(groups[1]) * (9 / 5)) + 32).toFixed(2);
                return `${f}°F`;
            }
        },
        // convert to inches
        centimeters: {
            regex: /(\d+(?:\.\d+)?) ?(cm|centimeters?)(?!\w)/gi,
            convert(...groups) {
                const cm = (parseFloat(groups[1]) / 2.54).toFixed(2);
                return `${cm}in`;
            },
        },
        // convert to feet
        meters: {
            regex: /(\d+(?:\.\d+)?) ?(m|meters?)(?!\w)/gi,
            convert(...groups) {
                const totalInches = Math.round(parseFloat(groups[1]) * 39.3701 * 100) / 100;
                const feet = Math.floor(totalInches / 12);
                const inches = totalInches % 12;
                if (feet === 0) return `${inches.toFixed(2)}in`;
                if (inches < 0.005) return `${feet}ft`;
                return `${feet}ft ${inches.toFixed(2)}in`;
            },
        },
        kilometersPerHour: {
            regex: /(\d+(?:\.\d+)?) ?(km\/h|kmph|kph|kilometers?\/?h)/gi,
            convert(...groups) {
                const kph = (parseFloat(groups[1]) / 1.609).toFixed(2);
                return `${kph}mph`;
            },
        },
        // convert to miles
        kilometers: {
            regex: /(\d+(?:\.\d+)?) ?(km|kilometers?|kms?)(?!\w)/gi,
            convert(...groups) {
                const m = (parseFloat(groups[1]) / 1.609).toFixed(2);
                return `${m}mi`;
            },
        },
        grams: {
            regex: /(\d+(?:\.\d+)?) ?(grams?|g)(?!\w)/gi,
            convert(...groups) {
                const g = (parseFloat(groups[1]) / 28.35).toFixed(2);
                return `${g}oz`;
            },
        },
        kilograms: {
            regex: /(\d+(?:\.\d+)?) ?(kg|kilo(?:gram)?s?)(?!\w)/gi,
            convert(...groups) {
                const kg = (parseFloat(groups[1]) * 2.205).toFixed(2);
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
