/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { React, SearchableSelect } from "@webpack/common";

import { blockDefinition } from "./blocks";
import { SAFE_RETRY_TYPES } from "./catalog";
import { getAutomationSnapshot } from "./engine";
import { AreaField, CheckField, Field, NumberField, SelectField, TextField } from "./fields";
import { type Automation, type AutomationBlock, type AutomationBlockConfig, type ValueInput } from "./model";
import { blockOutputs } from "./workflow";

/** Blocks whose whole job is to take a value in, so the input picker is their main field. */
const INPUT_TYPES = new Set(["for-each", "switch", "return", "call-workflow", "parse-json", "stringify-json", "map-fields", "sort-array", "unique-array", "slice-array", "combine-arrays", "write-value"]);
const INPUT_LABELS: Record<string, string> = { "for-each": "List to go through", switch: "Value to check", return: "Value to hand back", "call-workflow": "Value to pass along", "write-value": "Value to save", "combine-arrays": "First list", "parse-json": "JSON text", "stringify-json": "Value to turn into text" };

export function JsonField({ label, value, draft, onChange, onInvalid }: { label: string; value: unknown; draft?: string; onChange(value: unknown): void; onInvalid(text: string): void; }) {
    return <Field description={draft !== undefined ? "This is not valid JSON yet. Fix it before saving or testing." : undefined}>
        <AreaField label={label} value={draft ?? JSON.stringify(value ?? null, null, 2)} onChange={text => {
            try { const parsed: unknown = JSON.parse(text); onChange(parsed); }
            catch { onInvalid(text); }
        }} />
    </Field>;
}

export function InputField({ label, value, automation, blockId, onChange, draft, onInvalid }: { label: string; value?: ValueInput; automation: Automation; blockId: string; draft?: string; onInvalid(text: string): void; onChange(value?: ValueInput): void; }) {
    const mode = value?.kind === "literal" ? typeof value.value === "string" ? "text" : "json" : value?.kind ?? "automatic";
    return <div className="vc-ab-input-binding">
        <SelectField label={label} value={mode} options={[{ label: "Whatever the earlier block passed on", value: "automatic" }, { label: "A saved value", value: "reference" }, { label: "Text I type here", value: "text" }, { label: "Text with saved values filled in", value: "template" }, { label: "JSON I type here", value: "json" }]} onChange={next => {
            if (next === "automatic") onChange(undefined);
            else if (next === "text") onChange({ kind: "literal", value: "" });
            else if (next === "json") onChange({ kind: "literal", value: [] });
            else if (next === "reference" || next === "template") onChange({ kind: next, value: "" });
        }} />
        {mode === "json" && <JsonField label="JSON" value={value?.value} draft={draft} onInvalid={onInvalid} onChange={value => onChange({ kind: "literal", value })} />}
        {value?.kind === "reference" && <>
            <SearchableSelect options={blockOutputs(automation, blockId)} value={value.value} placeholder="Pick an earlier block's result" onChange={(option: string) => onChange({ kind: "reference", value: option })} />
            <TextField label="Or type a saved name" value={value.value} description="Use input inside a called workflow, or triggerEvent for the event that started this." onChange={value => onChange({ kind: "reference", value })} />
        </>}
        {(mode === "text" || value?.kind === "template") && <AreaField label={mode === "text" ? "Text" : "Text with saved values"} value={String(value?.value ?? "")} onChange={value => onChange({ kind: mode === "text" ? "literal" : "template", value })} />}
    </div>;
}

interface BlockFieldsProps {
    automation: Automation;
    block: AutomationBlock;
    onChange(config: Partial<AutomationBlockConfig>): void;
}

function useJsonDrafts(block: AutomationBlock, onChange: BlockFieldsProps["onChange"]) {
    const c = block.config;
    const valid = (key: string, config: Partial<AutomationBlockConfig>) => {
        const jsonDrafts = { ...c.jsonDrafts };
        delete jsonDrafts[key];
        onChange({ ...config, jsonDrafts });
    };
    const invalid = (key: string, text: string) => onChange({ jsonDrafts: { ...c.jsonDrafts, [key]: text } });
    return { valid, invalid };
}

