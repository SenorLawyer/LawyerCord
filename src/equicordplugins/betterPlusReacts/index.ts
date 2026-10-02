/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { MessageStore } from "@webpack/common";

export default definePlugin({
    name: "BetterPlusReacts",
    performance: { impact: "low", description: "Looks up a message while entering a reaction shortcut." },
    authors: [Devs.Joona],
    description: "The amount of plus before :emoji: is the message to add it to",
    tags: ["Chat", "Emotes"],
    patches: [
        {
            find: ".SLASH_COMMAND_USED,",
            replacement: [
                {
                    match: /\\\+/,
                    replace: "$&*"
                },
                {
                    match: /\i.trim\(\)/,
                    replace: "$&.replace(/^\\++/, '+')"
                },
                {
                    match: /=\i\.\i\.getMessages\(\i\.id\)\.last\(\)(?=.{78,85}.getByName\(\i\.)/,
                    replace: "=$self.getMsgReference()"
                }
            ]
        },
        {
            find: "this.props.activeCommandOption,",
            replacement: [
                // Enable auto complete for multiple plusses
                // and set the message reference
                {
                    match: /:this.props.currentWord/,
                    replace: "$&.replace(/^\\++/, '+')"
                },
                {
                    match: /this.props.editorRef.current\)return;/,
                    replace: "$&$self.setMsgReference(this.props.currentWord.split(':')[0],this.props.channel.id);"
                }
            ]
        },
    ],
    message: null,
    getMsgReference() {
        const { message } = this;
        this.message = null;
        return message;
    },
    setMsgReference(plusses: string, channelId: string) {
        const messages = MessageStore.getMessages(channelId);
        this.message = messages?.getByIndex(messages.length - plusses.length);
    }
});
