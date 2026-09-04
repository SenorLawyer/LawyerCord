/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./builder.css";
import "./styles.css";

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { ClockIcon, CloudDownloadIcon, CloudUploadIcon, DeleteIcon, PlusIcon, RobotIcon } from "@components/Icons";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { openInviteModal } from "@utils/discord";
import { chooseFile, saveFile } from "@utils/web";
import { Alerts, Checkbox, GuildStore, IconUtils, React, showToast, TextInput, Toasts } from "@webpack/common";

import { openAutomationBuilder } from "./BuilderModal";
import {
    deleteAutomation,
    getAutomationNextRunAt,
    getAutomationSnapshot,
    loadAutomationState,
    parseImportedAutomation,
    refreshGuildReferences,
    replaceAutomations,
    runAutomation,
    setAutomationEnabled,
    subscribeAutomationState,
    upsertAutomation,
} from "./engine";
import { ModelField } from "./fields";
import { type Automation, AUTOMATIONS_UI_VERSION, createAutomation, createAutomationFile, duplicateAutomation, formatSchedule } from "./model";
import {
    clearOpenRouterKey,
    DEFAULT_AI_SETTINGS,
    getAutomationAISettings,
    getOpenRouterStatus,
    setAutomationAISettings,
    setOpenRouterKey,
} from "./openRouter";

function useAutomationState() {
    const [, forceUpdate] = React.useState(0);
    React.useEffect(() => {
        const unsubscribe = subscribeAutomationState(() => forceUpdate(value => value + 1));
        void loadAutomationState();
        return unsubscribe;
    }, []);
    const snapshot = getAutomationSnapshot();
    React.useEffect(() => {
        if (snapshot.loaded) void refreshGuildReferences();
    }, [snapshot.loaded]);
    return snapshot;
}

function formatDate(timestamp: number | null): string {
    return timestamp === null ? "Not scheduled" : new Date(timestamp).toLocaleString();
}

function formatTrigger(automation: Automation): string {
    if (automation.trigger.type === "schedule") return formatSchedule(automation.schedule);
    if (automation.trigger.type === "mention") return "When you are mentioned";
    if (automation.trigger.type === "message") return "When a message matches";
    if (automation.trigger.type === "dm") return "When a DM matches";
    return "When LawyerCord starts";
}

