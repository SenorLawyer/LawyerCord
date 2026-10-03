/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import type { UpdateChannel } from "@shared/updateChannel";
import type { ReleaseCatalog, ReleaseUpdate } from "@shared/updateRelease";
import { Margins } from "@utils/margins";
import { relaunch } from "@utils/native";
import { checkForUpdates, getReleaseCatalog, getUpdateState, isUpdating, restartRequired, selectedRelease, subscribeUpdateState, update, UpdateLogger, waitForPendingUpdate } from "@utils/updater";
import { ConfirmModal, openModal, React, SearchableSelect } from "@webpack/common";

import type { CommonProps } from "./Components";

interface Props extends CommonProps {
    channel: UpdateChannel;
    onBusyChange(value: boolean): void;
}

const channelNames = { stable: "Stable", beta: "Beta", nightly: "Nightly" };

export function Releases({ channel, repo, repoPending, onBusyChange }: Props) {
    const [catalog, setCatalog] = React.useState<ReleaseCatalog>({ releases: [], hasMore: false });
    const [page, setPage] = React.useState(1);
    const [target, setTarget] = React.useState<ReleaseUpdate>();
    const [selection, setSelection] = React.useState("latest");
    const [busy, setBusy] = React.useState(false);
    const updateState = React.useSyncExternalStore(subscribeUpdateState, getUpdateState);
    const ready = Boolean(updateState & 2);
    const updating = Boolean(updateState & 1);
    const [error, setError] = React.useState("");
    const active = React.useRef(true);
    const running = React.useRef(false);
    const currentTarget = React.useRef(target);
    currentTarget.current = target;

    async function run(action: () => Promise<void>) {
        if (!active.current || running.current || isUpdating) return;
        running.current = true;
        setBusy(true);
        setError("");
        try {
            await action();
        } catch (err) {
            UpdateLogger.error("Release selection failed", err);
            if (active.current) setError(typeof err === "object" && err !== null && "message" in err && typeof err.message === "string"
                ? err.message
                : "Could not load or install this release. Please try again.");
        } finally {
            running.current = false;
            if (active.current) {
                setBusy(false);
            }
        }
    }

    async function loadTarget(tag?: string) {
        setTarget(undefined);
        await checkForUpdates(tag);
        if (!active.current) return;
        if (tag && selectedRelease?.tag !== tag)
            throw new Error("The selected release changed during the check. Please try again.");
        setTarget(selectedRelease);
    }

    async function loadPage(nextPage: number) {
        const result = await getReleaseCatalog(nextPage);
        if (active.current) {
            setCatalog(result);
            setPage(nextPage);
        }
    }

    async function refresh() {
        const results = await Promise.allSettled([loadTarget(selection === "latest" ? undefined : selection), loadPage(page)]);
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    React.useEffect(() => {
        active.current = true;
        const pending = waitForPendingUpdate();
        if (pending) void pending.then(() => {
            if (!restartRequired) void run(refresh);
        }, () => { void run(refresh); });
        else if (!restartRequired) void run(refresh);
        return () => {
            active.current = false;
            onBusyChange(false);
        };
    }, []);

    React.useEffect(() => {
        onBusyChange(busy || updating);
    }, [busy, updating, onBusyChange]);

    const { releases } = catalog;
    const options = [
        { label: `Latest for ${channelNames[channel]}`, value: "latest" },
        ...releases.map(release => ({ label: `${release.tag} · ${channelNames[release.channel]}`, value: release.tag }))
    ];
    if (target && selection !== "latest" && !releases.some(release => release.tag === selection))
        options.push({ label: `${target.tag} · ${channelNames[target.channel]}`, value: target.tag });

    const disabled = busy || ready || updating;
    const action = target?.relation === "rollback" ? "Roll back" : target?.relation === "switch" ? "Switch" : "Update";

    function install() {
        if (!target || target.relation === "current" || disabled) return;
        const release = target;
        const apply = () => run(async () => {
            if (currentTarget.current !== release) return;
            if (!await update(release.tag)) throw new Error("The release was not installed. Check for updates and try again.");
        });
        if (release.relation === "rollback" || release.relation === "switch") {
            openModal(props => <ConfirmModal
                {...props}
                title={`${action} to ${release.tag}?`}
                confirmText={`${action} and download`}
                cancelText="Cancel"
                onConfirm={apply}
            >
                <Paragraph>This will replace v{release.currentVersion} with {release.tag}. Restart Discord after the download to apply it.</Paragraph>
                {release.relation === "rollback" && <Paragraph className={Margins.top8}>Older versions may not support settings or data created by your current version.</Paragraph>}
                {Number(release.currentVersion.split(".")[0]) >= 4 && release.version && Number(release.version.split(".")[0]) < 4 && <Paragraph className={Margins.top8}>Versions before 4 cannot read your current per-track lyrics history. That history is retained for when you return to version 4 or later.</Paragraph>}
                {release.version && Number(release.version.split(".")[0]) < 3 && <Paragraph className={Margins.top8}>Before installing a version older than 3, disable scheduled messages and voice auto rejoin, then review those settings in the older version.</Paragraph>}
                {!release.version && <Paragraph className={Margins.top8}>This Nightly release does not declare its version. Builds before version 4 cannot read newer per-track lyrics history, which is retained. If this build predates version 3, disable scheduled messages and voice auto rejoin before installing it.</Paragraph>}
            </ConfirmModal>);
        } else {
            void apply();
        }
    }

    return <Flex flexDirection="column" gap="12px">
        <Paragraph>Choose the latest release allowed by your channel, or any specific published version. Installing a version keeps your automatic update channel unchanged.</Paragraph>
        <SearchableSelect
            options={options}
            value={selection}
            placeholder="Choose a release"
            isDisabled={disabled}
            closeOnSelect
            onChange={(tag: string) => {
                if (disabled) return;
                setSelection(tag);
                void run(() => loadTarget(tag === "latest" ? undefined : tag));
            }}
        />
        <Flex gap="8px" flexWrap="wrap">
            <Button disabled={disabled} onClick={() => run(refresh)}>{busy ? "Loading…" : error ? "Retry" : "Check for Updates"}</Button>
            {page > 1 && <Button variant="secondary" disabled={disabled} onClick={() => run(() => loadPage(page - 1))}>Newer releases</Button>}
            {catalog.hasMore && <Button variant="secondary" disabled={disabled} onClick={() => run(() => loadPage(page + 1))}>Older releases</Button>}
        </Flex>
        {error && <Card variant="warning"><Paragraph>{error}</Paragraph></Card>}
        {!busy && !error && !ready && !releases.length && <Paragraph>No published versions were found on this page.</Paragraph>}
        {target && !ready && <Card>
            <Paragraph>Current version: v{target.currentVersion}</Paragraph>
            <Paragraph className={Margins.top8}>Target: {target.tag} · {channelNames[target.channel]}</Paragraph>
            <Paragraph className={Margins.top8}>
                <Link href={`${repo}/releases/tag/${encodeURIComponent(target.tag)}`} disabled={repoPending}>Release notes</Link>
            </Paragraph>
            {target.relation === "current"
                ? <Paragraph className={Margins.top8}>This release is already installed.</Paragraph>
                : <Button className={Margins.top16} disabled={disabled} onClick={install}>
                    {action} to {selection === "latest" ? `latest ${channelNames[target.channel]}` : target.tag}
                </Button>}
        </Card>}
        {ready && <Card variant="brand">
            <Paragraph>{selectedRelease ? `${selectedRelease.tag} is downloaded.` : "The release is downloaded."} Restart Discord to finish installing it.</Paragraph>
            <Button className={Margins.top16} onClick={relaunch}>Restart Discord</Button>
        </Card>}
    </Flex>;
}
