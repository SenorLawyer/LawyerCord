/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const sourcePath = "src/equicordplugins/timezones/index.tsx";
const root = fileURLToPath(new URL("../", import.meta.url));
const currentSource = readFileSync(new URL(`../${sourcePath}`, import.meta.url), "utf8");
const checkOnly = process.argv.includes("--check");
const baseline = process.argv.find(argument => argument.startsWith("--baseline="))?.slice("--baseline=".length);

interface Element {
    props: Record<string, unknown>;
    children: unknown[];
}

interface Fixture {
    locale: string | null;
    systemTimezone: string;
    timezone: string;
    twentyFourHourFormat: boolean;
    showTimezoneInfo: boolean;
    showLocalTimezone: boolean;
}

interface Exports {
    TimestampComponent: (props: { userId: string; timestamp: string; type: "message"; }) => Element;
    getSystemTimezone: () => string;
    default: { getTime: (timezone: string, timestamp: string, options: Intl.DateTimeFormatOptions) => string; };
}

function load(source: string) {
    const fixture: Fixture = {
        locale: "en-US", systemTimezone: "UTC", timezone: "America/New_York",
        twentyFourHourFormat: false, showTimezoneInfo: true, showLocalTimezone: false,
    };
    let constructions = 0;
    let cursor = 0;
    const createElement = (_type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ props: props ?? {}, children });
    const createFormatter = (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) => {
        constructions++;
        return new Intl.DateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? fixture.systemTimezone });
    };
    const dateTimeFormat = new Proxy(Intl.DateTimeFormat, {
        apply: (_target, _this, args) => createFormatter(args[0], args[1]),
        construct: (_target, args) => createFormatter(args[0], args[1]),
    });
    const mocks: Record<string, object> = {
        "./styles.css": {},
        "@api/DataStore": {},
        "@api/Settings": { definePluginSettings: () => ({ store: fixture }), migratePluginSetting: () => undefined },
        "@components/ErrorBoundary": { default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({ getLocale: () => fixture.locale }) },
        "@webpack/common": {
            useEffect: () => undefined,
            useState: (initial: unknown) => [cursor++ === 0 ? initial : fixture.timezone, () => undefined],
        },
        "./database": {},
        "./TimezoneModal": {},
    };
    const { outputText } = transpileModule(`${source}\nexport { TimestampComponent };`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React },
        fileName: sourcePath,
    });
    const module = { exports: {} as Exports };
    runInNewContext(outputText, {
        module, exports: module.exports, React: { createElement }, Intl: { DateTimeFormat: dateTimeFormat }, Date,
        require(name: string) {
            const mock = mocks[name];
            assert.ok(mock, `Unexpected import: ${name}`);
            return { __esModule: true, ...mock };
        },
    }, { filename: sourcePath });

    return {
        fixture,
        get constructions() { return constructions; },
        getSystemTimezone: module.exports.getSystemTimezone,
        getTime: module.exports.default.getTime,
        render(timestamp: string, timezone: string) {
            cursor = 0;
            fixture.timezone = timezone;
            const view = module.exports.TimestampComponent({ userId: "fixture-user", timestamp, type: "message" });
            const child = (view.children[0] as (props: object) => Element)({});
            return { text: child.children[0], tooltip: view.props.text };
        },
    };
}

type Runtime = ReturnType<typeof load>;
const zones = ["America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney", "Asia/Kolkata"];
const timestamps = ["2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:01:00Z"];

function reference(fixture: Fixture, timestamp: string, timezone: string) {
    const date = new Date(timestamp);
    const locale = fixture.locale ?? "en-US";
    const base = { timeZone: timezone, hour12: !fixture.twentyFourHourFormat };
    const shortTime = new Intl.DateTimeFormat(locale, { ...base, hour: "numeric", minute: "numeric" }).format(date);
    const local = fixture.showTimezoneInfo && timezone === fixture.systemTimezone && !fixture.showLocalTimezone;
    let display = shortTime;
    if (fixture.showTimezoneInfo) {
        const abbreviation = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: "short" })
            .formatToParts(date).find(part => part.type === "timeZoneName")?.value;
        display = local ? "local" : `${shortTime} ${abbreviation || timezone}`;
    }
    const longTime = new Intl.DateTimeFormat(locale, {
        ...base, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric",
    }).format(date);
    return { text: `(${display})`, tooltip: local ? `${longTime} (Your local timezone)` : longTime };
}

