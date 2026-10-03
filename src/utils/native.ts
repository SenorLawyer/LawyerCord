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

import { UpdateLogger } from "./updater";

export function relaunch() {
    const relaunchClient = () => {
        if (IS_DISCORD_DESKTOP)
            window.DiscordNative.app.relaunch();
        else if (IS_VESKTOP || IS_EQUIBOP)
            window.VesktopNative.app.relaunch();
        else
            location.reload();
    };
    if (!IS_WEB && IS_STANDALONE) {
        VencordNative.updater.restart().then(result => {
            if (!result.ok) {
                UpdateLogger.error(result.error);
                alert("Discord could not restart to apply the release. Close Discord and open it again, or repair LawyerCord with the installer.");
            } else if (!result.value) relaunchClient();
        }).catch(error => {
            UpdateLogger.error(error);
            alert("Discord could not restart to apply the release. Try again or repair LawyerCord with the installer.");
        });
        return;
    }
    relaunchClient();
}

export function showItemInFolder(path: string) {
    if (IS_DISCORD_DESKTOP)
        window.DiscordNative.fileManager.showItemInFolder(path);
    else
        window.VesktopNative.fileManager.showItemInFolder(path);
}
