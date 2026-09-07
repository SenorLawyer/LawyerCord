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

import { ChannelStore, UserProfileStore, useStateFromStores } from "@webpack/common";

import { PronounsFormat, settings } from "./settings";

const FORMAT_SETTINGS: "pronounsFormat"[] = ["pronounsFormat"];

export function useFormattedPronouns(id: string, channelId: string) {
    const { pronounsFormat } = settings.use(FORMAT_SETTINGS);
    const pronouns = useStateFromStores([UserProfileStore, ChannelStore], () => {
        const guildId = ChannelStore.getChannel(channelId)?.getGuildId();
        const guildPronouns = guildId ? UserProfileStore.getGuildMemberProfile(id, guildId)?.pronouns : undefined;
        return guildPronouns || UserProfileStore.getUserProfile(id)?.pronouns;
    }, [id, channelId])?.trim().replace(/\n+/g, "");
    return pronounsFormat === PronounsFormat.Lowercase ? pronouns?.toLowerCase() : pronouns;
}
