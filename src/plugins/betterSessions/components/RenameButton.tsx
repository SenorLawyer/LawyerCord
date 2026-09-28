/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { SavedSession, SessionInfo } from "@plugins/betterSessions/types";
import { cl } from "@plugins/betterSessions/utils";
import { openModal } from "@webpack/common";

import { RenameModal } from "./RenameModal";

interface RenameButtonProps {
    session: SessionInfo["session"];
    state: [SavedSession, React.Dispatch<React.SetStateAction<SavedSession>>];
    disabled: boolean;
}

export function RenameButton({ session, state, disabled }: RenameButtonProps) {
    return (
        <Button
            variant="secondary"
            size="xs"
            className={cl("rename-btn")}
            disabled={disabled}
            onClick={() =>
                openModal(props => (
                    <RenameModal
                        props={props}
                        session={session}
                        state={state}
                    />
                ))
            }
        >
            Rename
        </Button>
    );
}

export function NewButton() {
    return (
        <Button
            variant="dangerPrimary"
            size="min"
            className={cl("new-btn")}
        >
            NEW
        </Button>
    );
}
