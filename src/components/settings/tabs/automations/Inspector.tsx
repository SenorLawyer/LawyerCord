/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { DeleteIcon } from "@components/Icons";
import { copyWithToast } from "@utils/discord";
import { openModal } from "@utils/modal";
import type { ApplicationCommandOption } from "@vencord/discord-types";
import { ChannelStore, IconUtils, Parser, React, UserStore } from "@webpack/common";

import { BlockAdvanced, ExtendedFields, WorkflowAdvanced } from "./AdvancedInspector";
import { BLOCK_ICONS, blockDefinition, TRIGGER_LABELS } from "./blocks";
import { getAvailableCommands, requestCommandIndex } from "./engine";
import {
    AreaField,
    ChannelField,
    CheckField,
    DateField,
    ModelField,
    NumberField,
    SelectField,
    TextField,
    UserField,
} from "./fields";
import {
    addEdgeTarget,
    type Automation,
    AUTOMATION_TRIGGER_TYPES,
    AUTOMATION_UNITS,
    type AutomationBlock,
    type AutomationBlockConfig,
    type AutomationCommandOptionValue,
    type AutomationComponent,
    type AutomationPort,
    type AutomationTriggerType,
    type AutomationUnit,
    edgeTargets,
    fromDateTimeLocal,
    getAutomationVariableNames,
    inheritedContext,
    isRecord,
    outputPorts,
    parseComponents,
    portLabel,
    removeEdgeTarget,
    toDateTimeLocal,
} from "./model";
import { WorkflowRunHistory } from "./RunHistory";
import { schedulePreview, validateSchedule } from "./scheduling";
import { SYSTEM_TRIGGER_TYPES } from "./system";

function isUnit(value: unknown): value is AutomationUnit {
    return typeof value === "string" && AUTOMATION_UNITS.some(unit => unit === value);
}

function isTriggerType(value: unknown): value is AutomationTriggerType {
    return AUTOMATION_TRIGGER_TYPES.some(type => type === value);
}

function updateBlock(automation: Automation, id: string, patch: Partial<AutomationBlockConfig>): Automation {
    return { ...automation, blocks: automation.blocks.map(block => block.id === id ? { ...block, config: { ...block.config, ...patch } } : block) };
}

function primitiveValue(option: ApplicationCommandOption, value: string): string | number | boolean {
    if (option.type === 5) return value === "true";
    if (option.type === 4 || option.type === 10) return Number(value) || 0;
    return value;
}

function legacyCommandOptions(value: string | undefined): AutomationCommandOptionValue[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap(option => isRecord(option)
            && typeof option.name === "string"
            && typeof option.type === "number"
            && (typeof option.value === "string" || typeof option.value === "number" || typeof option.value === "boolean")
            ? [{ name: option.name, type: option.type, value: option.value }]
            : []);
    } catch {
        return [];
    }
}

const MATCH_OPTIONS = [{ label: "Contains", value: "contains" }, { label: "Is exactly", value: "exact" }, { label: "Matches a regular expression", value: "regex" }];
const COMPARE_OPTIONS = [{ label: "Is", value: "equals" }, { label: "Is not", value: "not-equals" }, { label: "Contains", value: "contains" }, { label: "Is greater than", value: "greater" }, { label: "Is less than", value: "less" }, { label: "Matches a regular expression", value: "regex" }];

function ModalFieldsEditor({ fields, onChange }: { fields: AutomationComponent[]; onChange(fields: AutomationComponent[]): void; }) {
    const add = () => onChange([...fields, { type: 1, components: [{ type: 4, style: 1, label: "Field", custom_id: crypto.randomUUID(), required: true }] }]);
    return <div className="vc-ab-subeditor">
        {fields.map((row, index) => {
            const field = row.components?.[0] ?? { type: 4 };
            const update = (patch: Partial<AutomationComponent>) => onChange(fields.map((current, currentIndex) => currentIndex === index ? { ...row, components: [{ ...field, ...patch }] } : current));
            return <section className="vc-ab-subeditor-item" key={`${field.custom_id}-${index}`}>
                <div className="vc-ab-subeditor-head"><strong>Text field {index + 1}</strong><Button size="iconOnly" variant="dangerSecondary" aria-label={`Remove field ${index + 1}`} onClick={() => onChange(fields.filter((_current, currentIndex) => currentIndex !== index))}><DeleteIcon width={16} height={16} /></Button></div>
                <TextField label="Label" value={field.label ?? ""} onChange={label => update({ label })} />
                <TextField label="Custom ID" value={field.custom_id ?? ""} onChange={custom_id => update({ custom_id })} />
                <TextField label="Default value" value={field.value ?? ""} onChange={value => update({ value })} />
                <CheckField label="Required" value={field.required ?? false} onChange={required => update({ required })} />
            </section>;
        })}
        <Button size="small" variant="secondary" onClick={add}>Add modal field</Button>
    </div>;
}