/** The main fields for the blocks that only exist in the graph editor. */
export function ExtendedFields({ automation, block, onChange }: BlockFieldsProps) {
    const c = block.config;
    const { valid, invalid } = useJsonDrafts(block, onChange);
    const workflows = getAutomationSnapshot().automations;
    const blockName = (item: AutomationBlock) => `${blockDefinition(item.type).label}${item.config.variable ? ` (${item.config.variable})` : ""}`;
    return <>
        {INPUT_TYPES.has(block.type) && <InputField label={INPUT_LABELS[block.type] ?? "Input"} value={c.input} automation={automation} blockId={block.id} draft={c.jsonDrafts?.input} onInvalid={text => invalid("input", text)} onChange={input => valid("input", { input })} />}
        {block.type === "for-each" && <><TextField label="Each item is saved as" value={c.variable ?? "item"} onChange={variable => onChange({ variable })} /><span className="vc-ab-field-description">Connect Each pass to the blocks that should run per item, and connect the last of them back to this block. Connect When done to what comes after.</span></>}
        {block.type === "combine-arrays" && <InputField label="Second list" value={c.secondInput} automation={automation} blockId={block.id} draft={c.jsonDrafts?.secondInput} onInvalid={text => invalid("secondInput", text)} onChange={secondInput => valid("secondInput", { secondInput })} />}
        {block.type === "create-object" && <AreaField label="Object as JSON" description="Saved names inside it are filled in when this runs." value={c.value ?? "{}"} onChange={value => onChange({ value })} />}
        {["map-fields", "sort-array", "unique-array"].includes(block.type) && <TextField label="Field from each item" value={c.fieldPath ?? ""} description="Leave empty to use the whole item." onChange={fieldPath => onChange({ fieldPath })} />}
        {block.type === "sort-array" && <CheckField label="Highest first" value={c.descending ?? false} onChange={descending => onChange({ descending })} />}
        {block.type === "slice-array" && <div className="vc-ab-grid"><NumberField label="From position" description="Counting from 0." value={c.min ?? 0} onChange={min => onChange({ min })} /><NumberField label="Up to position" description="Not included." value={c.max ?? 10} onChange={max => onChange({ max })} /></div>}
        {["read-value", "write-value", "delete-value", "increment-value"].includes(block.type) && <TextField label="Saved value name" description="Kept between runs, even after a restart." value={c.persistentKey ?? "value"} onChange={persistentKey => onChange({ persistentKey })} />}
        {block.type === "increment-value" && <NumberField label="Add this much" value={c.amount ?? 1} min={-Number.MAX_SAFE_INTEGER} onChange={amount => onChange({ amount })} />}
        {block.type === "call-workflow" && <SelectField label="Automation to run" value={c.workflowId ?? ""} options={[{ label: "Choose an automation", value: "" }, ...workflows.filter(item => item.id !== automation.id).map(item => ({ label: item.name, value: item.id }))]} onChange={value => onChange({ workflowId: String(value) })} />}
        {block.type === "switch" && <div className="vc-ab-cases">
            <span className="vc-ab-field-label">Routes</span>
            <span className="vc-ab-field-description">The first route whose value matches wins. When none match, the No dot is used.</span>
            {(c.cases ?? []).map((item, index) => <div className="vc-ab-case" key={index}>
                <TextField label="When the value is" value={item.value} onChange={value => onChange({ cases: c.cases?.map((entry, i) => i === index ? { ...entry, value } : entry) })} />
                <SelectField label="Go to" value={item.target} options={[{ label: "Choose a block", value: "" }, ...automation.blocks.filter(b => b.id !== block.id).map(b => ({ label: blockName(b), value: b.id }))]} onChange={target => onChange({ cases: c.cases?.map((entry, i) => i === index ? { ...entry, target: String(target) } : entry) })} />
                <Button size="small" variant="dangerSecondary" onClick={() => onChange({ cases: c.cases?.filter((_entry, i) => i !== index) })}>Remove</Button>
            </div>)}
            <Button size="small" variant="secondary" onClick={() => onChange({ cases: [...c.cases ?? [], { value: "", target: "" }] })}>Add a route</Button>
        </div>}
        {["fetch-message", "list-reactions", "get-channel"].includes(block.type) && <TextField label="Channel ID" description="Or a saved name such as {{lastMessage.channel_id}}." value={c.channelId ?? ""} onChange={channelId => onChange({ channelId })} />}
        {["fetch-message", "list-reactions"].includes(block.type) && <TextField label="Message ID" description="Or a saved name such as {{lastMessage.id}}." value={c.targetId ?? ""} onChange={targetId => onChange({ targetId })} />}
        {block.type === "wait-reaction" && <><TextField label="Emoji" description="Leave empty to accept any reaction." value={c.emoji ?? ""} onChange={emoji => onChange({ emoji })} /><TextField label="From who" description="A user ID. Optional." value={c.authorId ?? ""} onChange={authorId => onChange({ authorId })} /><NumberField label="Give up after (seconds)" value={c.timeoutSeconds ?? 60} min={1} max={86400} onChange={timeoutSeconds => onChange({ timeoutSeconds })} /></>}
        {block.type === "spotify-shuffle" && <CheckField label="Shuffle on" value={c.value !== "false"} onChange={value => onChange({ value: String(value) })} />}
        {block.type === "spotify-repeat" && <SelectField label="Repeat" value={c.value ?? "off"} options={[{ label: "Off", value: "off" }, { label: "This track", value: "track" }, { label: "The whole playlist or album", value: "context" }]} onChange={value => onChange({ value: String(value) })} />}
    </>;
}

