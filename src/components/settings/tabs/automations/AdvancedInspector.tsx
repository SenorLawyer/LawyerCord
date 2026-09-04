/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { React, SearchableSelect } from "@webpack/common";

import { SAFE_RETRY_TYPES } from "./catalog";
import { getAutomationSnapshot } from "./engine";
import { AreaField, CheckField, Field, NumberField, SelectField, TextField } from "./fields";
import { type Automation, type AutomationBlock, type AutomationBlockConfig, type ValueInput } from "./model";
import { schedulePreview, validateSchedule } from "./scheduling";
import { blockOutputs } from "./workflow";

export function JsonField({ label, value, draft, onChange, onInvalid }: { label: string; value: unknown; draft?: string; onChange(value: unknown): void; onInvalid(text: string): void; }) {
    return <Field description={draft !== undefined ? "Enter valid JSON before testing or saving this value." : undefined}>
        <AreaField label={label} value={draft ?? JSON.stringify(value ?? null, null, 2)} onChange={text => {
            try { const parsed: unknown = JSON.parse(text); onChange(parsed); }
            catch { onInvalid(text); }
        }} />
    </Field>;
}

export function InputField({ label, value, automation, blockId, onChange, draft, onInvalid }: { label: string; value?: ValueInput; automation: Automation; blockId: string; draft?: string; onInvalid(text: string): void; onChange(value?: ValueInput): void; }) {
    const mode = value?.kind === "literal" ? typeof value.value === "string" ? "text" : "json" : value?.kind ?? "automatic";
    return <div className="vc-ab-input-binding">
        <SelectField label={label} value={mode} options={[{ label: "Use inherited input", value: "automatic" }, { label: "Text", value: "text" }, { label: "JSON value", value: "json" }, { label: "Block output or variable", value: "reference" }, { label: "Text template", value: "template" }]} onChange={next => {
            if (next === "automatic") onChange(undefined);
            else if (next === "text") onChange({ kind: "literal", value: "" });
            else if (next === "json") onChange({ kind: "literal", value: {} });
            else if (next === "reference" || next === "template") onChange({ kind: next, value: "" });
        }} />
        {mode === "json" && <JsonField label="JSON value" value={value?.value} draft={draft} onInvalid={onInvalid} onChange={value => onChange({ kind: "literal", value })} />}
        {value?.kind === "reference" && <>
            <SearchableSelect options={blockOutputs(automation, blockId)} value={value.value} placeholder="Search upstream outputs" onChange={(option: string) => onChange({ kind: "reference", value: option })} />
            <TextField label="Variable or data path" value={value.value} description="Use input for a called workflow, or triggerEvent for an event." onChange={value => onChange({ kind: "reference", value })} />
        </>}
        {(mode === "text" || value?.kind === "template") && <AreaField label={mode === "text" ? "Text value" : "Template"} value={String(value?.value ?? "")} onChange={value => onChange({ kind: mode === "text" ? "literal" : "template", value })} />}
    </div>;
}