function CommandEditor({ block, onChange }: { block: AutomationBlock; onChange(patch: Partial<AutomationBlockConfig>): void; }) {
    const [, refresh] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const guildId = block.config.guildId ?? "";
    const channelId = block.config.channelId ?? "";
    const commands = getAvailableCommands(guildId, channelId);
    const command = commands.find(current => current.id === block.config.commandId);
    const options = block.config.commandOptions ?? legacyCommandOptions(block.config.optionsJson);

    const reload = () => {
        setLoading(true);
        requestCommandIndex(guildId, channelId);
        window.setTimeout(() => {
            setLoading(false);
            refresh(value => value + 1);
        }, 700);
    };

    // Discord indexes a channel's commands lazily, so ask once as soon as a channel is picked.
    React.useEffect(() => {
        if (channelId && !commands.length) reload();
    }, [channelId]);

    const updateOption = (option: ApplicationCommandOption, value: string) => {
        const next: AutomationCommandOptionValue = { name: option.name, type: option.type, value: primitiveValue(option, value) };
        onChange({ commandOptions: [...options.filter(current => current.name !== option.name), next], optionsJson: undefined });
    };

    return <>
        <ChannelField guildId={guildId} channelId={channelId} onChange={patch => onChange({ ...patch, commandId: "", commandName: "" })} />
        <SelectField
            label="Command"
            value={block.config.commandId ?? ""}
            description={channelId && !commands.length ? (loading ? "Asking Discord for this channel's commands…" : "Discord has not indexed this channel yet. Open it once, then refresh.") : undefined}
            options={[{ label: channelId ? "Choose a command" : "Choose a channel first", value: "" }, ...commands.map(current => ({ label: `/${current.name}`, value: current.id }))]}
            onChange={commandId => {
                const next = commands.find(current => current.id === commandId);
                onChange({ commandId: String(commandId), applicationId: next?.applicationId ?? "", commandName: next?.name ?? "", commandOptions: [] });
            }}
        />
        <div className="vc-ab-inline">
            <Button size="small" variant="secondary" disabled={!channelId || loading} onClick={reload}>{loading ? "Refreshing…" : "Refresh commands"}</Button>
            <span>{commands.length ? `${commands.length} available here` : ""}</span>
        </div>
        {command && <div className="vc-ab-command-options">
            <strong>/{command.name}</strong>
            <span>{command.description || "No description."}</span>
            {command.options.filter(option => option.type !== 1 && option.type !== 2).map(option => {
                const current = options.find(value => value.name === option.name)?.value;
                const label = `${option.displayName ?? option.name}${option.required ? " *" : ""}`;
                const description = option.displayDescription ?? option.description;
                if (option.type === 5) return <SelectField key={option.name} label={label} value={String(current ?? false)} description={description} options={[{ label: "False", value: "false" }, { label: "True", value: "true" }]} onChange={value => updateOption(option, String(value))} />;
                if (option.choices?.length) return <SelectField key={option.name} label={label} value={String(current ?? "")} description={description} options={[{ label: "Choose a value", value: "" }, ...option.choices.map(choice => ({ label: choice.name_localized ?? choice.name, value: String(choice.value) }))]} onChange={value => updateOption(option, String(value))} />;
                if (option.type === 6) return <UserField key={option.name} label={label} description={description} guildId={guildId} value={String(current ?? "")} onChange={value => updateOption(option, value)} />;
                return <TextField key={option.name} label={label} value={String(current ?? "")} description={description} placeholder={option.type >= 6 && option.type <= 9 ? "Discord ID or {{variable}}" : "Value or {{variable}}"} type={option.type === 4 || option.type === 10 ? "number" : undefined} onChange={value => updateOption(option, value)} />;
            })}
        </div>}
        <UserField label="Context target" description="Only for user context commands. Leave empty for slash commands." guildId={guildId} value={block.config.targetId ?? ""} onChange={targetId => onChange({ targetId })} />
    </>;
}

function AiEditor({ block, onChange }: { block: AutomationBlock; onChange(patch: Partial<AutomationBlockConfig>): void; }) {
    const { config } = block;
    const overriding = config.maxTokens !== undefined || config.temperature !== undefined || config.timeoutSeconds !== undefined;
    return <>
        <TextField label="What the AI reads" value={config.sourceVariable ?? ""} description="A variable name. Optional. Lists and objects are turned into JSON." placeholder="messages" onChange={sourceVariable => onChange({ sourceVariable })} />
        <AreaField label={block.type === "ai-prompt" ? "Prompt" : "Extra instructions"} value={config.content ?? ""} onChange={content => onChange({ content })} />
        {block.type === "ai-classify" && <TextField label="Allowed labels" value={config.labels ?? ""} description="Separate them with commas. The answer is always one of these." onChange={labels => onChange({ labels })} />}
        <TextField label="Save the answer as" value={config.variable ?? ""} onChange={variable => onChange({ variable })} />
        <details className="vc-ab-more">
            <summary>Model and tuning</summary>
            <ModelField allowDefault value={config.model ?? ""} onChange={model => onChange({ model })} />
            <AreaField label="System instructions" value={config.systemPrompt ?? ""} description="Optional. Leave empty for the block's built-in instructions." rows={3} onChange={systemPrompt => onChange({ systemPrompt })} />
            <CheckField label="Override the automation's AI settings" value={overriding} onChange={override => onChange({ maxTokens: override ? 800 : undefined, temperature: override ? 0.2 : undefined, timeoutSeconds: override ? 60 : undefined })} />
            {overriding && <div className="vc-ab-grid">
                <NumberField label="Max output tokens" value={config.maxTokens ?? 800} min={16} max={4_096} onChange={maxTokens => onChange({ maxTokens })} />
                <NumberField label="Temperature" value={config.temperature ?? 0.2} min={0} max={2} onChange={temperature => onChange({ temperature })} />
                <NumberField label="Timeout in seconds" value={config.timeoutSeconds ?? 60} min={1} max={300} onChange={timeoutSeconds => onChange({ timeoutSeconds })} />
            </div>}
        </details>
    </>;
}

function previewNodes(content: string) {
    // Show unresolved templates as chips so they read as placeholders, not literal text.
    return content.split(/(\{\{[^}]+\}\})/g).map((part, index) => part.startsWith("{{")
        ? <span className="vc-ab-preview-var" key={index}>{part.slice(2, -2).trim()}</span>
        : <React.Fragment key={index}>{Parser.parse(part)}</React.Fragment>);
}

