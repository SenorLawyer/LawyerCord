/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { CLIENT_EVENT_TYPES, CLIENT_EVENTS, type ClientEventType, isClientEventType } from "./clientEvents";
import { ChannelField, GuildField, NumberField, SelectField, UserField } from "./fields";

interface EventFilter {
    authorId?: string;
    channelId?: string;
    guildId?: string;
    status?: string;
    timeoutSeconds?: number;
}

interface Props {
    type: ClientEventType;
    filter: EventFilter;
    choose?: boolean;
    wait?: boolean;
    onTypeChange?(type: ClientEventType): void;
    onChange(filter: Partial<EventFilter>): void;
}

export function ClientEventFields({ type, filter, choose, wait, onTypeChange, onChange }: Props) {
    const definition = CLIENT_EVENTS[type];
    return <>
        {choose && <SelectField label="Discord event" value={type} options={CLIENT_EVENT_TYPES.map(value => ({ value, label: CLIENT_EVENTS[value].label }))} onChange={value => { if (isClientEventType(value)) onTypeChange?.(value); }} />}
        <span className="vc-ab-field-description">{definition.description}</span>
        {definition.channel && <ChannelField label="Only in this channel" guildId={filter.guildId ?? ""} channelId={filter.channelId ?? ""} onChange={onChange} description="Leave empty for any channel." />}
        {type === "member-update" && <GuildField value={filter.guildId ?? ""} onChange={guildId => onChange({ guildId })} />}
        {definition.user && <UserField label="Only this person" value={filter.authorId ?? ""} guildId={filter.guildId} description="Leave empty for anyone whose updates reach this client." onChange={authorId => onChange({ authorId })} />}
        {type === "presence-update" && <SelectField label="Status after update" value={filter.status ?? ""} options={[{ label: "Any status or activity update", value: "" }, { label: "Online", value: "online" }, { label: "Idle", value: "idle" }, { label: "Do not disturb", value: "dnd" }, { label: "Offline or invisible", value: "offline" }]} onChange={status => onChange({ status: String(status) })} />}
        {wait && <NumberField label="Give up after (seconds)" value={filter.timeoutSeconds ?? 60} min={1} max={86400} onChange={timeoutSeconds => onChange({ timeoutSeconds })} />}
    </>;
}