export function AdvancedBlockInspector({ automation, block, onChange }: { automation: Automation; block: AutomationBlock; onChange(config: Partial<AutomationBlockConfig>): void; }) {
    const c = block.config;
    const valid = (key: string, config: Partial<AutomationBlockConfig>) => {
        const jsonDrafts = { ...c.jsonDrafts };
        delete jsonDrafts[key];
        onChange({ ...config, jsonDrafts });
    };
    const invalid = (key: string, text: string) => onChange({ jsonDrafts: { ...c.jsonDrafts, [key]: text } });
    const workflows = getAutomationSnapshot().automations;
    return <>
        <Heading tag="h3">Inputs</Heading>
        <InputField label="Input source" value={c.input} automation={automation} blockId={block.id} draft={c.jsonDrafts?.input} onInvalid={text => invalid("input", text)} onChange={input => valid("input", { input })} />
        {block.type === "combine-arrays" && <InputField label="Second list" value={c.secondInput} automation={automation} blockId={block.id} draft={c.jsonDrafts?.secondInput} onInvalid={text => invalid("secondInput", text)} onChange={secondInput => valid("secondInput", { secondInput })} />}
        {block.type === "create-object" && <AreaField label="Object JSON" value={c.value ?? "{}"} onChange={value => onChange({ value })} />}
        {["map-fields", "sort-array", "unique-array"].includes(block.type) && <TextField label="Item field" value={c.fieldPath ?? ""} description="Leave empty to use the whole item." onChange={fieldPath => onChange({ fieldPath })} />}
        {block.type === "sort-array" && <CheckField label="Descending" value={c.descending ?? false} onChange={descending => onChange({ descending })} />}
        {block.type === "slice-array" && <><NumberField label="Start index" value={c.min ?? 0} onChange={min => onChange({ min })} /><NumberField label="End index, exclusive" value={c.max ?? 10} onChange={max => onChange({ max })} /></>}
        {["read-value", "write-value", "delete-value", "increment-value"].includes(block.type) && <TextField label="Saved value name" value={c.persistentKey ?? "value"} onChange={persistentKey => onChange({ persistentKey })} />}
        {block.type === "increment-value" && <NumberField label="Amount" value={c.amount ?? 1} min={-Number.MAX_SAFE_INTEGER} onChange={amount => onChange({ amount })} />}
        {block.type === "call-workflow" && <SelectField label="Workflow" value={c.workflowId ?? ""} options={workflows.filter(item => item.id !== automation.id).map(item => ({ label: item.name, value: item.id }))} onChange={value => onChange({ workflowId: String(value) })} />}
        {block.type === "switch" && <div className="vc-ab-cases">
            {(c.cases ?? []).map((item, index) => <div className="vc-ab-case" key={item.target + index}>
                <TextField label="Match value" value={item.value} onChange={value => onChange({ cases: c.cases?.map((entry, i) => i === index ? { ...entry, value } : entry) })} />
                <SelectField label="Go to" value={item.target} options={automation.blocks.filter(b => b.id !== block.id).map(b => ({ label: b.config.variable || b.type, value: b.id }))} onChange={target => onChange({ cases: c.cases?.map((entry, i) => i === index ? { ...entry, target: String(target) } : entry) })} />
                <Button size="small" variant="dangerSecondary" onClick={() => onChange({ cases: c.cases?.filter((_entry, i) => i !== index) })}>Remove route</Button>
            </div>)}
            <Button size="small" variant="secondary" onClick={() => onChange({ cases: [...c.cases ?? [], { value: "", target: "" }] })}>Add route</Button>
        </div>}
        {["fetch-message", "list-reactions", "get-channel"].includes(block.type) && <TextField label="Channel ID or template" value={c.channelId ?? ""} onChange={channelId => onChange({ channelId })} />}
        {["fetch-message", "list-reactions"].includes(block.type) && <TextField label="Message ID or template" value={c.targetId ?? ""} onChange={targetId => onChange({ targetId })} />}
        {block.type === "wait-reaction" && <><TextField label="Emoji name or ID" value={c.emoji ?? ""} onChange={emoji => onChange({ emoji })} /><TextField label="User ID, optional" value={c.authorId ?? ""} onChange={authorId => onChange({ authorId })} /><NumberField label="Timeout in seconds" value={c.timeoutSeconds ?? 60} min={1} max={86400} onChange={timeoutSeconds => onChange({ timeoutSeconds })} /></>}
        {block.type.startsWith("spotify-") && <TextField label="Spotify device ID" description="Leave empty to use the active device." value={c.deviceId ?? ""} onChange={deviceId => onChange({ deviceId })} />}
        {block.type === "spotify-shuffle" && <CheckField label="Shuffle" value={c.value !== "false"} onChange={value => onChange({ value: String(value) })} />}
        {block.type === "spotify-repeat" && <SelectField label="Repeat" value={c.value ?? "off"} options={["off", "track", "context"].map(value => ({ label: value, value }))} onChange={value => onChange({ value: String(value) })} />}
        {block.type.startsWith("ai-") && <>
            <AreaField label="Conversation JSON" description="Optional array of user and assistant messages, each with role and content." value={c.conversation ?? ""} onChange={conversation => onChange({ conversation })} />
            <AreaField label="Result schema" description="Optional JSON schema using type, properties, required, items, enum, and additionalProperties." value={c.schema ?? ""} onChange={schema => onChange({ schema })} />
        </>}
        <Heading tag="h3">Outputs</Heading>
        <TextField label="Save result as" value={c.variable ?? ""} description={`This block also exposes blocks.${block.id}.value.`} onChange={variable => onChange({ variable })} />
        <details className="vc-ab-advanced"><summary>Advanced settings and test data</summary>
            <JsonField label="Sample result for Test" value={c.sample} draft={c.jsonDrafts?.sample} onInvalid={text => invalid("sample", text)} onChange={sample => valid("sample", { sample })} />
            {SAFE_RETRY_TYPES.has(block.type) && <><NumberField label="Read retries" value={c.retryCount ?? 0} max={5} onChange={retryCount => onChange({ retryCount })} /><NumberField label="Retry delay in seconds" value={c.retryDelaySeconds ?? 1} min={1} max={60} onChange={retryDelaySeconds => onChange({ retryDelaySeconds })} /></>}
        </details>
    </>;
}