function PreviewBody({ block }: { block: AutomationBlock; }) {
    const user = UserStore.getCurrentUser();
    const channel = block.config.channelId ? ChannelStore.getChannel(block.config.channelId) : undefined;
    const content = block.config.content ?? "";
    const name = user ? user.globalName || user.username : "You";
    const where = channel ? (channel.name ? `#${channel.name}` : "this DM") : "the chosen channel";

    return <div className="vc-ab-preview-body">
        <div className="vc-ab-preview-message">
            {user
                ? <img className="vc-ab-preview-avatar" src={IconUtils.getUserAvatarURL(user, false, 80)} alt="" />
                : <div className="vc-ab-preview-avatar" />}
            <div className="vc-ab-preview-copy">
                <div className="vc-ab-preview-head">
                    <strong>{name}</strong>
                    <time>{new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                </div>
                <div className="vc-ab-preview-content">
                    {content ? previewNodes(content) : <em>Your message goes here.</em>}
                </div>
            </div>
        </div>
        <span className="vc-ab-preview-note">Posts to {where} as {name}. Highlighted names are filled in when it runs.</span>
    </div>;
}

/** The message body, plus the switches Discord actually honours when posting. */
function MessageBody({ block, onChange, label = "Message" }: { block: AutomationBlock; onChange(patch: Partial<AutomationBlockConfig>): void; label?: string; }) {
    const { config } = block;
    return <div className="vc-ab-body">
        <AreaField
            label={config.aiEnabled ? "Tell the AI what to write" : label}
            description={config.aiEnabled
                ? "Instructions only, such as \"thank them if they agreed, otherwise apologise\". The AI reads the earlier message on its own."
                : undefined}
            value={config.content ?? ""}
            onChange={content => onChange({ content })}
        />
        <CheckField
            label="Let AI write it"
            description="Uses your OpenRouter connection instead of sending this text as it is."
            value={config.aiEnabled === true}
            onChange={aiEnabled => onChange({ aiEnabled })}
        />
        {config.aiEnabled && <>
            <ModelField allowDefault value={config.model ?? ""} onChange={model => onChange({ model })} />
            <TextField
                label="What the AI reads"
                description={`Leave empty to use ${config.sourceVariable?.trim() || "lastMessage"}, the message this block already works on.`}
                placeholder={config.sourceVariable?.trim() || "lastMessage"}
                value={config.aiInput ?? ""}
                onChange={aiInput => onChange({ aiInput })}
            />
        </>}
        <div className="vc-ab-grid">
            <CheckField label="Allow pings" description="Off means mentions show but nobody gets notified." value={config.allowMentions === true} onChange={allowMentions => onChange({ allowMentions })} />
            <CheckField label="Silent message" description="Sends without a notification sound." value={config.silent === true} onChange={silent => onChange({ silent })} />
        </div>
    </div>;
}

function MessagePreview({ block }: { block: AutomationBlock; }) {
    const expand = () => openModal(props => <div className="vc-ab-preview-modal">
        <button type="button" className="vc-ab-preview-backdrop" aria-label="Close preview" onClick={props.onClose} />
        <section className="vc-ab-preview-sheet">
            <header><strong>Message preview</strong><button type="button" onClick={props.onClose}>Close</button></header>
            <PreviewBody block={block} />
        </section>
    </div>);

    return <section className="vc-ab-preview">
        <div className="vc-ab-preview-label">
            <span>Preview</span>
            <button type="button" onClick={expand}>Expand</button>
        </div>
        <PreviewBody block={block} />
    </section>;
}

function VariablesPanel({ automation, beforeBlockId }: { automation: Automation; beforeBlockId?: string; }) {
    const variables = getAutomationVariableNames(automation, beforeBlockId);
    return <details className="vc-ab-more">
        <summary>Values you can use{variables.length ? ` (${variables.length})` : ""}</summary>
        <span className="vc-ab-field-description">Type these inside any text box, curly braces included. Click one to copy it.</span>
        {variables.length
            ? <div className="vc-ab-variable-list">{variables.map(variable => <button type="button" className="vc-ab-variable" key={variable} onClick={() => copyWithToast(`{{${variable}}}`, "Copied.")}><code>{`{{${variable}}}`}</code></button>)}</div>
            : <span className="vc-ab-field-description">No earlier block saves a value yet.</span>}
    </details>;
}

function Inherited({ title, detail, onOverride }: { title: string; detail: string; onOverride(): void; }) {
    return <div className="vc-ab-inherited">
        <div><strong>{title}</strong><span>{detail}</span></div>
        <button type="button" onClick={onOverride}>Change</button>
    </div>;
}

interface ConnectionsProps {
    automation: Automation;
    block: AutomationBlock;
    onChange(automation: Automation): void;
    onSelect(id: string): void;
    onInsert(port: AutomationPort): void;
}

function ConnectionsPanel({ automation, block, onChange, onSelect, onInsert }: ConnectionsProps) {
    const ports = outputPorts(block.type);
    const change = (port: AutomationPort, target: string, remove = false) => onChange({
        ...automation,
        blocks: automation.blocks.map(item => item.id === block.id ? { ...item, [port]: remove ? removeEdgeTarget(item[port], target) : addEdgeTarget(item[port], target) } : item),
    });
    const name = (item: AutomationBlock) => blockDefinition(item.type).label;

    return <section className="vc-ab-section vc-ab-connections" aria-label="Connections">
        <span className="vc-ab-panel-label">What happens next</span>
        {!ports.length && <span className="vc-ab-field-description">This block ends the run, so nothing comes after it.</span>}
        {ports.map(port => {
            const targets = edgeTargets(block[port]).flatMap(id => { const item = automation.blocks.find(candidate => candidate.id === id); return item ? [item] : []; });
            const others = automation.blocks.filter(item => item.id !== block.id && !targets.includes(item));
            return <div className={`vc-ab-conn ${port}`} key={port}>
                <em>{port === "error" ? "If it fails" : portLabel(block.type, port)}</em>
                <div className="vc-ab-conn-targets">
                    {targets.map(item => <span className="vc-ab-chip" key={item.id}>
                        <button type="button" onClick={() => onSelect(item.id)}>{name(item)}</button>
                        <button type="button" className="vc-ab-chip-remove" aria-label={`Disconnect ${name(item)}`} onClick={() => change(port, item.id, true)}>×</button>
                    </span>)}
                    {!targets.length && <span className="vc-ab-conn-empty">{port === "error" ? "The run stops with an error." : "Nothing yet."}</span>}
                    <button type="button" className="vc-ab-chip-add" onClick={() => onInsert(port)}>+ Add a step</button>
                </div>
                {others.length > 0 && <SelectField value="" options={[{ label: "Or connect to an existing step…", value: "" }, ...others.map(item => ({ label: `${name(item)}${item.config.variable ? ` (${item.config.variable})` : ""}`, value: item.id }))]} onChange={target => { if (target) change(port, String(target)); }} />}
            </div>;
        })}
        {ports.length > 0 && <span className="vc-ab-field-description">You can also drag from a dot on the block to another block, or hover a line and click × to remove it.</span>}
    </section>;
}

interface BlockInspectorProps {
    block: AutomationBlock;
    automation: Automation;
    setAutomation(automation: Automation): void;
    onSelect(id: string): void;
    onInsert(port: AutomationPort): void;
    onDuplicate(): void;
    onDelete(): void;
}

export function BlockInspector({ block, automation, setAutomation, onSelect, onInsert, onDuplicate, onDelete }: BlockInspectorProps) {
    const [override, setOverride] = React.useState({ channel: false, message: false, user: false });
    const patch = (config: Partial<AutomationBlockConfig>) => setAutomation(updateBlock(automation, block.id, config));
    const { config } = block;
    const item = blockDefinition(block.type);
    const Icon = BLOCK_ICONS[item.category];
    const guildId = config.guildId ?? "";
    const inherited = inheritedContext(automation.blocks, block.id);
    const inheritedChannel = inherited.channelId ? ChannelStore.getChannel(inherited.channelId) : undefined;

    // Every field below prefers what the flow already decided, and only asks when nothing upstream answers it.
    const usesInheritedMessage = inherited.messageFrom
        && !override.message
        && (!config.sourceVariable || config.sourceVariable === "lastMessage" || config.sourceVariable === inherited.messageVariable);

    const source = config.input ? null : usesInheritedMessage && inherited.messageFrom
        ? <Inherited
            title={`Works on the message from ${blockDefinition(inherited.messageFrom.type).label}`}
            detail={`Saved as ${inherited.messageVariable}.`}
            onOverride={() => setOverride({ ...override, message: true })}
        />
        : <>
            <TextField label="Which message" value={config.sourceVariable ?? "lastMessage"} description="The saved name of the message this block works on." onChange={sourceVariable => patch({ sourceVariable })} />
            <div className="vc-ab-grid">
                <TextField label="Message ID fallback" value={config.messageId ?? ""} onChange={messageId => patch({ messageId })} />
                <TextField label="Channel ID fallback" value={config.channelId ?? ""} onChange={channelId => patch({ channelId })} />
            </div>
        </>;

    const channel = !config.channelId && inherited.channelFrom && !override.channel
        ? <Inherited
            title={inheritedChannel?.name ? `Using #${inheritedChannel.name}` : "Using the channel from the earlier block"}
            detail={`Carried over from ${blockDefinition(inherited.channelFrom.type).label}.`}
            onOverride={() => setOverride({ ...override, channel: true })}
        />
        : <ChannelField guildId={guildId} channelId={config.channelId ?? ""} onChange={patch} />;

    const userField = (label: string, value: string, onChange: (next: string) => void, description?: string) =>
        !value && inherited.userFrom && !override.user
            ? <Inherited
                title={`Using the person from ${blockDefinition(inherited.userFrom.type).label}`}
                detail="The same user this automation is already dealing with."
                onOverride={() => setOverride({ ...override, user: true })}
            />
            : <UserField label={label} description={description} guildId={guildId} value={value} onChange={onChange} />;

    const sourceVariable = (label = "Which value", description?: string) => <TextField label={label} value={config.sourceVariable ?? ""} description={description ?? "The saved name of the value to use."} onChange={sourceVariable => patch({ sourceVariable })} />;
    const saveAs = <TextField label="Save the result as" value={config.variable ?? ""} description="Later blocks can use it by this name." onChange={variable => patch({ variable })} />;
    const showsSaveAs = config.variable !== undefined && !block.type.startsWith("ai-") && !["send-message", "send-dm", "reply-message", "edit-message", "forward-message", "interact-button", "interact-select", "interact-modal", "repeat", "for-each"].includes(block.type);

    return <div className="vc-ab-inspector-body">
        <header className={`vc-ab-panel-head ${item.category}`}>
            <span className="vc-ab-node-icon"><Icon width={16} height={16} /></span>
            <div className="vc-ab-panel-copy"><strong>{item.label}</strong><span>{item.description}</span></div>
            <div className="vc-ab-panel-actions">
                <Button size="small" variant="secondary" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>Duplicate</Button>
                <Button size="iconOnly" variant="dangerSecondary" aria-label="Delete block" title="Delete (Del)" onClick={onDelete}><DeleteIcon width={16} height={16} /></Button>
            </div>
        </header>

        <section className="vc-ab-section">
            {block.type === "send-message" && <>{channel}<MessageBody block={block} onChange={patch} /><MessagePreview block={block} /></>}
            {block.type === "send-embed" && <div className="vc-ab-warning">Discord only lets apps send embeds. Replace this block with Send message.</div>}
            {block.type === "send-components" && <div className="vc-ab-warning">Discord only lets apps send Components V2. Replace this block with Send message.</div>}
            {block.type === "send-dm" && <>{userField("Who", config.userId ?? "", userId => patch({ userId }))}<MessageBody block={block} onChange={patch} /><MessagePreview block={block} /></>}
            {(block.type === "reply-message" || block.type === "edit-message") && <>{source}<MessageBody block={block} onChange={patch} label={block.type === "reply-message" ? "Reply" : "New message text"} /><MessagePreview block={block} /></>}
            {(block.type === "delete-message" || block.type === "pin-message" || block.type === "unpin-message" || block.type === "mark-read") && source}
            {(block.type === "react-message" || block.type === "remove-reaction") && <>{source}<TextField label="Emoji" value={config.emoji ?? ""} description="A normal emoji, or a custom one such as <:name:id>." onChange={emoji => patch({ emoji })} /></>}
            {block.type === "forward-message" && <>{source}<ChannelField label="Forward to" guildId={guildId} channelId={config.channelId ?? ""} onChange={patch} /></>}
            {block.type === "create-thread" && <>{source}<TextField label="Thread name" value={config.name ?? ""} onChange={name => patch({ name })} /></>}
            {block.type === "typing-indicator" && <>{channel}<NumberField label="Seconds" value={config.durationSeconds ?? 3} min={0} max={60} onChange={durationSeconds => patch({ durationSeconds })} /></>}
            {block.type === "open-channel" && channel}
            {block.type === "crosspost-message" && source}
            {block.type === "search-messages" && <>{channel}<TextField label="Search for" value={config.matchText ?? ""} onChange={matchText => patch({ matchText })} /><NumberField label="Maximum results" value={config.limit ?? 25} min={1} max={100} onChange={limit => patch({ limit })} /></>}
            {block.type === "get-user" && userField("Who", config.userId ?? "", userId => patch({ userId }))}
            {block.type === "list-connections" && <span className="vc-ab-field-description">Saves what is linked in Discord's Connections settings. Only Spotify comes with a usable token, so other services are read-only here.</span>}
            {block.type === "notify" && <><TextField label="Title" value={config.name ?? ""} onChange={name => patch({ name })} /><AreaField label="Message" value={config.content ?? ""} rows={3} onChange={content => patch({ content })} /></>}
            {block.type === "spotify-seek" && <NumberField label="Seconds into the track" value={config.durationSeconds ?? 30} min={0} onChange={durationSeconds => patch({ durationSeconds })} />}
            {block.type === "spotify-volume" && <NumberField label="Volume" value={config.amount ?? 50} min={0} max={100} onChange={amount => patch({ amount })} />}
            {block.type === "spotify-now-playing" && <span className="vc-ab-field-description">Saves the name, artist, album, duration and a share link.</span>}
            {(block.type === "spotify-play" || block.type === "spotify-pause" || block.type === "spotify-next" || block.type === "spotify-previous") && <span className="vc-ab-field-description">Controls whichever device Spotify is playing on. Spotify only allows this on Premium accounts.</span>}
            {block.type === "split-text" && <>{sourceVariable("Text to split")}<TextField label="Split on" value={config.separator ?? ""} onChange={separator => patch({ separator })} /></>}
            {block.type === "regex-extract" && <>{sourceVariable("Text to search")}<TextField label="Regular expression" description="The first capture group is saved, or the whole match if there is none." value={config.matchText ?? ""} onChange={matchText => patch({ matchText })} /></>}
            {block.type === "random-item" && sourceVariable("List to pick from")}
            {block.type === "run-command" && <CommandEditor block={block} onChange={patch} />}

            {block.type === "wait-reply" && <>{channel}{userField("From who", config.authorId ?? "", authorId => patch({ authorId }), "Optional. Leave empty to accept anyone.")}
                <div className="vc-ab-grid">
                    <SelectField label="The message" value={config.matchMode ?? "contains"} options={MATCH_OPTIONS} onChange={matchMode => patch({ matchMode: matchMode as AutomationBlockConfig["matchMode"] })} />
                    <TextField label="This text" value={config.matchText ?? ""} placeholder="Leave empty for any reply" onChange={matchText => patch({ matchText })} />
                </div>
                <NumberField label="Give up after (seconds)" value={config.timeoutSeconds ?? 60} min={1} onChange={timeoutSeconds => patch({ timeoutSeconds })} />
                <CheckField
                    label="Only count real replies to my message"
                    description="Off means any message in the channel counts."
                    value={config.requireReply !== false}
                    onChange={requireReply => patch({ requireReply })}
                />
                <span className="vc-ab-field-description">Connect the Timed out dot to decide what happens when nobody answers.</span></>}
            {block.type === "wait-dm" && <>{userField("From who", config.userId ?? "", userId => patch({ userId }))}
                <div className="vc-ab-grid">
                    <SelectField label="The message" value={config.matchMode ?? "contains"} options={MATCH_OPTIONS} onChange={matchMode => patch({ matchMode: matchMode as AutomationBlockConfig["matchMode"] })} />
                    <TextField label="This text" value={config.matchText ?? ""} placeholder="Leave empty for any DM" onChange={matchText => patch({ matchText })} />
                </div>
                <NumberField label="Give up after (seconds)" value={config.timeoutSeconds ?? 60} min={1} onChange={timeoutSeconds => patch({ timeoutSeconds })} /></>}
            {block.type === "wait-until" && <TextField label="Date or timestamp" value={config.value ?? ""} description="A date like 2026-12-24T18:00, a millisecond timestamp, or a saved value." onChange={value => patch({ value })} />}
            {block.type === "delay" && <NumberField label="Seconds to wait" value={config.durationSeconds ?? 1} min={0} onChange={durationSeconds => patch({ durationSeconds })} />}

            {block.type === "fetch-dm" && <>{userField("Who", config.userId ?? "", userId => patch({ userId }))}<NumberField label="Messages to read" value={config.limit ?? 10} min={1} max={100} onChange={limit => patch({ limit })} /></>}
            {(block.type === "fetch-messages" || block.type === "fetch-unread") && <>{channel}
                <div className="vc-ab-grid">
                    <NumberField label="Messages to read" value={config.limit ?? 25} min={1} max={100} onChange={limit => patch({ limit })} />
                    <TextField label="Before message ID" value={config.beforeMessageId ?? ""} onChange={beforeMessageId => patch({ beforeMessageId })} />
                </div>
                <CheckField label="Include bot messages" value={config.includeBots !== false} onChange={includeBots => patch({ includeBots })} /></>}
            {block.type === "fetch-mentions" && <><NumberField label="Maximum mentions" value={config.limit ?? 50} min={1} max={100} onChange={limit => patch({ limit })} /><CheckField label="Include bot messages" value={config.includeBots !== false} onChange={includeBots => patch({ includeBots })} /></>}

            {block.type.startsWith("ai-") && <AiEditor block={block} onChange={patch} />}

            {block.type === "read-components" && <>{source}<span className="vc-ab-field-description">Saves every button and menu with its label, custom ID, row and position. Run it once to see what a message offers.</span></>}
            {block.type === "read-embed" && <>{source}<NumberField label="Which embed" value={config.embedIndex ?? 1} min={1} max={10} onChange={embedIndex => patch({ embedIndex })} /><span className="vc-ab-field-description">Read parts of it with a path, such as {"{{embed.title}}"} or {"{{embed.fields.0.value}}"}.</span></>}
            {block.type === "interact-button" && <>{source}
                <SelectField label="Find the button by" value={config.componentMatch ?? "label"} options={[{ label: "Its label", value: "label" }, { label: "Its custom ID", value: "customId" }, { label: "Row and position", value: "position" }]} onChange={componentMatch => patch({ componentMatch: componentMatch as AutomationBlockConfig["componentMatch"] })} />
                {(config.componentMatch ?? "label") === "label" && <TextField label="Button label" description="Part of it is enough, so Accept finds Accept invite." value={config.componentLabel ?? ""} onChange={componentLabel => patch({ componentLabel })} />}
                {config.componentMatch === "customId" && <TextField label="Custom ID" value={config.customId ?? ""} onChange={customId => patch({ customId })} />}
                {config.componentMatch === "position" && <div className="vc-ab-grid">
                    <NumberField label="Row" value={config.componentRow ?? 1} min={1} onChange={componentRow => patch({ componentRow })} />
                    <NumberField label="Position in that row" value={config.componentIndex ?? 1} min={1} onChange={componentIndex => patch({ componentIndex })} />
                </div>}</>}
            {block.type === "interact-select" && <>{source}
                <div className="vc-ab-step-label"><strong>1. Which menu</strong><span>A message can carry several menus. Pick the one to open.</span></div>
                <SelectField label="Find the menu by" value={config.componentMatch ?? "label"} options={[{ label: "Its placeholder text", value: "label" }, { label: "Its custom ID", value: "customId" }, { label: "Row and position", value: "position" }]} onChange={componentMatch => patch({ componentMatch: componentMatch as AutomationBlockConfig["componentMatch"] })} />
                {(config.componentMatch ?? "label") === "label" && <TextField label="Placeholder text" description="Part of it is enough, so Choose finds Choose a role." value={config.componentLabel ?? ""} onChange={componentLabel => patch({ componentLabel })} />}
                {config.componentMatch === "customId" && <TextField label="Custom ID" description="The exact custom_id Discord gives the menu. Read it with List buttons and menus." value={config.customId ?? ""} onChange={customId => patch({ customId })} />}
                {config.componentMatch === "position" && <div className="vc-ab-grid">
                    <NumberField label="Row" description="Counting from 1." value={config.componentRow ?? 1} min={1} max={5} onChange={componentRow => patch({ componentRow })} />
                    <NumberField label="Position in that row" value={config.componentIndex ?? 1} min={1} max={5} onChange={componentIndex => patch({ componentIndex })} />
                </div>}
                <div className="vc-ab-step-label"><strong>2. Which option</strong><span>Now choose an entry inside that menu.</span></div>
                <SelectField label="Find the option by" value={config.optionMode ?? "exact"} options={[{ label: "Its exact label", value: "exact" }, { label: "Part of its label", value: "contains" }, { label: "A regular expression", value: "regex" }, { label: "Its position in the list", value: "index" }]} onChange={optionMode => patch({ optionMode: optionMode as AutomationBlockConfig["optionMode"] })} />
                <TextField
                    label={config.optionMode === "index" ? "Position in the list" : "Option to choose"}
                    description={config.optionMode === "index" ? "Counting from 1." : "Matched against the option's label and its value."}
                    value={config.optionQuery ?? ""}
                    onChange={optionQuery => patch({ optionQuery })}
                />
                <span className="vc-ab-field-description">Not sure what the message offers? Put a List buttons and menus block in front of this one and run it once.</span></>}
            {block.type === "interact-modal" && <>{source}<TextField label="Modal custom ID" value={config.customId ?? ""} onChange={customId => patch({ customId })} /><ModalFieldsEditor fields={config.modalFields ?? parseComponents(config.modalFieldsJson ?? "[]").components} onChange={modalFields => patch({ modalFields, modalFieldsJson: undefined })} /></>}

            {block.type === "set-variable" && <><TextField label="Name" value={config.variable ?? ""} onChange={variable => patch({ variable })} /><AreaField label="Value" value={config.value ?? ""} description="Saved names such as {{reply.author.id}} are filled in when this block runs." rows={3} onChange={value => patch({ value })} /></>}
            {block.type === "math-variable" && <>{sourceVariable("Number to change")}<SelectField label="Operation" value={config.operation ?? "add"} options={[{ label: "Add", value: "add" }, { label: "Subtract", value: "subtract" }, { label: "Multiply", value: "multiply" }, { label: "Divide", value: "divide" }, { label: "Round to decimal places", value: "round" }]} onChange={operation => patch({ operation: operation as AutomationBlockConfig["operation"] })} /><NumberField label={config.operation === "round" ? "Decimal places" : "Amount"} value={config.amount ?? 1} onChange={amount => patch({ amount })} /></>}
            {block.type === "delete-variable" && sourceVariable("Name to forget")}
            {block.type === "text-variable" && <>{sourceVariable("Text to change")}<SelectField label="Operation" value={config.operation ?? "trim"} options={[{ label: "Trim spaces", value: "trim" }, { label: "UPPERCASE", value: "uppercase" }, { label: "lowercase", value: "lowercase" }, { label: "Replace text", value: "replace" }, { label: "Add text at the end", value: "append" }, { label: "Add text at the start", value: "prepend" }]} onChange={operation => patch({ operation: operation as AutomationBlockConfig["operation"] })} />
                {config.operation === "replace" && <div className="vc-ab-grid"><TextField label="Find" value={config.needle ?? ""} onChange={needle => patch({ needle })} /><TextField label="Replace with" value={config.replacement ?? ""} onChange={replacement => patch({ replacement })} /></div>}
                {(config.operation === "append" || config.operation === "prepend") && <TextField label="Text" value={config.value ?? ""} onChange={value => patch({ value })} />}</>}
            {block.type === "random-number" && <div className="vc-ab-grid"><NumberField label="Lowest" value={config.min ?? 1} onChange={min => patch({ min })} /><NumberField label="Highest" value={config.max ?? 100} onChange={max => patch({ max })} /></div>}
            {block.type === "current-time" && <SelectField label="Format" value={config.value ?? "iso"} options={[{ label: "Date and time (ISO)", value: "iso" }, { label: "Millisecond timestamp", value: "timestamp" }]} onChange={value => patch({ value: String(value) })} />}
            {block.type === "array-length" && sourceVariable("List or text to count")}
            {block.type === "join-array" && <>{sourceVariable("List to join")}<TextField label="Field from each item" value={config.fieldPath ?? ""} description="For messages, use content. Leave empty to join whole items." onChange={fieldPath => patch({ fieldPath })} /><TextField label="Put between items" value={config.separator ?? "\n"} onChange={separator => patch({ separator })} /></>}
            {block.type === "json-value" && <>{sourceVariable("Value to read from")}<TextField label="Path" value={config.fieldPath ?? ""} description="Use dots and numbers, such as messages.0.author.id." onChange={fieldPath => patch({ fieldPath })} /></>}
            {block.type === "filter-array" && <>{sourceVariable("List to filter")}<TextField label="Field from each item" value={config.fieldPath ?? ""} description="For messages, use content or author.id." onChange={fieldPath => patch({ fieldPath })} /><div className="vc-ab-grid"><SelectField label="Keep items that" value={config.operator ?? "contains"} options={COMPARE_OPTIONS} onChange={operator => patch({ operator: operator as AutomationBlockConfig["operator"] })} /><TextField label="This value" value={config.compareValue ?? ""} onChange={compareValue => patch({ compareValue })} /></div></>}

            {block.type === "condition" && <>
                {!config.sourceVariable && inherited.messageFrom && !override.message
                    ? <Inherited
                        title={`Checks the message from ${blockDefinition(inherited.messageFrom.type).label}`}
                        detail={`Its text, from ${inherited.messageVariable}.`}
                        onOverride={() => setOverride({ ...override, message: true })}
                    />
                    : <TextField
                        label="Check this"
                        description="A saved name such as reply.content. Leave empty to check the message the flow just handled."
                        placeholder={inherited.messageVariable ? `${inherited.messageVariable}.content` : "reply.content"}
                        value={config.sourceVariable ?? ""}
                        onChange={sourceVariable => patch({ sourceVariable })}
                    />}
                <div className="vc-ab-grid">
                    <SelectField label="Condition" value={config.operator ?? "equals"} options={COMPARE_OPTIONS} onChange={operator => patch({ operator: operator as AutomationBlockConfig["operator"] })} />
                    <TextField label="This value" value={config.compareValue ?? ""} onChange={compareValue => patch({ compareValue })} />
                </div>
                <span className="vc-ab-field-description">Connect the Yes dot for when it is true and the No dot for when it is not.</span>
            </>}
            {block.type === "chance" && <NumberField label="Chance in percent" description="Takes the Yes path this often, and No the rest of the time." value={config.chancePercent ?? 50} min={0} max={100} onChange={chancePercent => patch({ chancePercent })} />}
            {block.type === "repeat" && <><NumberField label="How many times" value={config.repeatCount ?? 2} min={0} max={1_000} onChange={repeatCount => patch({ repeatCount })} /><TextField label="Count is saved as" value={config.variable ?? "loopIndex"} description="Starts at 1 and goes up on every pass." onChange={variable => patch({ variable })} /><span className="vc-ab-field-description">Connect Each pass to the blocks that should repeat, and connect the last of them back to this block. Connect When done to what comes after.</span></>}
            {block.type === "fail" && <AreaField label="Error message" value={config.errorMessage ?? ""} rows={3} onChange={errorMessage => patch({ errorMessage })} />}
            {(block.type === "log" || block.type === "note") && <AreaField label={block.type === "log" ? "Log message" : "Note"} value={config.content ?? ""} rows={3} onChange={content => patch({ content })} />}

            {block.type === "list-processes" && <span className="vc-ab-field-description">Saves every running program with its name, process ID and memory use.</span>}
            {block.type === "check-process" && <><TextField label="Program" description="Its file name, such as RobloxPlayerBeta.exe." value={config.name ?? ""} onChange={name => patch({ name })} /><span className="vc-ab-field-description">Connect Running and Not running to what should happen in each case.</span></>}
            {block.type === "wait-process" && <><TextField label="Program" description="Its file name, such as RobloxPlayerBeta.exe." value={config.name ?? ""} onChange={name => patch({ name })} /><div className="vc-ab-grid"><SelectField label="Wait until it" value={config.value ?? "start"} options={[{ label: "Starts", value: "start" }, { label: "Closes", value: "exit" }]} onChange={value => patch({ value: String(value) })} /><NumberField label="Give up after (seconds)" value={config.timeoutSeconds ?? 300} min={1} max={86400} onChange={timeoutSeconds => patch({ timeoutSeconds })} /></div></>}
            {block.type === "run-program" && <><TextField label="Program" description="A program on this computer, such as node or C:\\Tools\\backup.exe. It runs directly, without a shell." value={config.value ?? ""} onChange={value => patch({ value })} /><AreaField label="Arguments, one per line" description="Saved names such as {{game.name}} are filled in." value={config.content ?? ""} rows={3} onChange={content => patch({ content })} /><NumberField label="Give up after (seconds)" value={config.timeoutSeconds ?? 60} min={1} max={600} onChange={timeoutSeconds => patch({ timeoutSeconds })} /><span className="vc-ab-field-description">The result holds stdout, stderr and code, so {"{{output.stdout}}"} is what the program printed.</span></>}
            {block.type === "read-file" && <><TextField label="File" description="A text file inside your user folder." placeholder="C:\\Users\\you\\Documents\\notes.txt" value={config.value ?? ""} onChange={value => patch({ value })} /><NumberField label="Read at most (characters)" value={config.limit ?? 200000} min={1} max={2000000} onChange={limit => patch({ limit })} /></>}
            {block.type === "open-link" && <TextField label="Link" description="Opens in your browser. Only https links." placeholder="https://" value={config.value ?? ""} onChange={value => patch({ value })} />}
            {block.type === "roblox-current-game" && <span className="vc-ab-field-description">Saves the game you are in right now, with name, players, visits, icon and link, or nothing when Roblox is closed.</span>}
            {block.type === "roblox-game-info" && <TextField label="Place or universe ID" description="The number in a Roblox game link." value={config.value ?? ""} onChange={value => patch({ value })} />}
            {block.type === "codex-last-turn" && <span className="vc-ab-field-description">Saves the last Codex turn that finished: project, closing message, duration and any question it asked.</span>}
            {block.type === "codex-sessions" && <NumberField label="How many" value={config.limit ?? 10} min={1} max={50} onChange={limit => patch({ limit })} />}
            <ExtendedFields automation={automation} block={block} onChange={patch} />
            {showsSaveAs && saveAs}
        </section>

        <ConnectionsPanel automation={automation} block={block} onChange={setAutomation} onSelect={onSelect} onInsert={onInsert} />
        {block.type !== "note" && <BlockAdvanced automation={automation} block={block} onChange={patch} showVariable={!showsSaveAs && !block.type.startsWith("ai-")} />}
        <VariablesPanel automation={automation} beforeBlockId={block.id} />
    </div>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function SchedulePreview({ automation }: { automation: Automation; }) {
    const { schedule } = automation;
    let previews: number[] = [];
    let error = validateSchedule(schedule);
    if (!error) {
        try { previews = schedulePreview(automation).slice(0, 3); } catch (caught) { error = caught instanceof Error ? caught.message : "No upcoming runs."; }
    }
    if (error) return <p className="vc-ab-warning" role="alert">{error}</p>;
    return <div className="vc-ab-next-runs">
        <span className="vc-ab-field-label">Next runs</span>
        {previews.map(time => <span key={time}>{new Date(time).toLocaleString(undefined, { timeZone: schedule.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>)}
    </div>;
}

export function AutomationInspector({ automation, setAutomation }: { automation: Automation; setAutomation(automation: Automation): void; }) {
    const { schedule, trigger } = automation;
    const updateTrigger = (patch: Partial<Automation["trigger"]>) => setAutomation({ ...automation, trigger: { ...trigger, ...patch } });
    const changeSchedule = (values: Partial<Automation["schedule"]>) => setAutomation({ ...automation, schedule: { ...schedule, ...values } });
    const system = SYSTEM_TRIGGER_TYPES.some(type => type === trigger.type);
    const live = trigger.type !== "schedule" && trigger.type !== "startup" && !system;
    const mode = schedule.mode ?? "interval";
    const weekdays = schedule.weekdays ?? [1, 2, 3, 4, 5];

    return <div className="vc-ab-inspector-body">
        <header className="vc-ab-panel-head flow">
            <span className="vc-ab-node-icon"><BLOCK_ICONS.flow width={16} height={16} /></span>
            <div className="vc-ab-panel-copy"><strong>This automation</strong><span>Give it a name and choose when it starts. Click a block to edit that block instead.</span></div>
        </header>

        <section className="vc-ab-section">
            <TextField label="Name" value={automation.name} onChange={name => setAutomation({ ...automation, name })} />
            <FormSwitch title="Turned on" description="Runs while LawyerCord is open. You can still test it while it is off." value={automation.enabled} onChange={enabled => setAutomation({ ...automation, enabled })} hideBorder />
        </section>

        <section className="vc-ab-section">
            <span className="vc-ab-panel-label">When does it start?</span>
            <SelectField value={trigger.type} options={AUTOMATION_TRIGGER_TYPES.map(value => ({ label: TRIGGER_LABELS[value], value }))} onChange={type => isTriggerType(type) && updateTrigger({ type })} />
            {trigger.type === "schedule" && <>
                <SelectField label="How often" value={mode} options={[{ label: "Every so often", value: "interval" }, { label: "On certain days at a set time", value: "calendar" }, { label: "Cron expression (advanced)", value: "cron" }]} onChange={next => { if (next === "interval" || next === "calendar" || next === "cron") changeSchedule({ mode: next }); }} />
                {mode === "interval" && <>
                    <div className="vc-ab-grid">
                        <NumberField label="Every" value={schedule.interval} min={1} onChange={interval => changeSchedule({ interval })} />
                        <SelectField label="Unit" value={schedule.unit} options={AUTOMATION_UNITS.map(unit => ({ label: unit[0].toUpperCase() + unit.slice(1), value: unit }))} onChange={unit => isUnit(unit) && changeSchedule({ unit })} />
                    </div>
                    <DateField label="Starting from" value={toDateTimeLocal(schedule.startAt)} onChange={value => { const startAt = fromDateTimeLocal(value); if (startAt !== null) changeSchedule({ startAt }); }} />
                </>}
                {mode === "calendar" && <>
                    <TextField label="At what time" type="time" value={schedule.time ?? "09:00"} onChange={time => changeSchedule({ time })} />
                    <div className="vc-ab-field">
                        <span className="vc-ab-field-label">On these days</span>
                        <div className="vc-ab-weekdays">{WEEKDAYS.map((label, day) => <button type="button" key={label} className={weekdays.includes(day) ? "active" : ""} aria-pressed={weekdays.includes(day)} onClick={() => changeSchedule({ weekdays: weekdays.includes(day) ? weekdays.filter(value => value !== day) : [...weekdays, day].sort() })}>{label}</button>)}</div>
                    </div>
                </>}
                {mode === "cron" && <TextField label="Cron expression" value={schedule.cron ?? ""} description="Minute, hour, day of month, month, day of week." placeholder="0 9 * * 1-5" onChange={cron => changeSchedule({ cron })} />}
                <SchedulePreview automation={automation} />
            </>}
            {trigger.type === "startup" && <span className="vc-ab-field-description">Runs once every time LawyerCord finishes loading.</span>}
            {trigger.type.startsWith("roblox-") && <TextField label="Only this game" description="Part of the game's name, or its place ID. Leave empty for every game." value={trigger.matchText ?? ""} onChange={matchText => updateTrigger({ matchText })} />}
            {trigger.type.startsWith("process-") && <TextField label="Program" description="Its file name, such as RobloxPlayerBeta.exe or Code.exe. A List running programs block shows what is open." placeholder="notepad.exe" value={trigger.matchText ?? ""} onChange={matchText => updateTrigger({ matchText })} />}
            {trigger.type.startsWith("codex-") && <>
                <TextField label="Only this project" description="Part of the project folder's name or path. Leave empty for every project." value={trigger.matchText ?? ""} onChange={matchText => updateTrigger({ matchText })} />
                <CheckField label="Include helper agents" description="Codex spawns helper agents for side tasks. Off means only the main conversation counts." value={trigger.includeSubagents === true} onChange={includeSubagents => updateTrigger({ includeSubagents })} />
            </>}
            {live && <>
                <ChannelField label="Only in this channel" description="Leave empty to listen everywhere." guildId={trigger.guildId ?? ""} channelId={trigger.channelId ?? ""} onChange={updateTrigger} />
                <UserField label="Only from this person" description="Optional. Leave empty to accept anyone." value={trigger.authorId ?? ""} onChange={authorId => updateTrigger({ authorId })} />
                {(trigger.type === "reaction-add" || trigger.type === "reaction-remove") && <TextField label="Only this emoji" value={trigger.emoji ?? ""} description="Optional." onChange={emoji => updateTrigger({ emoji })} />}
                {!trigger.type.startsWith("voice-") && <div className="vc-ab-grid">
                    <SelectField label="Only when the message" value={trigger.matchMode ?? "contains"} options={MATCH_OPTIONS} onChange={matchMode => updateTrigger({ matchMode: matchMode as Automation["trigger"]["matchMode"] })} />
                    <TextField label="This text" value={trigger.matchText ?? ""} placeholder="Leave empty for any message" onChange={matchText => updateTrigger({ matchText })} />
                </div>}
                <CheckField label="Include bots" value={trigger.includeBots !== false} onChange={includeBots => updateTrigger({ includeBots })} />
                <CheckField
                    label="Include my own messages"
                    description="Needed for command words you type yourself. Messages this automation posts are always ignored, so it cannot answer itself."
                    value={trigger.includeSelf === true}
                    onChange={includeSelf => updateTrigger({ includeSelf })}
                />
            </>}
        </section>

        <WorkflowAdvanced automation={automation} onChange={setAutomation} />
        <details className="vc-ab-more"><summary>Recent runs</summary><WorkflowRunHistory workflowId={automation.id} /></details>
        <VariablesPanel automation={automation} />
    </div>;
}
