/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { set } from "@api/DataStore";
import { HeadingSecondary } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { ColorPicker, Modal, React, useState } from "@webpack/common";

import { colors, DATASTORE_KEY } from "./index";

const cl = classNameFactory("vc-customColors-");

export function SetColorModal({ id, modalProps }: { id: string, modalProps: RenderModalProps; }) {
    const parsedColor = parseInt(colors[id], 16);
    const initialColor = Number.isNaN(parsedColor) ? 372735 : parsedColor;
    // color picker default to current color set for user (if null it's 0x05afff :3 )

    const [colorPickerColor, setColorPickerColor] = useState(initialColor);
    // hex color code as an int (NOT rgb 0-255)

    function handleKey(e: React.KeyboardEvent) {
        if (e.key === "Enter")
            saveUserColor();
    }

    async function saveUserColor() {
        colors[id] = colorPickerColor.toString(16).padStart(6, "0");
        await set(DATASTORE_KEY, colors);
        modalProps.onClose();
    }

    async function deleteUserColor() {
        delete colors[id];
        await set(DATASTORE_KEY, colors);
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Custom Color"
            actions={[
                {
                    text: "Save",
                    variant: "primary",
                    onClick: saveUserColor
                },
                {
                    text: "Delete Entry",
                    variant: "dangerPrimary",
                    onClick: deleteUserColor
                }
            ]}
        >
            <div onKeyDown={handleKey} className={cl("modal-content")}>
                <section className={Margins.bottom16}>
                    <HeadingSecondary>
                        Pick a Color
                    </HeadingSecondary>
                    <ColorPicker
                        color={colorPickerColor}
                        onChange={color => setColorPickerColor(color ?? 372735)}
                        showEyeDropper={false}
                    />
                </section>
            </div>
        </Modal>
    );
}