function AutomationCard({ automation }: { automation: Automation; }) {
    const nextRun = getAutomationNextRunAt(automation);
    const run = async () => {
        const result = await runAutomation(automation.id);
        showToast(result.success ? "Automation completed." : result.error || "Automation failed.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
    };
    const duplicate = async () => {
        const copy = duplicateAutomation(automation);
        await upsertAutomation(copy);
        showToast(`Copied to ${copy.name}.`, Toasts.Type.SUCCESS);
        openAutomationBuilder(copy);
    };
    const remove = () => Alerts.show({
        title: "Delete automation",
        body: `Delete ${automation.name || "this automation"}? This also removes its local run logs.`,
        confirmText: "Delete",
        cancelText: "Cancel",
        onConfirm: () => void deleteAutomation(automation.id),
    });

    return <article className="vc-automations-card"><div className="vc-automations-card-main"><div className="vc-automations-card-icon"><ClockIcon width={22} height={22} /></div><div className="vc-automations-card-copy"><div className="vc-automations-card-title"><strong>{automation.name || "Untitled automation"}</strong><span className={automation.enabled ? "vc-automations-status-enabled" : "vc-automations-status-disabled"}>{automation.enabled ? "Enabled" : "Disabled"}</span></div><div className="vc-automations-card-meta">{formatTrigger(automation)} · {automation.blocks.length} block{automation.blocks.length === 1 ? "" : "s"}{nextRun === null ? "" : ` · Next run: ${formatDate(nextRun)}`}</div>{automation.lastStatus && <div className="vc-automations-card-meta">Last run: {formatDate(automation.lastRunAt ?? null)} · {automation.lastStatus}</div>}</div></div><div className="vc-automations-card-actions"><Checkbox value={automation.enabled} onChange={(_event, enabled) => void setAutomationEnabled(automation.id, enabled)} /><Button size="small" variant="secondary" onClick={() => openAutomationBuilder(automation)}>Open builder</Button><Button size="small" variant="secondary" onClick={() => void run()}>Run now</Button><Button size="small" variant="secondary" onClick={() => void duplicate()}>Duplicate</Button><Button size="iconOnly" variant="dangerSecondary" aria-label={`Delete ${automation.name}`} onClick={remove}><DeleteIcon width={16} height={16} /></Button></div></article>;
}

function LogsPanel({ logs }: { logs: ReturnType<typeof getAutomationSnapshot>["logs"]; }) {
    const runs = logs.filter(log => !log.blockId);
    const blockLogs = logs.filter(log => log.blockId);
    return <section className="vc-automations-panel-section"><div className="vc-automations-section-heading"><div><Heading tag="h2">Run logs</Heading><Paragraph>Recent runs and block-level failures stay on this device.</Paragraph></div></div>{logs.length === 0 ? <div className="vc-automations-muted">No automation runs yet.</div> : <div className="vc-automations-log-layout"><div className="vc-automations-log-list">{runs.map(log => <div className="vc-automations-log-row" key={log.id}><span className={`vc-automations-log-dot ${log.status}`} /><div><strong>{log.automationName}</strong><div>{log.message}</div></div><time dateTime={new Date(log.timestamp).toISOString()}>{new Date(log.timestamp).toLocaleString()}</time></div>)}</div>{blockLogs.length > 0 && <details className="vc-automations-block-log-details"><summary className="vc-automations-block-log-summary">Show {blockLogs.length} block events</summary><div className="vc-automations-log-list">{blockLogs.map(log => <div className="vc-automations-log-row" key={log.id}><span className={`vc-automations-log-dot ${log.status}`} /><div><strong>{log.blockLabel || "Block"}</strong><div>{log.message}{log.durationMs !== undefined ? ` · ${log.durationMs} ms` : ""}</div></div><time dateTime={new Date(log.timestamp).toISOString()}>{new Date(log.timestamp).toLocaleTimeString()}</time></div>)}</div></details>}</div>}</section>;
}

function GuildPanel({ guilds }: { guilds: ReturnType<typeof getAutomationSnapshot>["guilds"]; }) {
    if (guilds.length === 0) return null;
    return <section className="vc-automations-panel-section"><div className="vc-automations-section-heading"><div><Heading tag="h2">Referenced servers</Heading><Paragraph>Imported workflows show everything Discord can resolve before you run them.</Paragraph></div></div><div className="vc-automations-guild-list">{guilds.map(reference => {
        const cached = reference.available ? GuildStore.getGuild(reference.id) : undefined;
        const icon = IconUtils.getGuildIconURL({ id: reference.id, icon: reference.icon ?? undefined, size: 64 });
        const banner = cached ? IconUtils.getGuildBannerURL(cached, true) : null;
        return <article className="vc-automations-guild-card" key={reference.id}>{banner && <img className="vc-automations-guild-banner" src={banner} alt="" />}<div className="vc-automations-guild-content">{icon ? <img className="vc-automations-guild-icon" src={icon} alt="" /> : <div className="vc-automations-guild-icon vc-automations-guild-icon-fallback">?</div>}<div className="vc-automations-guild-copy"><strong>{reference.name || "Unknown server"}</strong><span>{reference.id}</span>{reference.error && <em>{reference.error}</em>}</div>{reference.inviteCode && <Button size="small" variant="secondary" onClick={() => void openInviteModal(reference.inviteCode ?? "")}>Join server</Button>}</div></article>;
    })}</div></section>;
}

async function importAutomationFile(current: ReturnType<typeof getAutomationSnapshot>): Promise<void> {
    const file = await chooseFile(".lawyerautomation,application/json");
    if (!file) return;
    try {
        if (file.size > 2_000_000) throw new Error("Automation files must be smaller than 2 MB.");
        const imported = parseImportedAutomation(JSON.parse(await file.text()) as unknown);
        const now = Date.now();
        // duplicateAutomation remaps every edge onto the new block ids. Handing out fresh ids
        // without that leaves the whole graph pointing at blocks that no longer exist.
        const copies = imported.automations.map(value => ({
            ...duplicateAutomation(value, `${value.name} (imported)`),
            createdAt: now,
            updatedAt: now,
        }));
        await replaceAutomations([...current.automations, ...copies]);
        await refreshGuildReferences([...current.guilds, ...imported.guilds]);
        showToast(`Imported ${copies.length} automation${copies.length === 1 ? "" : "s"}.`, Toasts.Type.SUCCESS);
    } catch (error) {
        showToast(error instanceof Error ? error.message : "That automation file could not be imported.", Toasts.Type.FAILURE);
    }
}

function exportAutomationFile(current: ReturnType<typeof getAutomationSnapshot>): void {
    saveFile(new File([JSON.stringify(createAutomationFile(current.automations, current.guilds), null, 2)], "lawyercord-automations.lawyerautomation", { type: "application/json" }));
    showToast("Automation file exported.", Toasts.Type.SUCCESS);
}

function AISettingsPanel() {
    const [key, setKey] = React.useState("");
    const [configured, setConfigured] = React.useState(false);
    const [available, setAvailable] = React.useState(true);
    const [error, setError] = React.useState("");
    const [settings, setSettings] = React.useState(DEFAULT_AI_SETTINGS);
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        void Promise.all([getOpenRouterStatus(), getAutomationAISettings()]).then(([status, saved]) => {
            if (!active) return;
            setConfigured(status.configured);
            setAvailable(status.available);
            setError(status.error ?? "");
            setSettings(saved);
        });
        return () => { active = false; };
    }, []);

    const saveKey = async () => {
        setSaving(true);
        const result = await setOpenRouterKey(key);
        setSaving(false);
        if (!result.success) return showToast(result.error || "The OpenRouter key could not be saved.", Toasts.Type.FAILURE);
        setKey("");
        setConfigured(true);
        showToast("OpenRouter key saved in encrypted operating system storage.", Toasts.Type.SUCCESS);
    };
    const removeKey = async () => {
        const result = await clearOpenRouterKey();
        if (!result.success) return showToast(result.error || "The OpenRouter key could not be removed.", Toasts.Type.FAILURE);
        setConfigured(false);
        showToast("OpenRouter key removed.", Toasts.Type.SUCCESS);
    };
    const saveDefaults = async () => {
        await setAutomationAISettings(settings);
        showToast("AI defaults saved.", Toasts.Type.SUCCESS);
    };

    return <section className="vc-automations-panel-section vc-automations-ai-settings"><div className="vc-automations-section-heading"><div><Heading tag="h2">OpenRouter</Heading><Paragraph>Configure the shared AI connection used by every AI block.</Paragraph></div><span className={configured ? "vc-automations-status-enabled" : "vc-automations-status-disabled"}>{configured ? "Connected" : "Not configured"}</span></div><div className="vc-automations-ai-grid"><div className="vc-automations-field"><span className="vc-automations-field-label">API key</span><span className="vc-automations-field-description">The key is encrypted by the operating system and never returned to the page.</span><TextInput type="password" aria-label="OpenRouter API key" value={key} placeholder={configured ? "Saved securely" : "sk-or-v1-…"} onChange={setKey} /></div><div className="vc-automations-inline-actions"><Button size="small" disabled={!available || saving || key.trim().length < 20} onClick={() => void saveKey()}>Save key</Button>{configured && <Button size="small" variant="dangerSecondary" onClick={() => void removeKey()}>Remove key</Button>}<span>{error || (available ? "Available on Discord Desktop." : "Secure storage is unavailable.")}</span></div><div className="vc-automations-field"><ModelField label="Default model" value={settings.defaultModel} onChange={defaultModel => setSettings({ ...settings, defaultModel })} /></div><div className="vc-automations-form-grid"><div className="vc-automations-field"><span className="vc-automations-field-label">Maximum output tokens</span><TextInput type="number" value={String(settings.maxTokens)} onChange={value => setSettings({ ...settings, maxTokens: Math.min(4_096, Math.max(16, Number(value) || 16)) })} /></div><div className="vc-automations-field"><span className="vc-automations-field-label">Temperature</span><TextInput type="number" value={String(settings.temperature)} onChange={value => setSettings({ ...settings, temperature: Math.min(2, Math.max(0, Number(value) || 0)) })} /></div></div><Button size="small" variant="secondary" onClick={() => void saveDefaults()}>Save AI defaults</Button></div></section>;
}

