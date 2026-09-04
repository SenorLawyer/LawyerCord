/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { DeleteIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { openModal } from "@utils/modal";
import type { ApplicationCommandOption } from "@vencord/discord-types";
import { ChannelStore, IconUtils, Parser, React, UserStore } from "@webpack/common";

import { AdvancedBlockInspector, RuntimeInspector } from "./AdvancedInspector";
import { BLOCK_ICONS, blockDefinition } from "./blocks";
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
    type Automation,
    AUTOMATION_TRIGGER_TYPES,
    AUTOMATION_UNITS,
    type AutomationBlock,
    type AutomationBlockConfig,
    type AutomationCommandOptionValue,
    type AutomationComponent,
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
    toDateTimeLocal,
} from "./model";

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
    return <>
        <TextField label="Input variable" value={config.sourceVariable ?? ""} description="Optional. Arrays and objects are converted to JSON." onChange={sourceVariable => onChange({ sourceVariable })} />
        <AreaField label={block.type === "ai-prompt" ? "Prompt" : "Extra instructions"} value={config.content ?? ""} onChange={content => onChange({ content })} />
        {block.type === "ai-classify" && <TextField label="Allowed labels" value={config.labels ?? ""} description="Comma-separated. The result must be one label." onChange={labels => onChange({ labels })} />}
        <ModelField allowDefault value={config.model ?? ""} onChange={model => onChange({ model })} />
        <AreaField label="System instructions" value={config.systemPrompt ?? ""} description="Optional. Leave empty for the block's built-in instructions." rows={3} onChange={systemPrompt => onChange({ systemPrompt })} />
        <CheckField label="Override workflow generation settings" value={config.maxTokens !== undefined || config.temperature !== undefined || config.timeoutSeconds !== undefined} onChange={override => onChange({ maxTokens: override ? 800 : undefined, temperature: override ? 0.2 : undefined, timeoutSeconds: override ? 60 : undefined })} />
        {(config.maxTokens !== undefined || config.temperature !== undefined || config.timeoutSeconds !== undefined) && <div className="vc-ab-grid">
            <NumberField label="Max output tokens" value={config.maxTokens ?? 800} min={16} max={4_096} onChange={maxTokens => onChange({ maxTokens })} />
            <NumberField label="Temperature" value={config.temperature ?? 0.2} min={0} max={2} onChange={temperature => onChange({ temperature })} />
            <NumberField label="Timeout in seconds" value={config.timeoutSeconds ?? 60} min={1} max={300} onChange={timeoutSeconds => onChange({ timeoutSeconds })} />
        </div>}
        <TextField label="Save result as" value={config.variable ?? ""} onChange={variable => onChange({ variable })} />
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
        <span className="vc-ab-preview-note">Posts to {where} as {name}. Markdown, mentions and emoji render exactly as Discord shows them. Highlighted names are variables filled in when the block runs.</span>
    </div>;
}

/** The message body, plus the switches Discord actually honours when posting. */
function MessageBody({ block, onChange, label = "Message" }: { block: AutomationBlock; onChange(patch: Partial<AutomationBlockConfig>): void; label?: string; }) {
    const { config } = block;
    return <div className="vc-ab-body">
        <AreaField
            label={config.aiEnabled ? "Tell the AI what to write" : label}
            description={config.aiEnabled
                ? "Instructions only, such as \"thank them if they agreed, otherwise apologise\". Do not paste the earlier message here. The AI reads that from the variable below, and text in this box tends to come back in the reply."
                : undefined}
            value={config.content ?? ""}
            onChange={content => onChange({ content })}
        />
        <CheckField
            label="Write it with AI"
            description="Uses your OpenRouter connection instead of sending this text as-is."
            value={config.aiEnabled === true}
            onChange={aiEnabled => onChange({ aiEnabled })}
        />
        {config.aiEnabled && <>
            <ModelField allowDefault value={config.model ?? ""} onChange={model => onChange({ model })} />
            <TextField
                label="What the AI reads"
                description={`Leave empty to use ${config.sourceVariable?.trim() || "lastMessage"}, the message this block already works on. Set it to read something else instead.`}
                placeholder={config.sourceVariable?.trim() || "lastMessage"}
                value={config.aiInput ?? ""}
                onChange={aiInput => onChange({ aiInput })}
            />
        </>}
        <div className="vc-ab-grid">
            <CheckField label="Allow mentions" description="Off means pings render but nobody is notified." value={config.allowMentions === true} onChange={allowMentions => onChange({ allowMentions })} />
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
    return <section className="vc-ab-variables">
        <strong>Available variables</strong>
        <span>Use these in any text field. Click one to copy it.</span>
        {variables.length
            ? <div className="vc-ab-variable-list">{variables.map(variable => <button type="button" className="vc-ab-variable" key={variable} onClick={() => copyWithToast(`{{${variable}}}`, "Variable copied.")}><code>{`{{${variable}}}`}</code></button>)}</div>
            : <span>No earlier blocks create variables yet.</span>}
    </section>;
}

