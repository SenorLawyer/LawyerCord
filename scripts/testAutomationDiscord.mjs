/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const directory = resolve("src/components/settings/tabs/automations");
const source = await readFile(`${directory}/engine.ts`, "utf8");
const names = new Set();
for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*["'](@[^"']+|\.\/spotify)["']/g)) {
    for (const name of match[1].split(",").map(value => value.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])) if (/^\w+$/.test(name)) names.add(name);
}
const common = `
const noop=()=>{};
const store={getCurrentUser:()=>({id:"100000000000000001"}),getChannel:id=>({id,name:"test",type:0,guild_id:"300000000000000001"}),getChannelId:()=>"200000000000000001",getVoiceChannelId:()=>null,getUser:id=>globalThis.users.get(id),getMember:()=>globalThis.member,getStatus:()=>"online",getActivities:()=>[{name:"A game",details:"Playing"}],getClientStatus:()=>({desktop:"online"})};
const implementations={
FluxDispatcher:{subscribe:(name,fn)=>{const list=globalThis.handlers.get(name)||new Set();list.add(fn);globalThis.handlers.set(name,list)},unsubscribe:(name,fn)=>{const list=globalThis.handlers.get(name);list?.delete(fn);if(!list?.size)globalThis.handlers.delete(name)}},
Constants:{Endpoints:{SEARCH_GUILD:id=>"guild/"+id,SEARCH_CHANNEL:id=>"channel/"+id,USER:id=>"user/"+id}},
RestAPI:{get:async args=>{globalThis.requests.push(args);return globalThis.response(args)}},
Logger:class{warn(){}error(){}debug(){}info(){}},sleep:async()=>{}
};
${[...names].map(name => `export const ${name}=implementations[${JSON.stringify(name)}]||${name.endsWith("Store") ? "store" : "noop"};`).join("\n")}
export default implementations.Logger;
`;
const storage = `export async function keys(){return [...globalThis.data.keys()]}export async function getMany(keys){return keys.map(key=>globalThis.data.get(key))}export async function setMany(entries){for(const [key,value]of entries)globalThis.data.set(key,structuredClone(value))}export async function get(key){return globalThis.data.get(key)}export async function set(key,value){globalThis.data.set(key,structuredClone(value))}export async function del(key){globalThis.data.delete(key)}export async function update(key,fn){globalThis.data.set(key,fn(globalThis.data.get(key)))}`;
const bundled = await build({
    stdin: { contents: `${source}\nexport { externalBlock };export { createAutomation, createAutomationBlock, getAutomationVariableNames } from "./model";export { compileTriggers, matchTriggers } from "./events";export { normalizeClientEvents } from "./events";export { blockOutputs, validateWorkflow } from "./workflow";export { executeWorkflow } from "./runtime";`, loader: "ts", resolveDir: directory },
    bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "discord-fixtures", setup(build) {
        build.onResolve({ filter: /^@|^\.\/spotify$|^\.\/openRouter$/ }, args => ({ path: args.path === "@api/DataStore" ? "storage" : args.path === "./openRouter" ? "ai" : "common", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "storage" ? storage : args.path === "ai" ? "export const completeOpenRouter=async()=>({});export const getAutomationAISettings=async()=>({});export const loadOpenRouterModels=async()=>[];" : common, loader: "js" }));
    } }],
});
const globals = { module: { exports: {} }, exports: {}, users: new Map(), member: null, handlers: new Map(), requests: [], response: () => { throw Error("Unexpected request."); }, data: new Map(), structuredClone, crypto: globalThis.crypto, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, Date, Intl, performance, URL, window: { setTimeout, clearTimeout } };
runInNewContext(bundled.outputFiles[0].text, globals);
const api = globals.module.exports;
const userId = "100000000000000002";
const channelId = "200000000000000001";
const guildId = "300000000000000001";
const clone = value => JSON.parse(JSON.stringify(value));
function context(signal = new AbortController().signal) {
    return { runId: "test", workflow: api.createAutomation(), variables: {}, signal, dryRun: false };
}
function block(type, config = {}) {
    const value = api.createAutomationBlock(type);
    value.config = { ...value.config, ...config };
    return value;
}
const dispatch = (type, payload) => { for (const handler of globals.handlers.get(type) ?? []) handler({ type, ...payload }); };
await api.loadAutomationState();
await api.startAutomationEngine();
await api.setAutomationSystemEnabled(true);
try {
    globals.users.set(userId, { id: userId, username: "tester", globalName: "Test person", avatar: null });
    const user = (await api.externalBlock(block("get-user", { userId }), context())).value;
    assert.equal(user.displayName, "Test person");
    assert.equal(user.global_name, "Test person");
    assert.equal(user.status, "online");
    assert.equal(user.activities[0].name, "A game");
    assert.equal(globals.requests.length, 0, "Known users come from Discord's store.");
    globals.users.clear();
    globals.response = () => ({ body: { id: userId, username: "uncached", global_name: null } });
    assert.equal((await api.externalBlock(block("get-user", { userId }), context())).value.displayName, "uncached");
    assert.equal(globals.requests.at(-1).url, `user/${userId}`);
    assert.equal((await api.externalBlock(block("get-presence", { userId }), context())).value.clientStatus.desktop, "online");
    assert.equal((await api.externalBlock(block("get-member", { userId, guildId }), context())).value, null);
    globals.member = { nick: "Nick", roles: ["role"] };
    assert.deepEqual(clone((await api.externalBlock(block("get-member", { userId, guildId }), context())).value), { userId, guildId, nick: "Nick", roles: ["role"] });
    assert.equal((await api.externalBlock(block("get-selected-channel"), context())).value.id, channelId);

    globals.requests.length = 0;
    globals.response = ({ query }) => ({ status: 200, body: { messages: Array.from({ length: 25 }, (_, i) => [{ id: String(400000000000000000n + BigInt(query.offset + i)), channel_id: channelId, author: { id: userId }, content: "match", hit: true }, { id: "context", channel_id: channelId, author: { id: "other" }, content: "surrounding text", hit: false }]) } });
    const search = block("search-messages", { guildId, authorId: userId, limit: 60 });
    const messages = (await api.externalBlock(search, context())).value;
    assert.equal(messages.length, 60);
    assert.deepEqual(globals.requests.map(request => request.query.offset), [0, 25, 50]);
    assert.ok(globals.requests.every(request => request.query.author_id === userId && !request.query.content));
    assert.ok(messages.every(message => message.author.id === userId && message.id !== "context"));
    await api.externalBlock(block("search-messages", { guildId: "@me", channelId, authorId: userId }), context());
    assert.equal(globals.requests.at(-1).url, `channel/${channelId}`);
    globals.response = () => ({ status: 202, body: {} });
    await assert.rejects(api.externalBlock(search, context()), /indexing/);
    globals.requests.length = 0;
    const cancelSearch = new AbortController();
    globals.response = () => { cancelSearch.abort(); return { status: 200, body: { messages: [] } }; };
    await assert.rejects(api.externalBlock(search, context(cancelSearch.signal)));
    assert.equal(globals.requests.length, 1);

    const waiting = api.externalBlock(block("wait-presence", { authorId: userId, status: "online" }), context());
    assert.equal(globals.handlers.get("PRESENCE_UPDATES").size, 1);
    dispatch("PRESENCE_UPDATES", { updates: [{ user: { id: "other" }, status: "online" }, { user: { id: userId }, status: "idle" }, { user: { id: userId }, status: "online", activities: [{ name: "Game" }] }] });
    const event = await waiting;
    assert.equal(event.value.userId, userId);
    assert.equal(event.value.activities[0].name, "Game");
    assert.equal(event.port, "next");
    assert.equal(globals.handlers.size, 0);
    const cancelled = new AbortController();
    const cancelledWait = api.externalBlock(block("wait-client-event", { eventType: "typing-start" }), context(cancelled.signal));
    cancelled.abort();
    await assert.rejects(cancelledWait, /cancelled/i);
    assert.equal(globals.handlers.size, 0);
    const timeout = await api.externalBlock(block("wait-presence", { timeoutSeconds: 1 }), context());
    assert.equal(timeout.value, null);
    assert.equal(timeout.port, "alternate");
    assert.equal(globals.handlers.size, 0);
    const typing = api.externalBlock(block("wait-client-event", { eventType: "typing-start", guildId, authorId: userId }), context());
    dispatch("TYPING_START", { channelId, userId });
    assert.equal((await typing).value.guildId, guildId);

    const flow = api.createAutomation();
    flow.trigger = { type: "presence-update", authorId: userId, status: "online" };
    flow.enabled = true;
    const lookup = block("get-user", { userId });
    const consumer = block("log");
    lookup.next = consumer.id;
    flow.blocks = [lookup, consumer];
    flow.entryId = lookup.id;
    assert.ok(api.blockOutputs(flow, consumer.id).some(output => output.value === `blocks.${lookup.id}.value.activities.0.name`));
    assert.ok(api.getAutomationVariableNames(flow, consumer.id).includes("user.displayName"));
    assert.ok(api.getAutomationVariableNames(flow).includes("triggerEvent.status"));
    assert.ok(!api.getAutomationVariableNames(flow).includes("triggerMessage.content"));
    const index = api.compileTriggers([flow]);
    const normalized = { type: "PRESENCE_UPDATES", channelId: "", guildId: "", authorId: userId, content: "", self: false, bot: false, mention: false, fromEngine: false, status: "online" };
    assert.equal(api.matchTriggers(index, normalized).length, 1);
    assert.equal(api.matchTriggers(index, { ...normalized, authorId: "other" }).length, 0);
    assert.equal(api.matchTriggers(index, { ...normalized, status: "idle" }).length, 0);
    assert.equal(api.matchTriggers(index, { ...normalized, self: true }).length, 0);
    const relationship = api.normalizeClientEvents("RELATIONSHIP_ADD", { relationship: { id: userId, type: 3 } })[0];
    assert.equal(relationship.userId, userId);
    assert.equal(relationship.relationshipType, 3);
    assert.ok(api.validateWorkflow({ ...flow, blocks: [block("wait-client-event", { eventType: "bad" })] }).some(issue => /supported Discord event/.test(issue.message)));
    const triggered = api.createAutomation();
    triggered.enabled = true;
    triggered.trigger = { type: "presence-update", authorId: userId, status: "online" };
    triggered.blocks = [block("log", { content: "Observed {{triggerEvent.status}}" })];
    triggered.entryId = triggered.blocks[0].id;
    await api.upsertAutomation(triggered);
    dispatch("PRESENCE_UPDATES", { updates: [{ user: { id: userId }, status: "online" }] });
    for (let pass = 0; pass < 20; pass++) await new Promise(setImmediate);
    assert.ok(api.getAutomationSnapshot().logs.some(log => log.automationId === triggered.id), "Production dispatch starts the matching workflow.");
    await api.upsertAutomation({ ...triggered, enabled: false });
    assert.equal(globals.handlers.size, 0, "Disabling the final trigger removes its subscription.");
    const stopController = new AbortController();
    const stopWait = api.externalBlock(block("wait-presence"), context(stopController.signal));
    api.stopAutomationEngine();
    assert.equal(globals.handlers.size, 0);
    stopController.abort();
    await assert.rejects(stopWait);
    console.log("Discord automation search, outputs, event filters, waits, and cleanup passed.");
} finally {
    api.stopAutomationEngine();
}
