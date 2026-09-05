/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";

if (!process.argv.includes("--confirm-local-test")) throw new Error("Pass --confirm-local-test to test the data-only list template in Discord.");
const output = "dist/automation-review";
await mkdir(output, { recursive: true });
const browser = await puppeteer.connect({ browserURL: process.env.DISCORD_DEBUG_URL || "http://127.0.0.1:9222" });
const page = (await browser.pages()).find(page => page.url().startsWith("https://discord.com/"));
if (!page) throw new Error("The Discord page is unavailable.");
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const testName = `Automation review ${Date.now()}`;
const click = async text => page.evaluate(text => {
    const root = document.querySelector("[data-automation-review]") ?? document;
    const button = [...root.querySelectorAll("button")].find(button => button.getBoundingClientRect().width && button.textContent.trim() === text);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${text}`);
    button.click();
}, text);
const count = () => page.$$eval("[data-automation-review] .vc-ab-node", nodes => nodes.length);
try {
    await page.waitForFunction(() => window.Vencord?.Webpack?.Common?.SettingsRouter);
    await page.evaluate(() => Vencord.Webpack.Common.SettingsRouter.openUserSettings("equicord_automations"));
    await page.waitForSelector(".vc-automations-template");
    await click("Process a list");
    await page.waitForSelector(".vc-ab-workspace");
    await page.evaluate(() => [...document.querySelectorAll(".vc-ab-workspace")].at(-1).closest("[data-mana-component=modal]").setAttribute("data-automation-review", "true"));
    await click("Fit");
    await click("List");
    await page.waitForSelector(".vc-ab-step");
    assert.ok(await page.$$eval(".vc-ab-step", nodes => nodes.some(node => node.textContent.includes("Link to existing step"))));
    await click("Canvas");
    await page.waitForSelector(".vc-ab-node");
    const before = await count();
    const node = await page.$("[data-automation-review] .vc-ab-node");
    await node.focus();
    await page.keyboard.press("Enter");
    await click("Duplicate");
    await page.waitForFunction(before => document.querySelectorAll("[data-automation-review] .vc-ab-node").length === before + 1, {}, before);
    await click("Undo");
    await page.waitForFunction(before => document.querySelectorAll("[data-automation-review] .vc-ab-node").length === before, {}, before);
    await click("Redo");
    await page.waitForFunction(before => document.querySelectorAll("[data-automation-review] .vc-ab-node").length === before + 1, {}, before);
    await click("Undo");
    await click("Test with sample data");
    await page.waitForFunction(() => document.body.textContent.includes("Test finished."));
    await click("List");
    const workspace = await page.$("[data-automation-review] .vc-ab-workspace");
    await workspace.screenshot({ path: `${output}/discord-steps.png` });
    await click("Canvas");
    await click("Fit");
    await workspace.screenshot({ path: `${output}/discord-graph.png` });
    const themeChanged = await page.evaluate(() => {
        const workspace = document.querySelector("[data-automation-review] .vc-ab-workspace");
        const before = getComputedStyle(workspace).getPropertyValue("--background-base-low") || getComputedStyle(workspace).getPropertyValue("--background-primary");
        window.automationReviewThemes = [...document.querySelectorAll(".theme-dark")];
        for (const element of window.automationReviewThemes) element.classList.replace("theme-dark", "theme-light");
        const after = getComputedStyle(workspace).getPropertyValue("--background-base-low") || getComputedStyle(workspace).getPropertyValue("--background-primary");
        return Boolean(before && after && before !== after);
    });
    assert.equal(themeChanged, true);
    await workspace.screenshot({ path: `${output}/discord-light-theme.png` });
    await page.evaluate(() => { for (const element of window.automationReviewThemes) element.classList.replace("theme-light", "theme-dark"); window.automationReviewThemes = []; });
    await page.setViewport({ width: 720, height: 900 });
    await workspace.screenshot({ path: `${output}/discord-small-window.png` });
    await page.setViewport({ width: 1440, height: 1000 });
    const canvas = await page.$("[data-automation-review] .vc-ab-canvas");
    await canvas.click({ offset: { x: 10, y: 10 } });
    await page.waitForSelector('[data-automation-review] input[value="Process a list"]');
    const nameInput = await page.$('[data-automation-review] input[value="Process a list"]');
    await nameInput.focus();
    await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
    await nameInput.type(testName);
    assert.equal(await nameInput.evaluate(el => el.value), testName);
    console.log("Local fixture named.");
    await click("Save");
    console.log("Save requested.");
    await page.waitForFunction(async name => (await Vencord.Api.DataStore.get("LawyerCord_automations_v2"))?.automations.some(a => a.name === name), {}, testName);
    const safe = await page.evaluate(async name => {
        const a = (await Vencord.Api.DataStore.get("LawyerCord_automations_v2")).automations.find(a => a.name === name);
        return !a.enabled && a.blocks.every(b => ["for-each", "log"].includes(b.type));
    }, testName);
    assert.equal(safe, true, "Live run is restricted to a disabled data-only workflow.");
    await click("Run for real");
    await page.waitForFunction(async name => (await Vencord.Api.DataStore.get("LawyerCord_automations_v2")).automations.find(a => a.name === name)?.lastStatus === "success", {}, testName);
    await nameInput.focus();
    await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
    await nameInput.type(testName + " draft");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-automation-review]"));
    await page.evaluate(name => {
        const card = [...document.querySelectorAll(".vc-automations-card")].find(card => card.querySelector("strong")?.textContent === name);
        [...card.querySelectorAll("button")].find(button => button.textContent === "Edit").click();
    }, testName);
    await page.waitForFunction(name => [...document.querySelectorAll(".vc-ab-title")].some(el => el.textContent.includes(name + " draft")), {}, testName);
    assert.equal(await page.evaluate(async name => (await Vencord.Api.DataStore.get("LawyerCord_automations_v2")).automations.some(a => a.name === name), testName), true);
    await page.keyboard.press("Escape");
    await page.waitForSelector(`[aria-label="Delete ${testName}"]`);
    await page.click(`[aria-label="Delete ${testName}"]`);
    await click("Delete");
    await page.waitForFunction(async name => !(await Vencord.Api.DataStore.get("LawyerCord_automations_v2")).automations.some(a => a.name === name), {}, testName);
    assert.deepEqual(errors, []);
    await writeFile(`${output}/discord-checks.json`, JSON.stringify({ graph: true, steps: true, loopLinks: true, keyboardSelection: true, duplicateUndoRedo: true, dryRun: true, dataOnlyRun: true, draftRecovery: true, explicitSave: true, smallWindow: true, lightThemeVariables: true, testWorkflowRemoved: true, liveMessagesSent: 0, errors }, null, 2));
    console.log("Discord graph, steps, keyboard selection, undo/redo, and dry-run checks passed.");
} catch (error) {
    console.error(await page.evaluate(() => document.body.innerText.split("\n").filter(line => /could not|malformed|invalid|saved\./i.test(line)).slice(-8)));
    throw error;
} finally {
    await page.evaluate(() => { for (const element of window.automationReviewThemes ?? []) element.classList.replace("theme-light", "theme-dark"); delete window.automationReviewThemes; });
    await page.setViewport(null); browser.disconnect();
}