function Inherited({ title, detail, onOverride }: { title: string; detail: string; onOverride(): void; }) {
    return <div className="vc-ab-inherited">
        <div><strong>{title}</strong><span>{detail}</span></div>
        <button type="button" onClick={onOverride}>Change</button>
    </div>;
}

function OutputSummary({ block, automation }: { block: AutomationBlock; automation: Automation; }) {
    const ports = outputPorts(block.type);
    if (!ports.length) return null;
    return <section className="vc-ab-outputs">
        <strong>Connections</strong>
        {ports.map(port => {
            const names = edgeTargets(block[port])
                .map(id => automation.blocks.find(current => current.id === id))
                .filter((target): target is AutomationBlock => target !== undefined)
                .map(target => blockDefinition(target.type).label);
            return <div className="vc-ab-output-row" key={port}>
                <em className={port}>{portLabel(block.type, port)}</em>
                <span>{names.length ? names.join(", ") : "Not connected"}</span>
            </div>;
        })}
        <span className="vc-ab-field-description">Drag from a node's right-hand dot to connect. A port can feed several blocks, and they run one after another. Click a line to remove just that one.</span>
    </section>;
}

export function BlockInspector({ block, automation, setAutomation }: { block: AutomationBlock; automation: Automation; setAutomation(automation: Automation): void; }) {
    const [override, setOverride] = React.useState({ channel: false, message: false, user: false });
    const patch = (config: Partial<AutomationBlockConfig>) => setAutomation(updateBlock(automation, block.id, config));
    const { config } = block;
    const item = blockDefinition(block.type);
    const Icon = BLOCK_ICONS[item.category];
    const guildId = config.guildId ?? "";
    const result = null;
    const inherited = inheritedContext(automation.blocks, block.id);
    const inheritedChannel = inherited.channelId ? ChannelStore.getChannel(inherited.channelId) : undefined;

    // Every field below prefers what the flow already decided, and only asks when nothing upstream answers it.
    const usesInheritedMessage = inherited.messageFrom
        && !override.message
        && (!config.sourceVariable || config.sourceVariable === "lastMessage" || config.sourceVariable === inherited.messageVariable);

    const source = config.input ? null : usesInheritedMessage && inherited.messageFrom
        ? <Inherited
            title={`Acting on the message from ${blockDefinition(inherited.messageFrom.type).label}`}
            detail={`Saved as ${inherited.messageVariable}.`}
            onOverride={() => setOverride({ ...override, message: true })}
        />
        : <>
            <TextField label="Source variable" value={config.sourceVariable ?? "lastMessage"} description="The message this block acts on." onChange={sourceVariable => patch({ sourceVariable })} />
            <div className="vc-ab-grid">
                <TextField label="Message ID fallback" value={config.messageId ?? ""} onChange={messageId => patch({ messageId })} />
                <TextField label="Channel ID fallback" value={config.channelId ?? ""} onChange={channelId => patch({ channelId })} />
            </div>
        </>;

    const channel = !config.channelId && inherited.channelFrom && !override.channel
        ? <Inherited
            title={inheritedChannel?.name ? `Using #${inheritedChannel.name}` : "Using the channel from the previous block"}
            detail={`Carried over from ${blockDefinition(inherited.channelFrom.type).label}.`}
            onOverride={() => setOverride({ ...override, channel: true })}
        />
        : <ChannelField guildId={guildId} channelId={config.channelId ?? ""} onChange={patch} />;

    const userField = (label: string, value: string, onChange: (next: string) => void, description?: string) =>
        !value && inherited.userFrom && !override.user
            ? <Inherited
                title={`Using the person from ${blockDefinition(inherited.userFrom.type).label}`}
                detail="The same user this workflow is already dealing with."
                onOverride={() => setOverride({ ...override, user: true })}
            />
            : <UserField label={label} description={description} guildId={guildId} value={value} onChange={onChange} />;

    return <div className="vc-ab-inspector-body">
        <div className={`vc-ab-inspector-title ${item.category}`}>
            <span className="vc-ab-node-icon"><Icon width={16} height={16} /></span>
            <div><Heading tag="h2">{item.label}</Heading><Paragraph>{item.description}</Paragraph></div>
        </div>

        {block.type === "send-message" && <>{channel}<MessageBody block={block} onChange={patch} />{result}<MessagePreview block={block} /></>}
        {block.type === "send-embed" && <div className="vc-ab-warning">Discord only lets apps send embeds. Replace this block with Send message.</div>}
        {block.type === "send-components" && <div className="vc-ab-warning">Discord only lets apps send Components V2. Replace this block with Send message.</div>}
        {block.type === "send-dm" && <>{userField("User", config.userId ?? "", userId => patch({ userId }))}<MessageBody block={block} onChange={patch} />{result}<MessagePreview block={block} /></>}
        {(block.type === "reply-message" || block.type === "edit-message") && <>{source}<MessageBody block={block} onChange={patch} label={block.type === "reply-message" ? "Reply" : "New message content"} />{result}<MessagePreview block={block} /></>}
        {(block.type === "delete-message" || block.type === "pin-message" || block.type === "unpin-message" || block.type === "mark-read") && source}
        {(block.type === "react-message" || block.type === "remove-reaction") && <>{source}<TextField label="Emoji" value={config.emoji ?? ""} description="A Unicode emoji, or a custom one such as <:name:id>." onChange={emoji => patch({ emoji })} /></>}
        {block.type === "forward-message" && <>{source}<ChannelField label="Forward to" guildId={guildId} channelId={config.channelId ?? ""} onChange={patch} />{result}</>}
        {block.type === "create-thread" && <>{source}<TextField label="Thread name" value={config.name ?? ""} onChange={name => patch({ name })} />{result}</>}
        {block.type === "typing-indicator" && <>{channel}<NumberField label="Seconds" value={config.durationSeconds ?? 3} min={0} max={60} onChange={durationSeconds => patch({ durationSeconds })} /></>}
        {block.type === "open-channel" && channel}
        {block.type === "crosspost-message" && source}
        {block.type === "search-messages" && <>{channel}<TextField label="Search for" value={config.matchText ?? ""} onChange={matchText => patch({ matchText })} /><NumberField label="Maximum results" value={config.limit ?? 25} min={1} max={100} onChange={limit => patch({ limit })} />{result}</>}
        {block.type === "get-user" && <>{userField("User", config.userId ?? "", userId => patch({ userId }))}{result}</>}
        {block.type === "list-connections" && <>{result}<span className="vc-ab-field-description">Saves what is linked in Discord's Connections settings. Discord only shares a usable token for Spotify, so other services are read-only here.</span></>}
        {block.type === "notify" && <><TextField label="Title" value={config.name ?? ""} onChange={name => patch({ name })} /><AreaField label="Body" value={config.content ?? ""} rows={3} onChange={content => patch({ content })} /></>}
        {block.type === "spotify-seek" && <NumberField label="Seconds into the track" value={config.durationSeconds ?? 30} min={0} onChange={durationSeconds => patch({ durationSeconds })} />}
        {block.type === "spotify-volume" && <NumberField label="Volume" value={config.amount ?? 50} min={0} max={100} onChange={amount => patch({ amount })} />}
        {block.type === "spotify-now-playing" && <>{result}<span className="vc-ab-field-description">Saves name, artist, album, duration and a share link.</span></>}
        {(block.type === "spotify-play" || block.type === "spotify-pause" || block.type === "spotify-next" || block.type === "spotify-previous") && <span className="vc-ab-field-description">Controls whichever device Spotify is playing on. Spotify only allows this on Premium accounts.</span>}
        {block.type === "split-text" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><TextField label="Split on" value={config.separator ?? ""} onChange={separator => patch({ separator })} />{result}</>}
        {block.type === "regex-extract" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><TextField label="Regular expression" description="The first capture group is saved, or the whole match if there is none." value={config.matchText ?? ""} onChange={matchText => patch({ matchText })} />{result}</>}
        {block.type === "random-item" && <><TextField label="List variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} />{result}</>}
        {block.type === "run-command" && <CommandEditor block={block} onChange={patch} />}

        {block.type === "wait-reply" && <>{channel}{userField("Author", config.authorId ?? "", authorId => patch({ authorId }), "Optional. Leave empty to accept any author.")}
            <div className="vc-ab-grid">
                <SelectField label="Match" value={config.matchMode ?? "contains"} options={[{ label: "Contains", value: "contains" }, { label: "Full match", value: "exact" }, { label: "Regular expression", value: "regex" }]} onChange={matchMode => patch({ matchMode: matchMode as AutomationBlockConfig["matchMode"] })} />
                <NumberField label="Timeout in seconds" value={config.timeoutSeconds ?? 60} min={1} onChange={timeoutSeconds => patch({ timeoutSeconds })} />
            </div>
            <CheckField
                label="Only a reply to my message"
                description="On, this waits for someone to actually reply to the message this flow just sent. Off, any message in the channel counts."
                value={config.requireReply !== false}
                onChange={requireReply => patch({ requireReply })}
            />
            <TextField label="Message text" value={config.matchText ?? ""} description="Leave empty to accept the first reply." onChange={matchText => patch({ matchText })} />{result}
            <span className="vc-ab-field-description">Connect the Timed out port to decide what happens when nobody answers. Leave it empty to end the run there.</span></>}
        {block.type === "wait-dm" && <>{userField("User", config.userId ?? "", userId => patch({ userId }))}
            <div className="vc-ab-grid">
                <SelectField label="Match" value={config.matchMode ?? "contains"} options={[{ label: "Contains", value: "contains" }, { label: "Full match", value: "exact" }, { label: "Regular expression", value: "regex" }]} onChange={matchMode => patch({ matchMode: matchMode as AutomationBlockConfig["matchMode"] })} />
                <NumberField label="Timeout in seconds" value={config.timeoutSeconds ?? 60} min={1} onChange={timeoutSeconds => patch({ timeoutSeconds })} />
            </div>
            <TextField label="Message text" value={config.matchText ?? ""} description="Leave empty to accept the first DM." onChange={matchText => patch({ matchText })} />{result}</>}
        {block.type === "wait-until" && <TextField label="Date or timestamp" value={config.value ?? ""} description="An ISO date, a millisecond timestamp, or a template." onChange={value => patch({ value })} />}
        {block.type === "delay" && <NumberField label="Seconds" value={config.durationSeconds ?? 1} min={0} onChange={durationSeconds => patch({ durationSeconds })} />}

        {block.type === "fetch-dm" && <>{userField("User", config.userId ?? "", userId => patch({ userId }))}<NumberField label="Messages to read" value={config.limit ?? 10} min={1} max={100} onChange={limit => patch({ limit })} />{result}</>}
        {(block.type === "fetch-messages" || block.type === "fetch-unread") && <>{channel}
            <div className="vc-ab-grid">
                <NumberField label="Messages to read" value={config.limit ?? 25} min={1} max={100} onChange={limit => patch({ limit })} />
                <TextField label="Before message ID" value={config.beforeMessageId ?? ""} onChange={beforeMessageId => patch({ beforeMessageId })} />
            </div>
            <CheckField label="Include bot messages" value={config.includeBots !== false} onChange={includeBots => patch({ includeBots })} />{result}</>}
        {block.type === "fetch-mentions" && <><NumberField label="Maximum mentions" value={config.limit ?? 50} min={1} max={100} onChange={limit => patch({ limit })} /><CheckField label="Include bot messages" value={config.includeBots !== false} onChange={includeBots => patch({ includeBots })} />{result}</>}

        {(block.type === "ai-prompt" || block.type === "ai-summarize" || block.type === "ai-classify" || block.type === "ai-extract-json") && <AiEditor block={block} onChange={patch} />}

        {block.type === "read-components" && <>{source}{result}<span className="vc-ab-field-description">Saves every button and menu with its label, custom ID, row and position. Run this once to see what a message offers, then use those values in an interact block.</span></>}
        {block.type === "read-embed" && <>{source}<NumberField label="Which embed" value={config.embedIndex ?? 1} min={1} max={10} onChange={embedIndex => patch({ embedIndex })} />{result}<span className="vc-ab-field-description">Read fields off it with a data path, such as {"{{embed.title}}"} or {"{{embed.fields.0.value}}"}.</span></>}
        {block.type === "interact-button" && <>{source}
            <SelectField label="Find the button by" value={config.componentMatch ?? "label"} options={[{ label: "Its label", value: "label" }, { label: "Its custom ID", value: "customId" }, { label: "Row and position", value: "position" }]} onChange={componentMatch => patch({ componentMatch: componentMatch as AutomationBlockConfig["componentMatch"] })} />
            {(config.componentMatch ?? "label") === "label" && <TextField label="Button label" description="Matches part of the label, so Accept finds Accept invite." value={config.componentLabel ?? ""} onChange={componentLabel => patch({ componentLabel })} />}
            {config.componentMatch === "customId" && <TextField label="Custom ID" value={config.customId ?? ""} onChange={customId => patch({ customId })} />}
            <div className="vc-ab-grid">
                <NumberField label="Component row" value={config.componentRow ?? 1} min={1} onChange={componentRow => patch({ componentRow })} />
                <NumberField label="Button position" value={config.componentIndex ?? 1} min={1} onChange={componentIndex => patch({ componentIndex })} />
            </div>{result}</>}
        {block.type === "interact-select" && <>{source}
            <div className="vc-ab-step"><strong>1. Which menu</strong><span>A message can carry several menus. Pick the one to open.</span></div>
            <SelectField label="Find the menu by" value={config.componentMatch ?? "label"} options={[{ label: "Its placeholder text", value: "label" }, { label: "Its custom ID", value: "customId" }, { label: "Row and position", value: "position" }]} onChange={componentMatch => patch({ componentMatch: componentMatch as AutomationBlockConfig["componentMatch"] })} />
            {(config.componentMatch ?? "label") === "label" && <TextField label="Placeholder text" description="Matches part of it, so Choose finds Choose a role." value={config.componentLabel ?? ""} onChange={componentLabel => patch({ componentLabel })} />}
            {config.componentMatch === "customId" && <TextField label="Custom ID" description="The exact custom_id Discord gives the menu. Read it with List buttons and menus." value={config.customId ?? ""} onChange={customId => patch({ customId })} />}
            {config.componentMatch === "position" && <div className="vc-ab-grid">
                <NumberField label="Row" description="Action row, counting from 1." value={config.componentRow ?? 1} min={1} max={5} onChange={componentRow => patch({ componentRow })} />
                <NumberField label="Position in that row" value={config.componentIndex ?? 1} min={1} max={5} onChange={componentIndex => patch({ componentIndex })} />
            </div>}
            <div className="vc-ab-step"><strong>2. Which option</strong><span>Now choose an entry inside that menu.</span></div>
            <SelectField label="Find the option by" value={config.optionMode ?? "exact"} options={[{ label: "Its exact label", value: "exact" }, { label: "Part of its label", value: "contains" }, { label: "A regular expression", value: "regex" }, { label: "Its position in the list", value: "index" }]} onChange={optionMode => patch({ optionMode: optionMode as AutomationBlockConfig["optionMode"] })} />
            <TextField
                label={config.optionMode === "index" ? "Position in the list" : "Option to choose"}
                description={config.optionMode === "index" ? "Counting from 1." : "Matched against the option's label and its value."}
                value={config.optionQuery ?? ""}
                onChange={optionQuery => patch({ optionQuery })}
            />
            {result}
            <span className="vc-ab-field-description">Not sure what the message offers? Put a List buttons and menus block in front of this one and run it once.</span></>}
        {block.type === "interact-modal" && <>{source}<TextField label="Modal custom ID" value={config.customId ?? ""} onChange={customId => patch({ customId })} /><ModalFieldsEditor fields={config.modalFields ?? parseComponents(config.modalFieldsJson ?? "[]").components} onChange={modalFields => patch({ modalFields, modalFieldsJson: undefined })} />{result}</>}

        {block.type === "set-variable" && <><TextField label="Variable name" value={config.variable ?? ""} onChange={variable => patch({ variable })} /><AreaField label="Value" value={config.value ?? ""} description="Templates such as {{reply.author.id}} resolve when this block runs." rows={3} onChange={value => patch({ value })} /></>}
        {block.type === "math-variable" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><SelectField label="Operation" value={config.operation ?? "add"} options={[{ label: "Add", value: "add" }, { label: "Subtract", value: "subtract" }, { label: "Multiply", value: "multiply" }, { label: "Divide", value: "divide" }, { label: "Round to decimal places", value: "round" }]} onChange={operation => patch({ operation: operation as AutomationBlockConfig["operation"] })} /><NumberField label={config.operation === "round" ? "Decimal places" : "Amount"} value={config.amount ?? 1} onChange={amount => patch({ amount })} />{result}</>}
        {block.type === "delete-variable" && <TextField label="Variable name" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} />}
        {block.type === "text-variable" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><SelectField label="Operation" value={config.operation ?? "trim"} options={[{ label: "Trim whitespace", value: "trim" }, { label: "Uppercase", value: "uppercase" }, { label: "Lowercase", value: "lowercase" }, { label: "Replace text", value: "replace" }, { label: "Append text", value: "append" }, { label: "Prepend text", value: "prepend" }]} onChange={operation => patch({ operation: operation as AutomationBlockConfig["operation"] })} />
            {config.operation === "replace" && <div className="vc-ab-grid"><TextField label="Find" value={config.needle ?? ""} onChange={needle => patch({ needle })} /><TextField label="Replace with" value={config.replacement ?? ""} onChange={replacement => patch({ replacement })} /></div>}
            {(config.operation === "append" || config.operation === "prepend") && <TextField label="Text" value={config.value ?? ""} onChange={value => patch({ value })} />}{result}</>}
        {block.type === "random-number" && <><div className="vc-ab-grid"><NumberField label="Minimum" value={config.min ?? 1} onChange={min => patch({ min })} /><NumberField label="Maximum" value={config.max ?? 100} onChange={max => patch({ max })} /></div>{result}</>}
        {block.type === "current-time" && <><SelectField label="Format" value={config.value ?? "iso"} options={[{ label: "ISO date", value: "iso" }, { label: "Millisecond timestamp", value: "timestamp" }]} onChange={value => patch({ value: String(value) })} />{result}</>}
        {block.type === "array-length" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} />{result}</>}
        {block.type === "join-array" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><TextField label="Item field path" value={config.fieldPath ?? ""} description="For messages, use content. Leave empty to join whole items." onChange={fieldPath => patch({ fieldPath })} /><TextField label="Separator" value={config.separator ?? "\n"} onChange={separator => patch({ separator })} />{result}</>}
        {block.type === "json-value" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><TextField label="Data path" value={config.fieldPath ?? ""} description="Use dots and array indexes, such as messages.0.author.id." onChange={fieldPath => patch({ fieldPath })} />{result}</>}
        {block.type === "filter-array" && <><TextField label="Source variable" value={config.sourceVariable ?? ""} onChange={sourceVariable => patch({ sourceVariable })} /><TextField label="Item field path" value={config.fieldPath ?? ""} description="For messages, use content or author.id." onChange={fieldPath => patch({ fieldPath })} /><SelectField label="Comparison" value={config.operator ?? "contains"} options={[{ label: "Equals", value: "equals" }, { label: "Does not equal", value: "not-equals" }, { label: "Contains", value: "contains" }, { label: "Greater than", value: "greater" }, { label: "Less than", value: "less" }, { label: "Matches regex", value: "regex" }]} onChange={operator => patch({ operator: operator as AutomationBlockConfig["operator"] })} /><TextField label="Value" value={config.compareValue ?? ""} onChange={compareValue => patch({ compareValue })} />{result}</>}

        {block.type === "condition" && <>
            {!config.sourceVariable && inherited.messageFrom && !override.message
                ? <Inherited
                    title={`Checking the message from ${blockDefinition(inherited.messageFrom.type).label}`}
                    detail={`Its text, from ${inherited.messageVariable}.`}
                    onOverride={() => setOverride({ ...override, message: true })}
                />
                : <TextField
                    label="What to check"
                    description="A variable such as reply.content, or a template. Leave empty to use the message the flow just handled."
                    placeholder={inherited.messageVariable ? `${inherited.messageVariable}.content` : "reply.content"}
                    value={config.sourceVariable ?? ""}
                    onChange={sourceVariable => patch({ sourceVariable })}
                />}
            <SelectField label="Comparison" value={config.operator ?? "equals"} options={[{ label: "Equals", value: "equals" }, { label: "Does not equal", value: "not-equals" }, { label: "Contains", value: "contains" }, { label: "Greater than", value: "greater" }, { label: "Less than", value: "less" }, { label: "Matches regex", value: "regex" }]} onChange={operator => patch({ operator: operator as AutomationBlockConfig["operator"] })} />
            <TextField label="Compare it against" value={config.compareValue ?? ""} onChange={compareValue => patch({ compareValue })} />
        </>}
        {block.type === "chance" && <NumberField label="Chance percentage" value={config.chancePercent ?? 50} min={0} max={100} onChange={chancePercent => patch({ chancePercent })} />}
        {block.type === "repeat" && <><NumberField label="Iterations" value={config.repeatCount ?? 2} min={0} max={1_000} onChange={repeatCount => patch({ repeatCount })} /><TextField label="Iteration variable" value={config.variable ?? "loopIndex"} description="Starts at 1 and updates on every pass." onChange={variable => patch({ variable })} /></>}
        {block.type === "fail" && <AreaField label="Failure message" value={config.errorMessage ?? ""} rows={3} onChange={errorMessage => patch({ errorMessage })} />}
        {(block.type === "log" || block.type === "note") && <AreaField label={block.type === "log" ? "Log message" : "Note"} value={config.content ?? ""} rows={3} onChange={content => patch({ content })} />}

        {block.type !== "note" && <AdvancedBlockInspector automation={automation} block={block} onChange={patch} />}
        <OutputSummary block={block} automation={automation} />
        <VariablesPanel automation={automation} beforeBlockId={block.id} />
    </div>;
}