function check() {
    const runtime = load(currentSource);
    for (const locale of ["en-US", "de-DE", null]) {
        for (const twentyFourHourFormat of [false, true]) {
            Object.assign(runtime.fixture, { locale, twentyFourHourFormat });
            for (const timestamp of timestamps) {
                for (const timezone of [...zones, "UTC"]) {
                    assert.deepEqual(runtime.render(timestamp, timezone), reference(runtime.fixture, timestamp, timezone));
                }
            }
        }
    }
    for (const showTimezoneInfo of [false, true]) {
        for (const showLocalTimezone of [false, true]) {
            Object.assign(runtime.fixture, { showTimezoneInfo, showLocalTimezone });
            assert.deepEqual(runtime.render(timestamps[0], "UTC"), reference(runtime.fixture, timestamps[0], "UTC"));
        }
    }
    Object.assign(runtime.fixture, { systemTimezone: "Asia/Tokyo", showTimezoneInfo: true, showLocalTimezone: false });
    assert.equal(runtime.getSystemTimezone(), "Asia/Tokyo");
    assert.deepEqual(runtime.render(timestamps[0], "Asia/Tokyo"), reference(runtime.fixture, timestamps[0], "Asia/Tokyo"));
    const systemOptions: Intl.DateTimeFormatOptions = { timeZone: undefined, hour: "numeric", hour12: false };
    const systemTime = runtime.getTime("UTC", timestamps[0], systemOptions);
    assert.equal(systemTime, new Intl.DateTimeFormat("en-US", { ...systemOptions, timeZone: "Asia/Tokyo" }).format(new Date(timestamps[0])));
    runtime.fixture.systemTimezone = "UTC";
    assert.equal(runtime.getSystemTimezone(), "UTC", "System timezone changes remain visible without a restart");
    const changedSystemTime = runtime.getTime("UTC", timestamps[0], systemOptions);
    assert.notEqual(changedSystemTime, systemTime);
    assert.equal(changedSystemTime, new Intl.DateTimeFormat("en-US", { ...systemOptions, timeZone: "UTC" }).format(new Date(timestamps[0])));
    assert.throws(() => runtime.getTime("Invalid/Timezone", timestamps[0], {}), RangeError);
    const customOptions: Intl.DateTimeFormatOptions = { hour: "2-digit", second: "2-digit", hour12: true, timeZone: "Pacific/Honolulu" };
    assert.equal(runtime.getTime("UTC", timestamps[0], customOptions),
        new Intl.DateTimeFormat("en-US", customOptions).format(new Date(timestamps[0])));

    const repeated = load(currentSource);
    batch(repeated);
    const firstBatchConstructions = repeated.constructions;
    batch(repeated);
    const repeatedConstructions = repeated.constructions - firstBatchConstructions;
    console.log(JSON.stringify({ firstBatchConstructions, repeatedConstructions, messagesPerBatch: 100 }));
    assert.equal(firstBatchConstructions, 115, "Five zones reuse three explicit formatters; the 100 system probes remain fresh");
    assert.equal(repeatedConstructions, 100, "Repeated messages reuse explicit timezone formatters");
    for (const timezone of Intl.supportedValuesOf("timeZone").filter(timezone => !zones.includes(timezone)).slice(0, 160)) {
        assert.deepEqual(repeated.render(timestamps[0], timezone), reference(repeated.fixture, timestamps[0], timezone));
    }
    const previous = repeated.constructions;
    repeated.render(timestamps[0], zones[0]);
    assert.ok(repeated.constructions - previous > 1, "Old formatters are evicted instead of retaining every timezone");
    console.log("Timezones formatter correctness checks passed.");
}

function batch(runtime: Runtime) {
    let outputLength = 0;
    for (let index = 0; index < 100; index++) {
        const view = runtime.render(timestamps[index % timestamps.length], zones[index % zones.length]);
        outputLength += String(view.text).length + String(view.tooltip).length;
    }
    return outputLength;
}

function timed(runtime: Runtime) {
    const start = performance.now();
    const outputLength = batch(runtime);
    return { ms: performance.now() - start, outputLength };
}

function summarize(samples: number[]) {
    samples.sort((left, right) => left - right);
    return { medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] };
}

if (checkOnly) {
    check();
} else {
    const runtimes: [string, Runtime][] = [];
    if (baseline) runtimes.push([baseline, load(execFileSync("git", ["show", `${baseline}:${sourcePath}`], { cwd: root, encoding: "utf8" }))]);
    runtimes.push(["working-tree", load(currentSource)]);
    for (const timestamp of timestamps) {
        for (const timezone of zones) {
            for (const [, runtime] of runtimes) assert.deepEqual(runtime.render(timestamp, timezone), reference(runtime.fixture, timestamp, timezone));
        }
    }
    const cold = runtimes.map(([revision]) => {
        const source = revision === "working-tree" ? currentSource : execFileSync("git", ["show", `${revision}:${sourcePath}`], { cwd: root, encoding: "utf8" });
        const runtime = load(source);
        const result = timed(runtime);
        return { revision, ms: result.ms, constructions: runtime.constructions };
    });
    const expectedLength = batch(runtimes[0][1]);
    for (const [, runtime] of runtimes) assert.equal(batch(runtime), expectedLength);
    for (let warmup = 0; warmup < 5; warmup++) for (const [, runtime] of runtimes) batch(runtime);
    const samples = runtimes.map(() => [] as number[]);
    const startConstructions = runtimes.map(([, runtime]) => runtime.constructions);
    for (let sample = 0; sample < 31; sample++) {
        const order = Array.from(runtimes.keys());
        if (sample % 2 !== 0) order.reverse();
        for (const index of order) {
            const result = timed(runtimes[index][1]);
            assert.equal(result.outputLength, expectedLength);
            samples[index].push(result.ms);
        }
    }
    console.log(JSON.stringify({
        node: process.version, platform: `${process.platform} ${process.arch}`, workload: "100 message timestamp renders across five timezones; mocked React, no DOM or network",
        cold,
        steady: runtimes.map(([revision, runtime], index) => ({
            revision, ...summarize(samples[index]), samples: samples[index].length,
            constructionsPerBatch: (runtime.constructions - startConstructions[index]) / samples[index].length,
        })),
    }, null, 2));
}
