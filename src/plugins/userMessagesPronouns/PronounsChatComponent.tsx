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

import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import { getIntlMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import { Message } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Tooltip, UserStore, useStateFromStores } from "@webpack/common";

import { settings } from "./settings";
import { useFormattedPronouns } from "./utils";

const TimestampClasses = findCssClassesLazy("timestampInline", "timestamp");
const MessageDisplayCompact = getUserSettingLazy("textAndImages", "messageDisplayCompact")!;

const AUTO_MODERATION_ACTION = 24;
const VISIBILITY_SETTINGS: "showSelf"[] = ["showSelf"];

function useShouldShow(message: Message): boolean {
    const { showSelf } = settings.use(VISIBILITY_SETTINGS);
    const currentId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    if (message.author.bot || message.author.system || message.type === AUTO_MODERATION_ACTION)
        return false;
    if (!showSelf && message.author.id === currentId)
        return false;

    return true;
}

function PronounsChatComponent({ message }: { message: Message; }) {
    const pronouns = useFormattedPronouns(message.author.id, message.channel_id);

    return pronouns && (
        <Tooltip text={getIntlMessage("USER_PROFILE_PRONOUNS")}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    className={classes(TimestampClasses.timestampInline, TimestampClasses.timestamp)}
                >• {pronouns}</span>
            )}
        </Tooltip>
    );
}

export const PronounsChatComponentWrapper = ErrorBoundary.wrap(({ message }: { message: Message; }) => {
    return useShouldShow(message)
        ? <PronounsChatComponent message={message} />
        : null;
}, { noop: true });

export const CompactPronounsChatComponentWrapper = ErrorBoundary.wrap(({ message }: { message: Message; }) => {
    const compact = MessageDisplayCompact.useSetting();
    const show = useShouldShow(message);

    if (!compact || !show) {
        return null;
    }

    return <PronounsChatComponent message={message} />;
}, { noop: true });
