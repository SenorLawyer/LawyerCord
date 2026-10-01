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

import type { ComponentProps } from "react";

import { AddonCard } from "./AddonCard";
import { EditableText } from "./EditableText";

interface Props extends ComponentProps<typeof AddonCard> {
    customName?: string;
    onEditName?: (newName: string) => void;
}

export function OnlineThemeCard({ customName, name, onEditName, ...props }: Props) {
    return (
        <AddonCard
            {...props}
            name={onEditName ? (
                <EditableText
                    value={customName || (name ? name.toString() : "")}
                    onChange={onEditName}
                    className="vc-addon-editable"
                />
            ) : customName || name}
        />
    );
}
