/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import { DEFAULT_COLOR, SWATCHES } from "@plugins/pinDms/constants";
import { categoryLen, createCategory, getCategory } from "@plugins/pinDms/data";
import { SYM_GET_RAW_TARGET } from "@shared/SettingsStore";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { extractAndLoadChunksLazy, findComponentByCodeLazy } from "@webpack";
import { ColorPicker, Modal, openModalLazy, TextInput, Toasts, useMemo, UserStore, useState } from "@webpack/common";

interface ColorPickerWithSwatchesProps {
    className?: string;
    defaultColor: number;
    colors: number[];
    value: number;
    disabled?: boolean;
    onChange(value: number | null): void;
    renderDefaultButton?: () => React.ReactNode;
    renderCustomButton?: () => React.ReactNode;
}

const ColorPickerWithSwatches = findComponentByCodeLazy<ColorPickerWithSwatchesProps>('id:"color-picker"');

export const requireSettingsModal = extractAndLoadChunksLazy(['type:"USER_SETTINGS_MODAL_OPEN"']);

const cl = classNameFactory("vc-pindms-modal-");

interface Props {
    userId: string;
    categoryId: string | null;
    initialChannelId: string | null;
    modalProps: RenderModalProps;
}

function useCategory(categoryId: string | null, initalChannelId: string | null) {
    const category = useMemo(() => {
        if (categoryId) {
            return getCategory(categoryId);
        } else if (initalChannelId) {
            return {
                id: Toasts.genId(),
                name: `Pin Category ${categoryLen() + 1}`,
                color: DEFAULT_COLOR,
                collapsed: false,
                channels: [initalChannelId]
            };
        }
    }, [categoryId, initalChannelId]);

    return category;
}

export function NewCategoryModal({ categoryId, modalProps, initialChannelId, userId }: Props) {
    const category = useCategory(categoryId, initialChannelId);
    if (!category) return null;

    const [name, setName] = useState(category.name);
    const [color, setColor] = useState(category.color);

    const onSave = () => {
        const currentCategory = categoryId ? getCategory(categoryId) : undefined;
        if (UserStore.getCurrentUser()?.id !== userId || categoryId && (!currentCategory
            || Reflect.get(currentCategory, SYM_GET_RAW_TARGET) !== Reflect.get(category, SYM_GET_RAW_TARGET))) {
            modalProps.onClose();
            return;
        }

        category.name = name;
        category.color = color;

        if (!categoryId) {
            createCategory(category);
        }

        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            title={`${categoryId ? "Edit" : "New"} Category`}
            actions={[{
                text: categoryId ? "Save" : "Create",
                variant: "primary",
                onClick: onSave,
                disabled: !name
            }]}
        >
            <form
                className={cl("content")}
                onSubmit={e => {
                    e.preventDefault();
                    onSave();
                }}
            >
                <section>
                    <Heading tag="h5">Name</Heading>
                    <TextInput
                        value={name}
                        onChange={e => setName(e)}
                    />
                </section>
                <section>
                    <Heading tag="h5">Color</Heading>
                    <ColorPickerWithSwatches
                        className={cl("color-picker")}
                        key={category.id}
                        defaultColor={DEFAULT_COLOR}
                        colors={SWATCHES}
                        onChange={c => setColor(c!)}
                        value={color}
                        renderDefaultButton={() => null}
                        renderCustomButton={() => (
                            <ColorPicker
                                color={color}
                                onChange={c => setColor(c!)}
                                key={category.id}
                                showEyeDropper={false}
                            />
                        )}
                    />
                </section>
            </form>
        </Modal>
    );
}

export const openCategoryModal = (categoryId: string | null, channelId: string | null) => {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    return openModalLazy(async () => {
        await requireSettingsModal();
        if (UserStore.getCurrentUser()?.id !== userId) return () => null;
        return modalProps => <NewCategoryModal categoryId={categoryId} modalProps={modalProps} initialChannelId={channelId} userId={userId} />;
    });
};