/** Everything a beginner never needs, folded away under one heading. */
export function BlockAdvanced({ automation, block, onChange, showVariable }: BlockFieldsProps & { showVariable: boolean; }) {
    const c = block.config;
    const { valid, invalid } = useJsonDrafts(block, onChange);
    return <details className="vc-ab-more">
        <summary>Advanced</summary>
        {!INPUT_TYPES.has(block.type) && <InputField label="Input" value={c.input} automation={automation} blockId={block.id} draft={c.jsonDrafts?.input} onInvalid={text => invalid("input", text)} onChange={input => valid("input", { input })} />}
        {showVariable && <TextField label="Save the result as" value={c.variable ?? ""} description={`Later blocks can use it by this name. It is also available as blocks.${block.id}.value.`} onChange={variable => onChange({ variable })} />}
        {block.type.startsWith("spotify-") && <TextField label="Spotify device ID" description="Leave empty to use the active device." value={c.deviceId ?? ""} onChange={deviceId => onChange({ deviceId })} />}
        {block.type.startsWith("ai-") && <>
            <AreaField label="Conversation JSON" description="Optional list of user and assistant messages, each with role and content." value={c.conversation ?? ""} onChange={conversation => onChange({ conversation })} />
            <AreaField label="Result schema" description="Optional JSON schema using type, properties, required, items, enum and additionalProperties." value={c.schema ?? ""} onChange={schema => onChange({ schema })} />
        </>}
        <JsonField label="Sample result for Test" value={c.sample} draft={c.jsonDrafts?.sample} onInvalid={text => invalid("sample", text)} onChange={sample => valid("sample", { sample })} />
        <span className="vc-ab-field-description">Test with sample data never talks to Discord. Blocks that would need it use this sample instead.</span>
        {SAFE_RETRY_TYPES.has(block.type) && <div className="vc-ab-grid"><NumberField label="Retries when reading fails" value={c.retryCount ?? 0} max={5} onChange={retryCount => onChange({ retryCount })} /><NumberField label="Seconds between retries" value={c.retryDelaySeconds ?? 1} min={1} max={60} onChange={retryDelaySeconds => onChange({ retryDelaySeconds })} /></div>}
    </details>;
}

