/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, UserSettingsActionCreators } from "@webpack/common";

function generateSearchResults(query: string) {
    const frequentChannels: Record<string, { totalUses: number; }> = UserSettingsActionCreators.FrecencyUserSettingsActionCreators.getCurrentValue().guildAndChannelFrecency.guildAndChannels;

    return Object.entries(frequentChannels)
        .filter(([id]) => ChannelStore.getChannel(id)?.name?.includes(query))
        .sort(([, first], [, second]) => second.totalUses - first.totalUses)
        .slice(0, 20)
        .map(([id]) => ({
            type: "TEXT_CHANNEL",
            record: ChannelStore.getChannel(id),
            score: 20,
            comparator: query,
            sortable: query
        }));
}

export default definePlugin({
    name: "FrequentQuickSwitcher",
    description: "Show your most frequently visited channels in the quick switcher.",
    tags: ["Shortcuts", "Servers"],
    authors: [Devs.Samwich],
    generateSearchResults,
    patches: [
        {
            find: "#{intl::QUICKSWITCHER_PLACEHOLDER}",
            replacement: {
                match: /let{selectedIndex:\i,results:\i}/,
                replace: "this.props.results = $self.generateSearchResults(this.state.query);$&"
            },
        }
    ]
});
