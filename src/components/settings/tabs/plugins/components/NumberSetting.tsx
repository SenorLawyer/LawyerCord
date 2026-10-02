/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { isSettingDisabled } from "@api/PluginManager";
import { OptionType, PluginSettingBigIntDef, PluginSettingNumberDef } from "@utils/types";
import { React, TextInput, useState } from "@webpack/common";

import { resolveError, SettingProps, SettingsSection } from "./Common";

export function NumberSetting({ setting, pluginSettings, definedSettings, id, onChange }: SettingProps<PluginSettingNumberDef | PluginSettingBigIntDef>) {
    const isBigInt = setting.type === OptionType.BIGINT;
    const [state, setState] = useState(`${pluginSettings[id] ?? setting.default ?? 0}`);
    const [error, setError] = useState<string | null>(null);

    function handleChange(newValue: string) {
        setState(newValue);
        if (!newValue.trim() || isBigInt && !/^[+-]?\d+$/.test(newValue)) {
            setError(isBigInt ? "Enter a whole number." : "Enter a number.");
            return;
        }
        const value = isBigInt ? BigInt(newValue) : Number(newValue);
        if (typeof value === "number" && !Number.isFinite(value)) {
            setError("Enter a finite number.");
            return;
        }
        const isValid = setting.isValid?.call(definedSettings, newValue) ?? true;

        setError(resolveError(isValid));

        if (isValid === true) {
            onChange(value);
        }
    }

    return (
        <SettingsSection name={setting.displayName} id={id} description={setting.description} error={error}>
            <TextInput
                type={isBigInt ? "text" : "number"}
                inputMode={isBigInt ? "numeric" : undefined}
                pattern="-?[0-9]+"
                placeholder={setting.placeholder ?? "Enter a number"}
                value={state}
                onChange={handleChange}
                disabled={isSettingDisabled(definedSettings, setting)}
                {...setting.componentProps}
            />
        </SettingsSection>
    );
}
