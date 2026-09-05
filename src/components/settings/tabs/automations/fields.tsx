/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, SelectOption } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    Checkbox,
    GuildMemberStore,
    GuildStore,
    IconUtils,
    React,
    RelationshipStore,
    SearchableSelect,
    Select,
    TextArea,
    TextInput,
    ThemeStore,
    UserStore,
    useStateFromStores,
} from "@webpack/common";
import type { ReactNode } from "react";

import { searchGuildMembers } from "./memberSearch";
import { formatModelPrice, getCachedModels, loadOpenRouterModels, type OpenRouterModel, subscribeModels } from "./openRouter";

export const DM_GUILD_ID = "@me";

export type Choice = { label: string; value: string; };

export function Field({ label, description, hint, children }: { label?: string; description?: string; hint?: ReactNode; children: ReactNode; }) {
    return <div className="vc-ab-field">
        {label && <div className="vc-ab-field-head"><span className="vc-ab-field-label">{label}</span>{hint}</div>}
        {description && <span className="vc-ab-field-description">{description}</span>}
        {children}
    </div>;
}

export function TextField({ label, value, description, placeholder, type, onChange }: { label?: string; value: string; description?: string; placeholder?: string; type?: string; onChange(value: string): void; }) {
    return <Field label={label} description={description}><TextInput aria-label={label ?? "Value"} value={value} placeholder={placeholder} type={type} onChange={onChange} /></Field>;
}

/**
 * Native date inputs draw their calendar icon from the page's color-scheme, which Discord
 * leaves at "normal". Without this the picker is a black glyph on a dark field.
 */
export function DateField({ label, value, description, onChange }: { label: string; value: string; description?: string; onChange(value: string): void; }) {
    const theme = useStateFromStores([ThemeStore], () => ThemeStore.theme);
    return <Field label={label} description={description}>
        <div className="vc-ab-date" style={{ colorScheme: theme === "light" ? "light" : "dark" }}>
            <TextInput aria-label={label} value={value} type="datetime-local" onChange={onChange} />
        </div>
    </Field>;
}

export function AreaField({ label, value, description, rows = 4, onChange }: { label: string; value: string; description?: string; rows?: number; onChange(value: string): void; }) {
    return <Field label={label} description={description}><TextArea aria-label={label} value={value} rows={rows} onChange={onChange} /></Field>;
}

export function NumberField({ label, value, min = 0, max, description, onChange }: { label: string; value: number; min?: number; max?: number; description?: string; onChange(value: number): void; }) {
    // Clamping on every keystroke makes the box impossible to clear, so hold the raw text and clamp on blur.
    const [draft, setDraft] = React.useState<string | null>(null);
    const clamp = (next: number) => Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, next));
    return <Field label={label} description={description}>
        <TextInput
            aria-label={label}
            value={draft ?? String(value)}
            type="number"
            onChange={next => {
                setDraft(next);
                if (next.trim() !== "" && Number.isFinite(Number(next))) onChange(clamp(Number(next)));
            }}
            onBlur={() => {
                if (draft !== null && draft.trim() === "") onChange(clamp(0));
                setDraft(null);
            }}
        />
    </Field>;
}

export function SelectField({ label, value, options, description, onChange }: { label?: string; value: string | number; options: readonly { label: string; value: string | number; }[]; description?: string; onChange(value: string | number): void; }) {
    return <Field label={label} description={description}><Select options={options} select={(next: string | number) => onChange(next)} isSelected={(option: string | number) => option === value} serialize={(option: string | number) => String(option)} /></Field>;
}

export function CheckField({ label, description, value, onChange }: { label: string; description?: string; value: boolean; onChange(value: boolean): void; }) {
    return <div className="vc-ab-check"><Checkbox value={value} onChange={(_event, next) => onChange(next)} /><div><strong>{label}</strong>{description && <span>{description}</span>}</div></div>;
}

interface SearchFieldProps {
    label: string;
    description?: string;
    value: string;
    options: Choice[];
    placeholder: string;
    hint?: ReactNode;
    prefix?(option: SelectOption): ReactNode;
    onSearchChange?(query: string): void;
    onChange(value: string): void;
}

function SearchField({ label, description, value, options, placeholder, hint, prefix, onSearchChange, onChange }: SearchFieldProps) {
    return <Field label={label} description={description} hint={hint}>
        <SearchableSelect
            options={options}
            // SearchableSelect wants the raw value. Handing it the option object leaves the placeholder showing.
            value={options.find(option => option.value === value)?.value}
            placeholder={placeholder}
            maxVisibleItems={9}
            closeOnSelect
            clearable
            renderOptionPrefix={prefix}
            onSearchChange={onSearchChange}
            onChange={(next: string) => onChange(next ?? "")}
        />
    </Field>;
}