function AutomationsTab() {
    const current = useAutomationState();

    return <SettingsTab><div className="vc-automations-page-heading"><div><Heading tag="h1">Automations v{AUTOMATIONS_UI_VERSION}</Heading><Paragraph>Build, schedule, and inspect Discord workflows without leaving the client.</Paragraph></div><ClockIcon width={42} height={42} /></div><Notice.Info className="vc-automations-info">Automations run locally as the currently signed-in account. Review imported workflows before enabling them.</Notice.Info><div className="vc-automations-toolbar"><Button onClick={() => openAutomationBuilder(createAutomation())}><PlusIcon width={16} height={16} />New automation</Button><Button variant="secondary" onClick={() => void importAutomationFile(current)}><CloudUploadIcon width={16} height={16} />Import</Button><Button variant="secondary" onClick={() => exportAutomationFile(current)}><CloudDownloadIcon width={16} height={16} />Export all</Button></div><AISettingsPanel /><section className="vc-automations-panel-section"><div className="vc-automations-section-heading"><div><Heading tag="h2">Your automations</Heading><Paragraph>Run on a schedule, at startup, or when matching Discord messages arrive.</Paragraph></div><span className="vc-automations-count">{current.automations.length}</span></div>{!current.loaded ? <div className="vc-automations-muted">Loading automations…</div> : current.automations.length === 0 ? <div className="vc-automations-empty-state"><RobotIcon width={28} height={28} /><strong>No automations yet</strong><span>Drag blocks onto the grid and connect them to build a workflow.</span></div> : <div className="vc-automations-card-list">{current.automations.map(automation => <AutomationCard key={automation.id} automation={automation} />)}</div>}</section><GuildPanel guilds={current.guilds} /><LogsPanel logs={current.logs} /></SettingsTab>;
}

export default wrapTab(AutomationsTab, "Automations");
