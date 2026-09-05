/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./builder.css";
import "./styles.css";

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { CloudDownloadIcon, CloudUploadIcon, PlusIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { AddonCard } from "@components/settings/AddonCard";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SpecialCard } from "@components/settings/SpecialCard";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { openInviteModal } from "@utils/discord";
import { Margins } from "@utils/margins";
import { chooseFile, saveFile } from "@utils/web";
import { Alerts, ContextMenuApi, GuildStore, IconUtils, Menu, moment, React, showToast, TextInput, Toasts } from "@webpack/common";

import { BLOCK_ICONS, blockDefinition, describeTrigger } from "./blocks";
import { openAutomationBuilder } from "./BuilderModal";
import {
    deleteAutomation,
    discardAutomationDraft,
    getAutomationNextRunAt,
    getAutomationSnapshot,
    loadAutomationState,
    parseImportedAutomation,
    refreshGuildReferences,
    replaceAutomations,
    runAutomation,
    setAutomationEnabled,
    setAutomationRunLimit,
    setAutomationSystemEnabled,
    subscribeAutomationState,
    upsertAutomation,
} from "./engine";
import { ModelField, NumberField } from "./fields";
import { type Automation, createAutomation, createAutomationFile, duplicateAutomation, type GuildReference } from "./model";
import {
    clearOpenRouterKey,
    DEFAULT_AI_SETTINGS,
    getAutomationAISettings,
    getOpenRouterStatus,
    setAutomationAISettings,
    setOpenRouterKey,
} from "./openRouter";
import { RunHistory } from "./RunHistory";
import { createTemplate, TEMPLATE_DESCRIPTIONS, TEMPLATE_NAMES } from "./templates";
import { duplicateWorkflows } from "./workflow";

function useAutomationState() {
    const snapshot = React.useSyncExternalStore(subscribeAutomationState, getAutomationSnapshot);
    React.useEffect(() => { void loadAutomationState(); }, []);
    return snapshot;
}

function exportAutomations(automations: Automation[], guilds: GuildReference[], filename: string): void {
    saveFile(new File([JSON.stringify(createAutomationFile(automations, guilds), null, 2)], filename, { type: "application/json" }));
    showToast(automations.length === 1 ? `Saved ${automations[0].name} to a file.` : "Saved every automation to a file.", Toasts.Type.SUCCESS);
}