function isTemplate(value: string): boolean {
    return value.includes("{{") || (value.trim().length > 0 && !/^\d{15,25}$/.test(value.trim()));
}

function ManualToggle({ manual, onToggle }: { manual: boolean; onToggle(): void; }) {
    return <button type="button" className="vc-ab-field-toggle" onClick={onToggle}>{manual ? "Pick from Discord" : "Use a variable"}</button>;
}

function guildChoices(): Choice[] {
    return [
        { label: "Direct messages", value: DM_GUILD_ID },
        ...Object.values(GuildStore.getGuilds())
            .map(guild => ({ label: guild.name, value: guild.id }))
            .sort((left, right) => left.label.localeCompare(right.label)),
    ];
}

function GuildPrefix(option: SelectOption): ReactNode {
    const id = String(option.value);
    if (id === DM_GUILD_ID) return <span className="vc-ab-option-icon vc-ab-option-fallback">DM</span>;
    const guild = GuildStore.getGuild(id);
    if (!guild) return null;
    const icon = IconUtils.getGuildIconURL({ id, icon: guild.icon ?? undefined, size: 24 });
    return icon
        ? <img className="vc-ab-option-icon" src={icon} alt="" width={24} height={24} />
        : <span className="vc-ab-option-icon vc-ab-option-fallback">{guild.name.slice(0, 2)}</span>;
}

const VOICE_TYPES: number[] = [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE];
const THREAD_TYPES: number[] = [ChannelType.PUBLIC_THREAD, ChannelType.PRIVATE_THREAD, ChannelType.ANNOUNCEMENT_THREAD];

function channelGlyph(channel: Channel): string {
    if (VOICE_TYPES.includes(channel.type)) return "🔊";
    if (THREAD_TYPES.includes(channel.type)) return "🧵";
    if (channel.type === ChannelType.GUILD_ANNOUNCEMENT) return "📣";
    if (channel.type === ChannelType.GUILD_FORUM) return "🗂";
    if (channel.isPrivate()) return "@";
    return "#";
}

function channelName(channel: Channel): string {
    if (channel.name) return channel.name;
    const [recipient] = channel.recipients;
    const user = recipient ? UserStore.getUser(recipient) : undefined;
    return user ? user.username : "Direct message";
}

function ChannelPrefix(option: SelectOption): ReactNode {
    const channel = ChannelStore.getChannel(String(option.value));
    if (!channel) return null;
    return <span className="vc-ab-option-icon vc-ab-option-glyph">{channelGlyph(channel)}</span>;
}

function channelChoices(guildId: string): Choice[] {
    if (guildId === DM_GUILD_ID) {
        return ChannelStore.getSortedPrivateChannels().map(channel => ({ label: channelName(channel), value: channel.id }));
    }
    if (!guildId) return [];
    const all = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId));
    const categories = new Map(all.filter(channel => channel.type === ChannelType.GUILD_CATEGORY).map(channel => [channel.id, channel.name]));
    return all
        .filter(channel => channel.type !== ChannelType.GUILD_CATEGORY)
        .sort((left, right) => left.position - right.position || channelName(left).localeCompare(channelName(right)))
        .map(channel => {
            const category = channel.parent_id ? categories.get(channel.parent_id) : undefined;
            return { label: category ? `${channelName(channel)}  ·  ${category}` : channelName(channel), value: channel.id };
        });
}

export function ChannelField({ label = "Channel", description, guildId, channelId, onChange }: { label?: string; description?: string; guildId: string; channelId: string; onChange(patch: { guildId?: string; channelId?: string; }): void; }) {
    const [manual, setManual] = React.useState(() => isTemplate(channelId));
    const known = channelId ? ChannelStore.getChannel(channelId) : undefined;
    const resolvedGuildId = guildId || (known ? known.guild_id || DM_GUILD_ID : "");

    if (manual) {
        return <Field label={label} description={description ?? "A channel ID, or a template such as {{lastMessage.channel_id}}."} hint={<ManualToggle manual onToggle={() => setManual(false)} />}>
            <TextInput aria-label={label} value={channelId} placeholder="Channel ID or {{variable}}" onChange={value => onChange({ channelId: value })} />
        </Field>;
    }

    return <div className="vc-ab-picker">
        <SearchField
            label="Server"
            value={resolvedGuildId}
            options={guildChoices()}
            placeholder="Choose a server"
            prefix={GuildPrefix}
            hint={<ManualToggle manual={false} onToggle={() => setManual(true)} />}
            onChange={value => onChange({ guildId: value ?? "", channelId: "" })}
        />
        <SearchField
            label={label}
            description={description}
            value={channelId}
            options={channelChoices(resolvedGuildId)}
            placeholder={resolvedGuildId ? "Choose a channel" : "Choose a server first"}
            prefix={ChannelPrefix}
            onChange={value => onChange({ guildId: resolvedGuildId, channelId: value })}
        />
    </div>;
}

