/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { insertTextIntoChatInputBox } from "@utils/discord";
import definePlugin, { IconComponent } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { Button, Modal, openModal, TextInput, useState } from "@webpack/common";

interface Template {
    id: string;
    name: string;
    content: string;
}

const settings = definePluginSettings({}).withPrivateSettings<{ templates?: Template[]; }>();

const TemplateIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
);

function templates() {
    return settings.store.templates ?? [];
}

function saveTemplate(template: Template) {
    const current = templates();
    settings.store.templates = current.some(value => value.id === template.id)
        ? current.map(value => value.id === template.id ? template : value)
        : [...current, template];
}

function TemplateModal(props: RenderModalProps) {
    const [values, setValues] = useState(templates());
    const [name, setName] = useState("");
    const [content, setContent] = useState("");

    function addTemplate() {
        const trimmedName = name.trim();
        const trimmedContent = content.trim();
        if (!trimmedName || !trimmedContent) return;
        const next = { id: crypto.randomUUID(), name: trimmedName, content: trimmedContent };
        saveTemplate(next);
        setValues(templates());
        setName("");
        setContent("");
    }

    return <Modal {...props} size="md" title="Message templates" actions={[{ text: "Add template", variant: "primary", onClick: addTemplate }]}>
        <div>
            {values.map(template => <div key={template.id}>
                <strong>{template.name}</strong>
                <p>{template.content}</p>
                <Button onClick={() => {
                    settings.store.templates = templates().filter(value => value.id !== template.id);
                    setValues(templates());
                }}>Delete</Button>
            </div>)}
            <TextInput placeholder="Template name" value={name} onChange={setName} />
            <TextInput placeholder="Message to insert" value={content} onChange={setContent} />
        </div>
    </Modal>;
}

function PickerModal(props: RenderModalProps) {
    return <Modal {...props} size="small" title="Insert template">
        <div>{templates().length ? templates().map(template => <Button key={template.id} onClick={() => {
            insertTextIntoChatInputBox(template.content);
            props.onClose();
        }}>{template.name}</Button>) : <p>No templates yet. Add them from the plugin toolbox action.</p>}</div>
    </Modal>;
}

const TemplateButton: ChatBarButtonFactory = ({ isAnyChat }) => isAnyChat ? <ChatBarButton tooltip="Insert template" onClick={() => openModal(props => <PickerModal {...props} />)}><TemplateIcon /></ChatBarButton> : null;

export default definePlugin({
    name: "MessageTemplates",
    description: "Save reusable message snippets and insert them from the chat bar.",
    authors: [EquicordDevs.SenorLawyer],
    tags: ["Chat", "Utility"],
    dependencies: ["ChatInputButtonAPI"],
    settings,
    chatBarButton: { icon: TemplateIcon, render: TemplateButton },
    toolboxActions: {
        "Manage Message Templates": () => openModal(props => <TemplateModal {...props} />),
    },
});
