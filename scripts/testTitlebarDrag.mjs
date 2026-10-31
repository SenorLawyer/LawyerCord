/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import puppeteer from "puppeteer-core";

test("the fallback leaves collapsed bars interactive and returns when expanded", async () => {
    const source = readFileSync("src/Vencord.ts", "utf8");
    const match = source.match(/vencord-window-drag-region", coreStyleRootNode\)\.textContent = "([^"]+)"/);
    assert.ok(match);
    const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1000, height: 600 });
        await page.setContent(`<style>${match[1]} body { margin: 0; } header { height: 8px; } header:hover { height: 46px; }</style><header data-vc-collapsible-ui-header-bar></header><button id="control">Control</button>`);
        const content = () => page.evaluate(() => getComputedStyle(document.body, "::after").content);
        assert.equal(await content(), '""');
        for (const attribute of ["data-vc-collapsible-ui-header-bar-collapsed", "data-vc-collapsible-ui-title-bar-collapsed"]) {
            await page.$eval("header", (element, name) => element.setAttribute(name, ""), attribute);
            assert.equal(await content(), "none");
            await page.mouse.move(200, 4);
            assert.equal(await page.$eval("header", element => element.getBoundingClientRect().height), 46);
            await page.$eval("header", (element, name) => element.removeAttribute(name), attribute);
            assert.equal(await content(), '""');
        }
    } finally {
        await browser.close();
    }
});
