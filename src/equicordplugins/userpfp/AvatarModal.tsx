/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { update } from "@api/DataStore";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { IconUtils, Modal, React, TextInput, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { data, KEY_DATASTORE } from ".";

const cl = classNameFactory("vc-userpfp-");

export function SetAvatarModal({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const { avatars } = data;
    const user = UserStore.getUser(userId);
    const originalAvatar = IconUtils.getUserAvatarURL(user, true, 128) || "";

    const [url, setUrl] = useState(avatars[userId] || "");
    const preview = url.trim();
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const readerRef = React.useRef<FileReader | null>(null);

    function cancelRead() {
        const reader = readerRef.current;
        readerRef.current = null;
        reader?.abort();
    }

    useEffect(() => cancelRead, []);

    function handleKey(e: React.KeyboardEvent) {
        if (e.key === "Enter") saveUserAvatar(url.trim());
    }

    function handleFile(file: File) {
        cancelRead();
        if (!file.type.startsWith("image/")) return;

        if (file.type === "image/gif" || file.type === "image/webp") {
            Toasts.show({
                message: "GIFs/WebP must be added via URL. Upload your GIF/WebP to a image hosting service and paste the link.",
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
            });
            return;
        }

        const reader = readerRef.current = new FileReader();
        reader.onload = () => {
            if (readerRef.current !== reader) return;
            readerRef.current = null;
            setUrl(reader.result as string);
        };
        reader.onerror = () => {
            if (readerRef.current !== reader) return;
            readerRef.current = null;
            Toasts.show({ message: "Could not read the image.", type: Toasts.Type.FAILURE, id: Toasts.genId() });
        };
        reader.readAsDataURL(file);
    }

    async function saveUserAvatar(value: string) {
        try {
            let saved: Record<string, string> = {};
            await update<Record<string, string>>(KEY_DATASTORE, stored => {
                saved = { ...stored };
                if (value) saved[userId] = value;
                else delete saved[userId];
                return saved;
            });
            data.avatars = saved;
            modalProps.onClose();
        } catch {
            Toasts.show({ message: "Could not save the avatar.", type: Toasts.Type.FAILURE, id: Toasts.genId() });
        }
    }

    const actions = [
        {
            text: "Save",
            variant: "primary",
            onClick: () => saveUserAvatar(url.trim())
        }
    ];

    if (avatars[userId]) {
        actions.unshift({
            text: "Delete",
            variant: "dangerPrimary",
            onClick: () => saveUserAvatar("")
        });
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Custom Avatar"
            actions={actions}
        >
            <div onKeyDown={handleKey}>
                {/* Preview */}
                <div className={cl("preview-row")}>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Original</span>
                        <img src={originalAvatar} className={cl("avatar")} alt="original" />
                    </div>
                    <span className={cl("arrow")}>→</span>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Local</span>
                        <img
                            src={preview || originalAvatar}
                            className={`${cl("avatar")} ${preview ? cl("avatar-active") : ""}`}
                            alt="local"
                        />
                    </div>
                </div>

                {/* URL input */}
                <section className={Margins.bottom8}>
                    <Heading tag="h3">Enter PNG/GIF URL</Heading>
                    <TextInput
                        placeholder="https://example.com/image.png"
                        value={url.startsWith("data:") ? "(uploaded file)" : url}
                        onChange={value => { cancelRead(); setUrl(value); }}
                        autoFocus
                    />
                </section>

                {/* Drag & drop */}
                <div
                    className={`${cl("dropzone")} ${isDragging ? cl("dropzone-active") : ""}`}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => {
                        e.preventDefault();
                        setIsDragging(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) handleFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {isDragging ? "Drop here!" : "⬆ Drag an image or click to upload (for GIFs or WebP use a URL instead)"}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        style={{ display: "none" }}
                        onChange={e => {
                            const file = e.currentTarget.files?.[0];
                            if (file) handleFile(file);
                            e.currentTarget.value = "";
                        }}
                    />
                </div>
            </div>
        </Modal>
    );
}
