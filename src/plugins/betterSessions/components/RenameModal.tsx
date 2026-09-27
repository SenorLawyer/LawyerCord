/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { TextButton } from "@components/Button";
import { Heading } from "@components/Heading";
import { SessionInfo } from "@plugins/betterSessions/types";
import { getDefaultName, savedSessionsCache, saveSessionsToDataStore } from "@plugins/betterSessions/utils";
import { Logger } from "@utils/Logger";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, showToast, TextInput, Toasts, UserStore } from "@webpack/common";
import type { KeyboardEvent } from "react";

const logger = new Logger("BetterSessions");

export function RenameModal({ props, session, state }: { props: RenderModalProps, session: SessionInfo["session"], state: [string, React.Dispatch<React.SetStateAction<string>>]; }) {
    const [userId] = React.useState(() => UserStore.getCurrentUser()?.id);
    const [, setTitle] = state;
    const [value, setValue] = React.useState(savedSessionsCache.get(session.id_hash)?.name ?? "");

    const saving = React.useRef(false);

    async function onSaveClick() {
        if (saving.current) return;
        if (!userId || UserStore.getCurrentUser()?.id !== userId) return props.onClose();
        saving.current = true;
        const previous = savedSessionsCache.get(session.id_hash);
        const updated = { name: value, isNew: false };
        const sessions = new Map(savedSessionsCache);
        sessions.set(session.id_hash, updated);
        try {
            await saveSessionsToDataStore(sessions);
        } catch (error) {
            logger.warn("Failed to save session name", error);
            showToast("Could not save the session name. Try again.", Toasts.Type.FAILURE);
            return;
        } finally {
            saving.current = false;
        }
        if (UserStore.getCurrentUser()?.id !== userId) return props.onClose();
        if (savedSessionsCache.get(session.id_hash) === previous) {
            savedSessionsCache.set(session.id_hash, updated);
            setTitle(value ? `${value}*` : getDefaultName(session.client_info));
        }
        props.onClose();
    }

    return (
        <Modal
            {...props}
            title="Rename"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: () => props.onClose()
                },
                {
                    text: "Save",
                    variant: "primary",
                    onClick: onSaveClick
                }
            ]}
        >
            <div>
                <Heading tag="h5">New device name</Heading>
                <TextInput
                    style={{ marginBottom: "10px" }}
                    placeholder={getDefaultName(session.client_info)}
                    value={value}
                    onChange={setValue}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") {
                            void onSaveClick();
                        }
                    }}
                />
                <TextButton
                    style={{
                        paddingLeft: "1px",
                        opacity: 0.6
                    }}
                    onClick={() => setValue("")}
                >
                    Reset Name
                </TextButton>
            </div>
        </Modal>
    );
}
