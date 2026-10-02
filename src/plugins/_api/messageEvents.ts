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

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "MessageEventsAPI",
    performance: {
        impact: "low",
        description: "Runs registered callbacks when messages are sent, edited, or clicked."
    },
    description: "Api required by anything using message events.",
    authors: [Devs.Arjix, Devs.hunt, Devs.Ven],
    patches: [
        {
            find: "#{intl::EDIT_TEXTAREA_HELP}",
            group: true,
            replacement: [{
                match: /(?<=\.then\()\i(?==>\{let\{valid:\i\}=)/,
                replace: "async $&"
            }, {
                match: /let (\i)=\i\.\i\.parse\(this\.props\.channel,\i\)(?:,[^;]{1,200})?;/g,
                replace: "$&if(await Vencord.Api.MessageEvents._handlePreEdit(this.props.channel.id,this.props.message.id,$1))return{shouldClear:false,shouldRefocus:true};"
            }]
        },
        {
            find: ".handleSendMessage,onResize:",
            group: true,
            replacement: [{
                match: /(?<=\.then\()\i(?==>\{let\{[^{}]{0,100}\bfailureReason:)/,
                replace: "async $&"
            }, {
                match: /let (\i)=\i\.\i\.parse\((\i),\i\);.{0,100}?let (\i)=\{\.\.\.\i\.\i\.getSendMessageOptions\((\{.{0,300}?\})\),location:\i\.\i\.\i\};/,
                replace: (match, parsedMessage, channel, options, contentOptions) => match +
                    `const vcContentOptions=${contentOptions},vcProps={` +
                    "openWarningPopout:e=>this.setState({contentWarningProps:e})," +
                    "type:this.props.chatInputType,content:vcContentOptions.content," +
                    "hasStickers:(vcContentOptions.stickers?.length??0)>0," +
                    "hasAttachments:(vcContentOptions.uploads?.length??0)>0," +
                    `channel:${channel}};` +
                    `if(await Vencord.Api.MessageEvents._handlePreSend(${channel}.id,${parsedMessage},${options},vcProps,vcContentOptions))` +
                    "return{shouldClear:false,shouldRefocus:true};"
            }]
        },
        {
            find: '("interactionUsernameProfile',
            replacement: {
                match: /let\{id:\i}=(\i),{id:\i}=(\i);return \i\.useCallback\((\i)=>\{/,
                replace: (m, message, channel, event) =>
                    `const vcMsg=${message},vcChan=${channel};${m}Vencord.Api.MessageEvents._handleClick(vcMsg,vcChan,${event});`
            }
        }
    ]
});
