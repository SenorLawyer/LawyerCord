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

import { MessageObject } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "Unindent",
    description: "Trims leading indentation from codeblocks",
    dependencies: ["MessageEventsAPI"],
    tags: ["Chat", "Utility"],
    authors: [Devs.Ven],

    patches: [
        {
            find: "inQuote:",
            replacement: {
                match: /,content:([^,]+),inQuote/,
                replace: (_, content) => `,content:$self.unindent(${content}),inQuote`
            }
        }
    ],

    unindent(str: string) {
        // Users cannot send tabs, they get converted to spaces. However, a bot may send tabs, so convert them to 4 spaces first
        str = str.replace(/\t/g, "    ");
        const minIndent = str.match(/^ *(?=\S)/gm)
            ?.reduce((prev, curr) => Math.min(prev, curr.length), Infinity) ?? 0;

        if (!minIndent) return str;
        return str.replace(new RegExp(`^ {${minIndent}}`, "gm"), "");
    },

    unindentMsg(msg: MessageObject) {
        msg.content = msg.content.replace(/```[\s\S]*?```/g, m => {
            const newline = m.indexOf("\n");
            if (newline === -1) return m; // Do not affect inline codeblocks
            return m.slice(0, newline + 1) + this.unindent(m.slice(newline + 1, -3)) + "```";
        });
    },

    onBeforeMessageSend(_, msg) {
        return this.unindentMsg(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        return this.unindentMsg(msg);
    }
});