export function WorkflowAdvanced({ automation, onChange }: { automation: Automation; onChange(value: Automation): void; }) {
    const patch = (values: Partial<Automation>) => onChange({ ...automation, ...values });
    const { schedule } = automation;
    const changeSchedule = (values: Partial<Automation["schedule"]>) => patch({ schedule: { ...schedule, ...values } });
    return <details className="vc-ab-more">
        <summary>Advanced</summary>
        <NumberField label="Give up after (minutes)" description="A run still going after this is stopped and logged as failed. 0 means never." value={automation.maxRunMinutes ?? 15} min={0} max={1_440} onChange={maxRunMinutes => patch({ maxRunMinutes })} />
        <SelectField label="If it is already running when it should start again" value={automation.runMode ?? "skip"} options={[{ label: "Wait, then run afterwards", value: "queue" }, { label: "Skip that start", value: "skip" }, { label: "Run both at the same time", value: "parallel" }]} onChange={value => { if (value === "queue" || value === "skip" || value === "parallel") patch({ runMode: value }); }} />
        {automation.runMode === "parallel" && <NumberField label="Runs at the same time" value={automation.concurrency ?? 1} min={1} max={32} onChange={concurrency => patch({ concurrency })} />}
        {automation.runMode === "queue" && <NumberField label="Maximum waiting starts" value={automation.queueLimit ?? 50} max={200} onChange={queueLimit => patch({ queueLimit })} />}
        <NumberField label="Cooldown (seconds)" description="Ignore new starts for this long after a run begins." value={automation.cooldownSeconds ?? 0} max={86400} onChange={cooldownSeconds => patch({ cooldownSeconds })} />
        <NumberField label="Maximum steps per run" description="Stops runaway loops." value={automation.maxSteps ?? 10000} min={1} max={100000} onChange={maxSteps => patch({ maxSteps })} />
        <SelectField label="First block" value={automation.entryId ?? ""} options={[{ label: "Pick automatically", value: "" }, ...automation.blocks.map(block => ({ label: `${blockDefinition(block.type).label}${block.config.variable ? ` (${block.config.variable})` : ""}`, value: block.id }))]} onChange={entryId => patch({ entryId: String(entryId) || undefined })} />
        {automation.trigger.type === "schedule" && <>
            <TextField label="Time zone" value={schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={timezone => changeSchedule({ timezone })} />
            <div className="vc-ab-grid">
                <TextField label="Only between" type="time" value={schedule.activeStart ?? ""} onChange={activeStart => changeSchedule({ activeStart })} />
                <TextField label="and" type="time" value={schedule.activeEnd ?? ""} onChange={activeEnd => changeSchedule({ activeEnd })} />
            </div>
            <SelectField label="If the computer was asleep at run time" value={schedule.missed ?? "legacy"} options={[{ label: "Skip that run", value: "skip" }, { label: "Run once when it wakes up", value: "once" }, { label: "Keep the old timing", value: "legacy" }]} onChange={missed => { if (missed === "skip" || missed === "once" || missed === "legacy") changeSchedule({ missed }); }} />
        </>}
        <span className="vc-ab-field-label">AI defaults for this automation</span>
        <TextField label="Model" value={automation.ai?.model ?? ""} description="Leave empty to use the model from the Automations settings page." onChange={model => patch({ ai: { ...automation.ai, model } })} />
        <AreaField label="System instructions" value={automation.ai?.systemPrompt ?? ""} onChange={systemPrompt => patch({ ai: { ...automation.ai, systemPrompt } })} />
        <div className="vc-ab-grid">
            <NumberField label="Temperature" value={automation.ai?.temperature ?? 0.2} max={2} onChange={temperature => patch({ ai: { ...automation.ai, temperature } })} />
            <NumberField label="Max output tokens" value={automation.ai?.maxTokens ?? 800} min={16} max={4096} onChange={maxTokens => patch({ ai: { ...automation.ai, maxTokens } })} />
            <NumberField label="AI timeout (seconds)" value={automation.ai?.timeoutSeconds ?? 60} min={1} max={300} onChange={timeoutSeconds => patch({ ai: { ...automation.ai, timeoutSeconds } })} />
        </div>
    </details>;
}