export function RuntimeInspector({ automation, onChange }: { automation: Automation; onChange(value: Automation): void; }) {
    const patch = (values: Partial<Automation>) => onChange({ ...automation, ...values });
    const { schedule } = automation;
    const changeSchedule = (values: Partial<Automation["schedule"]>) => patch({ schedule: { ...schedule, ...values } });
    let previews: number[] = [];
    let scheduleError = validateSchedule(schedule);
    if (automation.trigger.type === "schedule" && !scheduleError) {
        try { previews = schedulePreview(automation); } catch (error) { scheduleError = error instanceof Error ? error.message : "No scheduled occurrences."; }
    }
    return <>
        <SelectField label="First block" value={automation.entryId ?? ""} options={[{ label: "Find entry automatically", value: "" }, ...automation.blocks.map(block => ({ label: block.config.variable || block.type, value: block.id }))]} onChange={entryId => patch({ entryId: String(entryId) || undefined })} />
        <Heading tag="h3">Run controls</Heading>
        <SelectField label="When already running" value={automation.runMode ?? "skip"} options={[{ label: "Queue triggers", value: "queue" }, { label: "Skip triggers", value: "skip" }, { label: "Run in parallel", value: "parallel" }]} onChange={value => { if (value === "queue" || value === "skip" || value === "parallel") patch({ runMode: value }); }} />
        {automation.runMode === "parallel" && <NumberField label="Concurrent runs" value={automation.concurrency ?? 1} min={1} max={32} onChange={concurrency => patch({ concurrency })} />}
        <NumberField label="Queued events" value={automation.queueLimit ?? 50} max={200} onChange={queueLimit => patch({ queueLimit })} />
        <NumberField label="Cooldown in seconds" value={automation.cooldownSeconds ?? 0} max={86400} onChange={cooldownSeconds => patch({ cooldownSeconds })} />
        <NumberField label="Maximum block steps" value={automation.maxSteps ?? 10000} min={1} max={100000} onChange={maxSteps => patch({ maxSteps })} />
        {automation.trigger.type === "schedule" && <>
            <Heading tag="h3">Schedule</Heading>
            <SelectField label="Schedule type" value={schedule.mode ?? "interval"} options={[{ label: "Interval", value: "interval" }, { label: "Calendar", value: "calendar" }, { label: "Cron", value: "cron" }]} onChange={mode => { if (mode === "interval" || mode === "calendar" || mode === "cron") changeSchedule({ mode }); }} />
            <TextField label="Timezone" value={schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={timezone => changeSchedule({ timezone })} />
            {schedule.mode === "calendar" && <>
                <TextField label="Time of day" type="time" value={schedule.time ?? "09:00"} onChange={time => changeSchedule({ time })} />
                <div className="vc-ab-weekdays">{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, day) => <CheckField key={label} label={label} value={(schedule.weekdays ?? [1, 2, 3, 4, 5]).includes(day)} onChange={enabled => changeSchedule({ weekdays: enabled ? [...schedule.weekdays ?? [1, 2, 3, 4, 5], day] : (schedule.weekdays ?? [1, 2, 3, 4, 5]).filter(value => value !== day) })} />)}</div>
            </>}
            {schedule.mode === "cron" && <TextField label="Cron expression" value={schedule.cron ?? ""} description="Minute, hour, day of month, month, day of week." onChange={cron => changeSchedule({ cron })} />}
            <TextField label="Active hours start" type="time" value={schedule.activeStart ?? ""} onChange={activeStart => changeSchedule({ activeStart })} />
            <TextField label="Active hours end" type="time" value={schedule.activeEnd ?? ""} onChange={activeEnd => changeSchedule({ activeEnd })} />
            <SelectField label="Missed occurrences" value={schedule.missed ?? "legacy"} options={[{ label: "Skip", value: "skip" }, { label: "Run once on return", value: "once" }, { label: "Preserve legacy timing", value: "legacy" }]} onChange={missed => { if (missed === "skip" || missed === "once" || missed === "legacy") changeSchedule({ missed }); }} />
            {scheduleError ? <p role="alert">{scheduleError}</p> : <ol className="vc-ab-schedule-preview">{previews.map(time => <li key={time}>{new Date(time).toLocaleString(undefined, { timeZone: schedule.timezone })}</li>)}</ol>}
        </>}
        <details className="vc-ab-advanced"><summary>AI defaults for this workflow</summary>
            <TextField label="Model" value={automation.ai?.model ?? ""} onChange={model => patch({ ai: { ...automation.ai, model } })} />
            <AreaField label="System instructions" value={automation.ai?.systemPrompt ?? ""} onChange={systemPrompt => patch({ ai: { ...automation.ai, systemPrompt } })} />
            <NumberField label="Temperature" value={automation.ai?.temperature ?? 0.2} max={2} onChange={temperature => patch({ ai: { ...automation.ai, temperature } })} />
            <NumberField label="Maximum output tokens" value={automation.ai?.maxTokens ?? 800} min={16} max={4096} onChange={maxTokens => patch({ ai: { ...automation.ai, maxTokens } })} />
            <NumberField label="AI timeout in seconds" value={automation.ai?.timeoutSeconds ?? 60} min={1} max={300} onChange={timeoutSeconds => patch({ ai: { ...automation.ai, timeoutSeconds } })} />
        </details>
    </>;
}