export function AutomationInspector({ automation, setAutomation }: { automation: Automation; setAutomation(automation: Automation): void; }) {
    const { schedule, trigger } = automation;
    const updateTrigger = (patch: Partial<Automation["trigger"]>) => setAutomation({ ...automation, trigger: { ...trigger, ...patch } });
    const live = trigger.type !== "schedule" && trigger.type !== "startup";

    return <div className="vc-ab-inspector-body">
        <div className="vc-ab-inspector-title flow">
            <span className="vc-ab-node-icon"><BLOCK_ICONS.flow width={16} height={16} /></span>
            <div><Heading tag="h2">Automation</Heading><Paragraph>Name the workflow and choose what starts it.</Paragraph></div>
        </div>
        <TextField label="Name" value={automation.name} onChange={name => setAutomation({ ...automation, name })} />
        <SelectField label="Start workflow" value={trigger.type} options={[{ label: "On a schedule", value: "schedule" }, { label: "When I am mentioned", value: "mention" }, { label: "When a message matches", value: "message" }, { label: "When a DM matches", value: "dm" }, { label: "When LawyerCord starts", value: "startup" }, ...AUTOMATION_TRIGGER_TYPES.filter(type => !["schedule", "mention", "message", "dm", "startup"].includes(type)).map(value => ({ label: value.replaceAll("-", " "), value }))]} onChange={type => isTriggerType(type) && updateTrigger({ type })} />
        {trigger.type === "schedule" && (schedule.mode ?? "interval") === "interval" && <>
            <div className="vc-ab-grid">
                <NumberField label="Run every" value={schedule.interval} min={1} onChange={interval => setAutomation({ ...automation, schedule: { ...schedule, interval } })} />
                <SelectField label="Time unit" value={schedule.unit} options={AUTOMATION_UNITS.map(unit => ({ label: unit[0].toUpperCase() + unit.slice(1), value: unit }))} onChange={unit => isUnit(unit) && setAutomation({ ...automation, schedule: { ...schedule, unit } })} />
            </div>
            <DateField label="First run" value={toDateTimeLocal(schedule.startAt)} onChange={value => { const startAt = fromDateTimeLocal(value); if (startAt !== null) setAutomation({ ...automation, schedule: { ...schedule, startAt } }); }} />
        </>}
        {live && <>
            <ChannelField
                label="Listen in"
                description="Leave empty to listen everywhere."
                guildId={trigger.guildId ?? ""}
                channelId={trigger.channelId ?? ""}
                onChange={updateTrigger}
            />
            <TextField label="Reaction emoji filter" value={trigger.emoji ?? ""} onChange={emoji => updateTrigger({ emoji })} />
            <CheckField label="Include bots" value={trigger.includeBots !== false} onChange={includeBots => updateTrigger({ includeBots })} />
            <UserField label="Author" description="Optional. Leave empty to accept any author." value={trigger.authorId ?? ""} onChange={authorId => updateTrigger({ authorId })} />
            <SelectField label="Text match" value={trigger.matchMode ?? "contains"} options={[{ label: "Contains", value: "contains" }, { label: "Full match", value: "exact" }, { label: "Regular expression", value: "regex" }]} onChange={matchMode => updateTrigger({ matchMode: matchMode as Automation["trigger"]["matchMode"] })} />
            <TextField label="Message text" value={trigger.matchText ?? ""} description="Leave empty to accept every matching event." onChange={matchText => updateTrigger({ matchText })} />
            <CheckField
                label="React to my own messages"
                description="Needed for command words you type yourself. Messages this automation posts are always ignored, so it cannot answer itself."
                value={trigger.includeSelf === true}
                onChange={includeSelf => updateTrigger({ includeSelf })}
            />
        </>}
        <NumberField
            label="Give up after"
            description="Minutes. A run that is still going past this stops and is logged as a failure. 0 removes the limit."
            value={automation.maxRunMinutes ?? 15}
            min={0}
            max={1_440}
            onChange={maxRunMinutes => setAutomation({ ...automation, maxRunMinutes })}
        />
        <CheckField label="Enabled" description="Run this workflow while LawyerCord is open." value={automation.enabled} onChange={enabled => setAutomation({ ...automation, enabled })} />
        <RuntimeInspector automation={automation} onChange={setAutomation} />
        <VariablesPanel automation={automation} />
    </div>;
}