function AutomationCard({ automation, guilds }: { automation: Automation; guilds: GuildReference[]; }) {
    const nextRun = getAutomationNextRunAt(automation);
    const steps = automation.blocks.length;
    const run = async () => {
        const result = await runAutomation(automation.id);
        showToast(result.success ? "Run finished." : result.error || "The run failed.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
    };
    const duplicate = async () => {
        const copy = duplicateAutomation(automation);
        await upsertAutomation(copy);
        showToast(`Made a copy called ${copy.name}.`, Toasts.Type.SUCCESS);
        openAutomationBuilder(copy);
    };
    const remove = () => Alerts.show({
        title: "Delete this automation?",
        body: `${automation.name || "This automation"} and its run history will be gone for good.`,
        confirmText: "Delete",
        cancelText: "Keep it",
        onConfirm: () => void deleteAutomation(automation.id),
    });
    const openMenu = (event: React.MouseEvent) => ContextMenuApi.openContextMenu(event, () => <Menu.Menu navId={`vc-automation-${automation.id}`} onClose={ContextMenuApi.closeContextMenu} aria-label="More actions">
        <Menu.MenuItem id="run" label="Run now" action={() => void run()} />
        <Menu.MenuItem id="duplicate" label="Make a copy" action={() => void duplicate()} />
        <Menu.MenuItem id="export" label="Save to a file" action={() => exportAutomations([automation], guilds, `${automation.name || "automation"}.lawyerautomation`)} />
        <Menu.MenuSeparator />
        <Menu.MenuItem id="delete" label="Delete" color="danger" action={remove} />
    </Menu.Menu>);

    const status = automation.lastStatus
        ? <><span className={`vc-automations-dot ${automation.lastStatus}`} />{automation.lastStatus === "success" ? "Worked" : "Failed"} {moment(automation.lastRunAt ?? 0).fromNow()}</>
        : <><span className="vc-automations-dot" />Has not run yet</>;

    return <AddonCard
        name={automation.name || "Untitled automation"}
        description={`${describeTrigger(automation)} · ${steps === 0 ? "no steps yet" : `${steps} step${steps === 1 ? "" : "s"}`}`}
        enabled={automation.enabled}
        setEnabled={enabled => void setAutomationEnabled(automation.id, enabled)}
        infoButton={<div className="vc-automations-card-buttons">
            <Button size="small" onClick={() => openAutomationBuilder(automation)}>Edit</Button>
            <Button size="small" variant="secondary" aria-label="More actions" onClick={openMenu}>⋯</Button>
        </div>}
        footer={<span className="vc-automations-card-status">{status}{automation.enabled && nextRun !== null && <> · Next {moment(nextRun).fromNow()}</>}</span>}
    />;
}

function DraftCard({ draft }: { draft: Automation; }) {
    return <AddonCard
        name={draft.name || "Untitled automation"}
        description={`Unfinished draft · ${draft.blocks.length} step${draft.blocks.length === 1 ? "" : "s"}`}
        enabled={false}
        setEnabled={() => openAutomationBuilder(draft)}
        disabled
        infoButton={<div className="vc-automations-card-buttons">
            <Button size="small" onClick={() => openAutomationBuilder(draft)}>Continue</Button>
            <Button size="small" variant="dangerSecondary" onClick={() => void discardAutomationDraft(draft.id)}>Discard</Button>
        </div>}
        footer={<span className="vc-automations-card-status"><span className="vc-automations-dot" />Not saved yet</span>}
    />;
}

function GuildPanel({ guilds }: { guilds: GuildReference[]; }) {
    if (guilds.length === 0) return null;
    return <>
        <Heading className={Margins.top16}>Servers these automations use</Heading>
        <Paragraph className={Margins.bottom16}>Imported automations list every server they need, so you can join any you are missing.</Paragraph>
        <div className="vc-automations-guild-list">{guilds.map(reference => {
            const cached = reference.available ? GuildStore.getGuild(reference.id) : undefined;
            const icon = IconUtils.getGuildIconURL({ id: reference.id, icon: reference.icon ?? undefined, size: 64 });
            const banner = cached ? IconUtils.getGuildBannerURL(cached, true) : null;
            return <article className="vc-automations-guild-card" key={reference.id}>{banner && <img className="vc-automations-guild-banner" src={banner} alt="" />}<div className="vc-automations-guild-content">{icon ? <img className="vc-automations-guild-icon" src={icon} alt="" /> : <div className="vc-automations-guild-icon vc-automations-guild-icon-fallback">?</div>}<div className="vc-automations-guild-copy"><strong>{reference.name || "Unknown server"}</strong><span>{reference.available ? "You are in this server" : reference.error || "You are not in this server"}</span></div>{reference.inviteCode && <Button size="small" variant="secondary" onClick={() => void openInviteModal(reference.inviteCode ?? "")}>Join</Button>}</div></article>;
        })}</div>
    </>;
}

async function importAutomationFile(current: ReturnType<typeof getAutomationSnapshot>): Promise<void> {
    const file = await chooseFile(".lawyerautomation,application/json");
    if (!file) return;
    try {
        if (file.size > 2_000_000) throw new Error("Automation files must be smaller than 2 MB.");
        const imported = parseImportedAutomation(JSON.parse(await file.text()) as unknown);
        const now = Date.now();
        // duplicateWorkflows remaps every edge onto the new block ids. Handing out fresh ids
        // without that leaves the whole graph pointing at blocks that no longer exist.
        const copies = duplicateWorkflows(imported.automations).map(value => ({ ...value, name: `${value.name} (imported)`, createdAt: now, updatedAt: now }));
        await replaceAutomations([...current.automations, ...copies]);
        await refreshGuildReferences([...current.guilds, ...imported.guilds]);
        showToast(`Imported ${copies.length} automation${copies.length === 1 ? "" : "s"}. They start turned off.`, Toasts.Type.SUCCESS);
    } catch (error) {
        showToast(error instanceof Error ? error.message : "That automation file could not be imported.", Toasts.Type.FAILURE);
    }
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
        showToast("OpenRouter key saved in your operating system's encrypted storage.", Toasts.Type.SUCCESS);
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

    return <>
        <Heading className={Margins.top16}>AI blocks <span className={`vc-automations-badge ${configured ? "on" : ""}`}>{configured ? "Connected" : "Not connected"}</span></Heading>
        <Paragraph className={Margins.bottom16}>AI blocks talk to OpenRouter. Paste an API key from openrouter.ai once and every AI block can use it.</Paragraph>
        <div className="vc-automations-panel">
            <div className="vc-automations-field">
                <span className="vc-automations-field-label">API key</span>
                <div className="vc-automations-inline">
                    <TextInput type="password" aria-label="OpenRouter API key" value={key} placeholder={configured ? "A key is saved. Paste a new one to replace it." : "sk-or-v1-…"} onChange={setKey} />
                    <Button size="small" disabled={!available || saving || key.trim().length < 20} onClick={() => void saveKey()}>Save key</Button>
                    {configured && <Button size="small" variant="dangerSecondary" onClick={() => void removeKey()}>Remove</Button>}
                </div>
                <span className="vc-automations-field-description">{error || (available ? "The key is encrypted by Windows and never shown again." : "Secure storage is unavailable, so keys cannot be saved here.")}</span>
            </div>
            <ModelField label="Default model" value={settings.defaultModel} onChange={defaultModel => setSettings({ ...settings, defaultModel })} />
            <div className="vc-automations-grid">
                <NumberField label="Maximum output tokens" value={settings.maxTokens} min={16} max={4_096} onChange={maxTokens => setSettings({ ...settings, maxTokens })} />
                <NumberField label="Temperature" description="0 is predictable, 2 is wild." value={settings.temperature} min={0} max={2} onChange={temperature => setSettings({ ...settings, temperature })} />
            </div>
            <div><Button size="small" variant="secondary" onClick={() => void saveDefaults()}>Save AI defaults</Button></div>
        </div>
    </>;
}

function AutomationsTab() {
    const current = useAutomationState();
    const [query, setQuery] = React.useState("");
    const normalized = query.trim().toLowerCase();
    const matches = current.automations.filter(a => a.name.toLowerCase().includes(normalized));
    const drafts = current.drafts.filter(draft => !current.automations.some(a => a.id === draft.id) && draft.name.toLowerCase().includes(normalized));
    const on = current.automations.filter(a => a.enabled).length;

    return <SettingsTab>
        <FormSwitch title="Enable automations" value={current.systemEnabled} disabled={!current.loaded}
            description={!current.systemEnabled ? "Off. Runs are stopped and event listeners are detached. You can still edit and test workflows." : !on ? "Idle. No automations are turned on, so no trigger listeners or polling are active." : current.runs.some(run => run.status === "running") ? "Running. Turning this off cancels all runs." : "Idle. Only triggers used by enabled automations are monitored."}
            onChange={value => void setAutomationSystemEnabled(value).catch(error => showToast(String(error), Toasts.Type.FAILURE))} />
        <SpecialCard
            title="Automations"
            subtitle="Let Discord work for you"
            description="Pick when an automation should start, then add the steps it should take. Templates below are a good place to start."
            backgroundColor="#a3b4e8"
        >
            <Button variant="none" size="medium" className="vc-automations-hero-button" onClick={() => openAutomationBuilder(createAutomation())}><PlusIcon width={20} height={20} />Create an automation</Button>
        </SpecialCard>

        <Heading className={Margins.top16}>Quick Actions</Heading>
        <Paragraph className={Margins.bottom16}>Create a new automation, or move automations between computers as files. A file can hold one automation or all of them.</Paragraph>
        <QuickActionCard>
            <QuickAction Icon={PlusIcon} text="New automation" action={() => openAutomationBuilder(createAutomation())} />
            <QuickAction Icon={CloudUploadIcon} text="Import from file" action={() => void importAutomationFile(current)} />
            <QuickAction Icon={CloudDownloadIcon} text="Export all to file" disabled={!current.automations.length} action={() => exportAutomations(current.automations, current.guilds, "lawyercord-automations.lawyerautomation")} />
        </QuickActionCard>

        <Divider className={Margins.top20} />

        <div className="vc-automations-section-head">
            <div>
                <Heading className={Margins.top16}>Your automations</Heading>
                <Paragraph className={Margins.bottom16}>{current.automations.length ? `${on} of ${current.automations.length} turned on. Use the switch to turn one on or off, and the ⋯ menu for more.` : "Nothing here yet. Create one above or start from a template."}</Paragraph>
            </div>
            {current.automations.length > 3 && <TextInput aria-label="Search automations" placeholder="Search…" value={query} onChange={setQuery} />}
        </div>
        {!current.loaded
            ? <Paragraph>Loading…</Paragraph>
            : !matches.length && !drafts.length
                ? query && <Paragraph>Nothing matches that search.</Paragraph>
                : <div className="vc-automations-grid-cards">
                    {matches.map(automation => <AutomationCard key={automation.id} automation={automation} guilds={current.guilds} />)}
                    {drafts.map(draft => <DraftCard key={draft.id} draft={draft} />)}
                </div>}

        <Divider className={Margins.top20} />

        <Heading className={Margins.top16}>Start from a template</Heading>
        <Paragraph className={Margins.bottom16}>A ready-made automation you can change however you like.</Paragraph>
        <div className="vc-automations-grid-cards">
            {TEMPLATE_NAMES.map(name => {
                const template = createTemplate(name);
                const { category } = blockDefinition(template.blocks[0].type);
                const Icon = BLOCK_ICONS[category];
                return <button type="button" className={`vc-automations-template ${category}`} key={name} onClick={() => openAutomationBuilder(createTemplate(name))}>
                    <span className="vc-automations-template-icon"><Icon width={18} height={18} /></span>
                    <span className="vc-automations-template-copy"><strong>{name}</strong><span>{TEMPLATE_DESCRIPTIONS[name]}</span></span>
                </button>;
            })}
        </div>

        <Divider className={Margins.top20} />

        <Heading className={Margins.top16}>Recent runs</Heading>
        <Paragraph className={Margins.bottom16}>What your automations did, newest first. Open one to see every step.</Paragraph>
        <RunHistory current={current} />

        <Divider className={Margins.top20} />

        <AISettingsPanel />
        <Heading className={Margins.top16}>Limits</Heading>
        <Paragraph className={Margins.bottom16}>How many automations may run at the same time across everything.</Paragraph>
        <div className="vc-automations-panel"><NumberField label="Runs at the same time" value={current.globalLimit} min={1} max={32} onChange={value => void setAutomationRunLimit(value)} /></div>
        <GuildPanel guilds={current.guilds} />
    </SettingsTab>;
}

export default wrapTab(AutomationsTab, "Automations");
