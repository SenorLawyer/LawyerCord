/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const root = process.cwd();
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice(11);
const benchmark = process.argv.includes("--benchmark");
const baselineFiles = new Map();
if (baseline) for (const name of execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, "src/components/settings/tabs/automations"], { encoding: "utf8" }).trim().split("\n")) baselineFiles.set(resolve(name), execFileSync("git", ["show", `${baseline}:${name}`], { encoding: "utf8" }));
const runtime = process.env.LAWYERCORD_PREVIEW_RUNTIME || join(tmpdir(), "lawyercord-automation-preview");
const requireRuntime = createRequire(join(runtime, "package.json"));
const react = requireRuntime.resolve("react");
const reactDom = requireRuntime.resolve("react-dom/client");
const directory = resolve("src/components/settings/tabs/automations");
const source = (await Promise.all((await readdir(directory)).filter(name => /\.tsx?$/.test(name)).map(name => readFile(join(directory, name), "utf8")))).join("\n");
const names = new Set();
for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*["']@[^"']+["']/g)) {
    for (const name of match[1].split(",").map(value => value.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])) if (/^\w+$/.test(name)) names.add(name);
}

const common = `
import * as React from ${JSON.stringify(react)};
import { createRoot } from ${JSON.stringify(reactDom)};
export { React };
const h=React.createElement;
const store=new Proxy({theme:"dark",getCurrentUser:()=>({id:"100000000000000001",username:"Preview"}),getGuilds:()=>({}),getGuild:()=>undefined,getChannels:()=>({}),getMutableGuildChannelsForGuild:()=>({}),getSortedPrivateChannels:()=>[],getRelationships:()=>({}),getMembers:()=>[],getUser:()=>undefined,getChannel:()=>undefined,getNick:()=>null,subscribe:()=>{},unsubscribe:()=>{},dispatch:()=>{}},{get:(target,key)=>key in target?target[key]:()=>[]});
const Button=({children,onClick,disabled,...props})=>h("button",{onClick,disabled,"aria-label":props["aria-label"],className:"preview-button "+(props.className||"")},children);
const TextInput=({onChange,...props})=>h("input",{...props,onChange:e=>onChange?.(e.target.value)});
const TextArea=({onChange,...props})=>h("textarea",{...props,onChange:e=>onChange?.(e.target.value)});
const Checkbox=({value,onChange})=>h("input",{type:"checkbox",checked:value,onChange:e=>onChange(e,e.target.checked)});
const Select=({options=[],select,isSelected})=>h("select",{value:options.find(o=>isSelected?.(o.value))?.value??"",onChange:e=>select(e.target.value)},options.map(o=>h("option",{key:o.value,value:o.value},o.label)));
const SearchableSelect=({options=[],value,onChange,placeholder})=>h("select",{value:value??"",onChange:e=>onChange(e.target.value)},h("option",{value:""},placeholder),options.map(o=>h("option",{key:o.value,value:o.value},o.label)));
const Heading=({tag="h2",children})=>h(tag,null,children);
const Icon=()=>h("svg",{width:16,height:16,viewBox:"0 0 16 16"},h("circle",{cx:8,cy:8,r:5,fill:"currentColor"}));
const Modal=({title,subtitle,actions,children,onClose})=>h("div",{className:"preview-modal"},h("header",null,h("div",null,title),h(Button,{onClick:onClose},"Close")),subtitle,children,h("footer",null,...actions.map(a=>h(Button,{key:a.text,onClick:a.onClick,disabled:a.disabled},a.text))));
let modalRoot;
const openModal=render=>{modalRoot??=createRoot(document.getElementById("app"));modalRoot.render(h(React.Profiler,{id:"Editor",onRender:(_id,phase,actualDuration)=>{window.editorRenders??=[];window.editorRenders.push({phase,actualDuration});}},render({transitionState:1,onClose:()=>modalRoot.render(null)})));};
const fallback=()=>null;
fallback.wrap=C=>C;
const implementations={Button,TextInput,TextArea,Checkbox,Select,SearchableSelect,Heading,Modal,openModal,showToast:message=>{document.getElementById("toast").textContent=message;},Toasts:{Type:{SUCCESS:1,FAILURE:2}},Parser:{parse:value=>value},useStateFromStores:(_stores,select)=>select(),IconUtils:{getGuildIconURL:()=>null},ChannelType:{GUILD_VOICE:2,GUILD_STAGE_VOICE:13,PUBLIC_THREAD:11,PRIVATE_THREAD:12,ANNOUNCEMENT_THREAD:10},Margins:{},SettingsTab:({children})=>h("div",null,children),Paragraph:({children})=>h("p",null,children),wrapTab:C=>C};
${[...names].filter(name => name !== "React").map(name => ["Button","TextInput","TextArea","Checkbox","Select","SearchableSelect","Heading","Modal","openModal"].includes(name) ? `export { ${name} };` : `export const ${name}=implementations[${JSON.stringify(name)}] || ${name.endsWith("Store") || name === "FluxDispatcher" ? "store" : name.endsWith("Icon") ? "Icon" : "fallback"};`).join("\n")}
export default fallback;
`;
const storage = `const values=new Map();export async function get(key){return values.get(key)}export async function set(key,value){window.editorStorageWrites=(window.editorStorageWrites||0)+1;values.set(key,structuredClone(value))}export async function del(key){values.delete(key)}`;
const engine = `
import * as DataStore from "@api/DataStore";
import {executeWorkflow,delay} from ${JSON.stringify(join(directory,"runtime.ts"))};
const state={automations:[],drafts:[],logs:[],guilds:[],loaded:true,runs:[],globalLimit:4};
export const saveAutomationDraft=value=>DataStore.set("LawyerCord_automationDraft_"+value.id,value);
export const discardAutomationDraft=id=>DataStore.del("LawyerCord_automationDraft_"+id);
export function getAutomationSnapshot(){return state}
export function subscribeAutomationState(){return ()=>{}}
export async function upsertAutomation(value){state.automations=[...state.automations.filter(a=>a.id!==value.id),structuredClone(value)];}
export function cancelAutomation(){}
export async function runAutomation(){throw Error("Live runs are disabled in this preview.")}
export async function testAutomation(value){try{await executeWorkflow(value,{}, {now:Date.now,random:Math.random,delay,external:()=>{throw Error("External action reached preview")},persistent:()=>{throw Error("Persistent write reached preview")},workflows:()=>[value],trace:()=>{}},{dryRun:true});return {success:true}}catch(error){return {success:false,error:error.message}}}
export const getAvailableCommands=()=>[];
export const requestCommandIndex=()=>{};
`;
const openRouter = `export const formatModelPrice=()=>"";export const getCachedModels=()=>[];export const subscribeModels=()=>()=>{};export const loadOpenRouterModels=async()=>[];`;
const output = resolve("dist/automation-review");
await mkdir(output, { recursive: true });
const result = await build({
    stdin: { contents: `import {openAutomationBuilder} from ${JSON.stringify(join(directory,"BuilderModal.tsx"))};import {createTemplate} from ${JSON.stringify(join(directory,"templates.ts"))};import {createAutomation,createAutomationBlock} from ${JSON.stringify(join(directory,"model.ts"))};window.previewOpen=(large=false)=>{const a=large?createAutomation():createTemplate("Process a list");if(large){a.blocks=Array.from({length:100},()=>createAutomationBlock("note"));a.blocks.forEach((b,i)=>b.next=a.blocks[i+1]?.id);a.entryId=a.blocks[0].id;}window.previewWorkflow=a;openAutomationBuilder(a);};window.previewOpen(${benchmark});`, resolveDir: root, loader: "tsx" },
    bundle: true, write: false, format: "iife", jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
    define: { "process.env.NODE_ENV": '"development"', IS_DISCORD_DESKTOP: "false", IS_WEB: "true" },
    plugins: [{ name: "isolated-preview", setup(build) {
        if (baseline) build.onLoad({ filter: /[\\/]automations[\\/].*\.tsx?$/ }, args => baselineFiles.has(args.path) ? { contents: baselineFiles.get(args.path), loader: args.path.endsWith("tsx") ? "tsx" : "ts" } : undefined);
        build.onResolve({ filter: /^@/ }, args => ({ path: args.path === "@api/DataStore" ? "storage" : "common", namespace: "preview" }));
        build.onResolve({ filter: /^\.\/engine$/ }, () => ({ path: "engine", namespace: "preview" }));
        build.onResolve({ filter: /^\.\/openRouter$/ }, () => ({ path: "openRouter", namespace: "preview" }));
        build.onLoad({ filter: /.*/, namespace: "preview" }, args => ({ contents: ({ common, storage, engine, openRouter })[args.path], loader: "js", resolveDir: root }));
    } }],
});
await writeFile(join(output, "preview.js"), result.outputFiles[0].contents);
const styles = (await Promise.all(["styles.css", "builder.css"].map(name => readFile(join(directory, name), "utf8")))).join("\n");
await writeFile(join(output, "preview.css"), styles);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="preview.css"><style>
:root{color-scheme:dark;--background-primary:#242429;--background-secondary:#1d1d22;--background-tertiary:#151519;--background-modifier-accent:#3a3a43;--text-normal:#eeeef2;--text-default:#eeeef2;--text-muted:#a5a5b3;--header-primary:#fff;--header-secondary:#ccc;--brand-500:#7289ff;--text-danger:#ff7272}
body{margin:0;background:#17171b;color:var(--text-normal);font:14px system-ui}*{box-sizing:border-box}button,input,textarea,select{font:inherit;color:inherit}button,select{background:#35353f;border:1px solid #505060;border-radius:6px;padding:7px 10px;cursor:pointer}input,textarea{width:100%;background:#16161c;border:1px solid #484852;padding:8px;border-radius:6px}input[type=checkbox]{width:auto}button:disabled{opacity:.45}header,footer{display:flex;justify-content:space-between;gap:10px;padding:14px}footer{justify-content:flex-end}.preview-modal{padding:12px;max-width:1600px;margin:auto}.vc-ab-workspace{height:73vh}.vc-ab-toolbar{padding:10px}#toast{position:fixed;bottom:0;left:12px;background:#242429;padding:6px}.preview-label{padding:8px 20px;background:#363020;color:#ffdf98}h2,h3,p{margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><div class="preview-label">Isolated editor preview. Discord controls are substituted. Live actions and persistent writes are disabled.</div><div id="app"></div><div id="toast" role="status"></div><script src="preview.js"></script></body></html>`;
await writeFile(join(output, "index.html"), html);
const server = createServer(async (request, response) => {
    const name = request.url === "/preview.js" ? "preview.js" : request.url === "/preview.css" ? "preview.css" : "index.html";
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(join(output, name)));
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
console.log(url);
if (!process.argv.includes("--test") && !benchmark) process.on("SIGINT", () => server.close());
else {
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    checks: try {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", error => (errors.push(error.message), console.error(error.message)));
        await page.setViewport({ width: 1440, height: 1000 });
        await page.goto(url);
        await page.waitForSelector(".vc-ab-node");
        if (benchmark) {
            await page.evaluate(() => { HTMLElement.prototype.setPointerCapture = () => {}; HTMLElement.prototype.releasePointerCapture = () => {}; });
            const client = await page.createCDPSession();
            await client.send("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
            await page.evaluate(() => { window.editorRenders = []; });
            const start = performance.now();
            for (let index = 0; index < 50; index++) await page.evaluate(index => new Promise(resolve => {
                document.querySelectorAll(".vc-ab-node")[index].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
                window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            }), index);
            const elapsedMs = performance.now() - start;
            const { profile } = await client.send("HeapProfiler.stopSampling");
            const sampledBytes = node => node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
            const renders = await page.evaluate(() => window.editorRenders);
            assert.deepEqual(errors, []);
            assert.ok(renders.length >= 50);
            const metrics = { blocks: 100, selections: 50, elapsedMs, renderCount: renders.length, renderDurationMs: renders.reduce((sum, event) => sum + event.actualDuration, 0), sampledAllocatedBytes: sampledBytes(profile.head), storageWrites: await page.evaluate(() => window.editorStorageWrites || 0), errors, baseline: baseline || null };
            await writeFile(join(output, baseline ? "editor-before.json" : "editor-after.json"), JSON.stringify(metrics, null, 2));
            console.log(JSON.stringify(metrics));
            break checks;
        }
        const click = async text => page.evaluate(text => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === text); if (!button) throw Error("Missing button: "+text); button.click(); }, text);
        assert.equal(await page.$eval(".vc-ab-title", el => el.textContent.includes("Process a list")), true);
        await page.screenshot({ path: join(output, "graph.png"), fullPage: true });
        await click("List");
        await page.waitForSelector(".vc-ab-step");
        assert.ok(await page.$$eval(".vc-ab-step", nodes => nodes.some(n => n.textContent.includes("Link to existing step"))));
        await page.screenshot({ path: join(output, "steps.png"), fullPage: true });
        await click("Test with sample data");
        await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Test finished"));
        await click("Canvas");
        await page.waitForSelector(".vc-ab-node");
        await page.click(".vc-ab-node");
        await click("Duplicate");
        await page.waitForFunction(() => document.querySelectorAll(".vc-ab-node").length === 3);
        await click("Undo");
        await page.waitForFunction(() => document.querySelectorAll(".vc-ab-node").length === 2);
        await click("Redo");
        await page.waitForFunction(() => document.querySelectorAll(".vc-ab-node").length === 3);
        await page.setViewport({ width: 720, height: 900 });
        await click("List");
        await page.screenshot({ path: join(output, "small-window.png"), fullPage: true });
        await page.setViewport({ width: 1440, height: 1000 });
        await page.evaluate(() => window.previewOpen(true));
        await page.waitForFunction(() => document.querySelectorAll(".vc-ab-node").length === 100);
        await page.screenshot({ path: join(output, "large-graph.png"), fullPage: true });
        assert.deepEqual(errors, []);
        await writeFile(join(output, "ui-checks.json"), JSON.stringify({ graph: true, steps: true, linkedSteps: true, dryRun: true, undoRedo: true, smallWindow: true, hundredBlocks: true, errors, liveDiscord: false }, null, 2));
        console.log("Isolated editor checks passed.");
    } finally { await browser.close(); server.close(); }
}