function UserPrefix(option: SelectOption): ReactNode {
    const user = UserStore.getUser(String(option.value));
    if (!user) return null;
    return <img className="vc-ab-option-icon vc-ab-option-avatar" src={IconUtils.getUserAvatarURL(user, false, 24)} alt="" width={24} height={24} />;
}

function userLabel(id: string, guildId: string): string {
    const user = UserStore.getUser(id);
    if (!user) return id;
    const nick = guildId && guildId !== DM_GUILD_ID ? GuildMemberStore.getNick(guildId, id) : null;
    return nick ? `${nick}  ·  @${user.username}` : `@${user.username}`;
}

export function UserField({ label = "User", description, guildId = "", value, onChange }: { label?: string; description?: string; guildId?: string; value: string; onChange(value: string): void; }) {
    const [manual, setManual] = React.useState(() => isTemplate(value));
    const [query, setQuery] = React.useState("");
    const [remote, setRemote] = React.useState<string[]>([]);

    React.useEffect(() => {
        if (manual) return;
        return searchGuildMembers(guildId, query, setRemote);
    }, [manual, query, guildId]);

    if (manual) {
        return <Field label={label} description={description ?? "A user ID, or a template such as {{triggerUserId}}."} hint={<ManualToggle manual onToggle={() => setManual(false)} />}>
            <TextInput aria-label={label} value={value} placeholder="User ID or {{variable}}" onChange={onChange} />
        </Field>;
    }

    const ids = new Set<string>(RelationshipStore.getFriendIDs());
    // You never share a DM or a friendship with yourself, so nothing else would ever offer you.
    ids.add(UserStore.getCurrentUser().id);
    for (const channel of ChannelStore.getSortedPrivateChannels()) for (const id of channel.recipients) ids.add(id);
    if (guildId && guildId !== DM_GUILD_ID) for (const id of GuildMemberStore.getMemberIds(guildId)) ids.add(id);
    for (const id of remote) ids.add(id);
    if (value) ids.add(value);

    const options: Choice[] = [];
    for (const id of ids) if (UserStore.getUser(id) || id === value) options.push({ label: userLabel(id, guildId), value: id });
    options.sort((left, right) => left.label.localeCompare(right.label));
    // Search misses plenty of people, so a pasted ID is always usable.
    const typed = query.trim();
    if (/^\d{15,25}$/.test(typed) && !ids.has(typed)) options.unshift({ label: `Use ID ${typed}`, value: typed });

    return <SearchField
        label={label}
        description={description}
        value={value}
        options={options}
        placeholder="Search by name, or paste an ID"
        prefix={UserPrefix}
        hint={<ManualToggle manual={false} onToggle={() => setManual(true)} />}
        onSearchChange={setQuery}
        onChange={onChange}
    />;
}

/** Picks from the models OpenRouter actually serves, refreshed from its catalogue. */
export function ModelField({ label = "Model", allowDefault, value, onChange }: { label?: string; allowDefault?: boolean; value: string; onChange(value: string): void; }) {
    const [models, setModels] = React.useState<OpenRouterModel[]>(getCachedModels);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        const unsubscribe = subscribeModels(setModels);
        if (!getCachedModels().length) {
            setLoading(true);
            void loadOpenRouterModels().finally(() => setLoading(false));
        }
        return unsubscribe;
    }, []);

    const refresh = () => {
        setLoading(true);
        void loadOpenRouterModels(true).finally(() => setLoading(false));
    };

    const options: Choice[] = [
        ...(allowDefault ? [{ label: "Use the automation default", value: "" }] : []),
        ...models.map(model => ({ label: `${model.name} · ${formatModelPrice(model)}`, value: model.id })),
    ];
    // Keep a saved model selectable even if OpenRouter has since dropped it.
    if (value && !options.some(option => option.value === value)) options.unshift({ label: `${value} (not in the catalogue)`, value });

    return <>
        <SearchField
            label={label}
            value={value}
            options={options}
            placeholder={loading ? "Loading models…" : models.length ? "Search OpenRouter models" : "No models loaded"}
            onChange={onChange}
        />
        <div className="vc-ab-inline">
            <button type="button" className="vc-ab-field-toggle" onClick={refresh}>{loading ? "Refreshing…" : "Refresh model list"}</button>
            <span>{models.length ? `${models.length} models available` : "Fetched live from OpenRouter."}</span>
        </div>
    </>;
}
