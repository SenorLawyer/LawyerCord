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
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { getIntlMessage, hasGuildFeature } from "@utils/discord";
import definePlugin from "@utils/types";
import { Constants, GuildStore, PermissionStore, RestAPI, showToast, Toasts, useState } from "@webpack/common";

interface InvitesLabelProps {
    guildId: string;
    setChecked(value: boolean): void;
}

function showDisableInvites(guildId: string) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return false;

    return (
        !hasGuildFeature(guild, "INVITES_DISABLED") &&
        PermissionStore.getGuildPermissionProps(guild).canManageRoles
    );
}

export default definePlugin({
    name: "PauseInvitesForever",
    searchTerms: ["DisableInvitesForever"],
    description: "Brings back the option to pause invites indefinitely that Discord removed.",
    tags: ["Servers"],
    authors: [Devs.Dolfies, Devs.amia],

    patches: [
        {
            find: "#{intl::GUILD_INVITE_DISABLE_ACTION_SHEET_DESCRIPTION}",
            replacement: {
                match: /children:\i\.\i\.string\(\i\.\i#{intl::GUILD_INVITE_DISABLE_ACTION_SHEET_DESCRIPTION}\)(?=.{0,250}?onChange:function\(\)\{(\i)\()/,
                replace: "children: $self.renderInvitesLabel({guildId:arguments[0].guildId,setChecked:$1})",
            }
        }
    ],

    renderInvitesLabel: ErrorBoundary.wrap(({ guildId, setChecked }: InvitesLabelProps) => {
        const [pending, setPending] = useState(false);

        async function disableInvites() {
            const guild = GuildStore.getGuild(guildId);
            if (!guild || pending) return;

            setPending(true);
            try {
                if (!hasGuildFeature(guild, "INVITES_DISABLED")) {
                    await RestAPI.patch({
                        url: Constants.Endpoints.GUILD(guildId),
                        body: { features: [...guild.features, "INVITES_DISABLED"] },
                    });
                }
                setChecked(true);
            } catch {
                showToast("Could not pause invites. Try again.", Toasts.Type.FAILURE);
            } finally {
                setPending(false);
            }
        }

        return (
            <div>
                {getIntlMessage("GUILD_INVITE_DISABLE_ACTION_SHEET_DESCRIPTION")}
                {showDisableInvites(guildId) && <TextButton disabled={pending} onClick={disableInvites}>Pause Indefinitely.</TextButton>}
            </div>
        );
    }, { noop: true })
});
