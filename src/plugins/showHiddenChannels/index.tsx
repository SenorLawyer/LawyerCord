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

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Role } from "@vencord/discord-types";
import { ChannelStore, PermissionsBits, PermissionStore, Tooltip } from "@webpack/common";

import HiddenChannelLockScreen, { setChannelBeginHeader } from "./components/HiddenChannelLockScreen";

export const cl = classNameFactory("vc-shc-");

const enum ShowMode {
    LockIcon,
    LockIconRight,
    EyeIconRight,
}

const enum ChannelStyle {
    Classic,
    Muted,
    Unread,
    MutedUnread,
}

const CONNECT = 1n << 20n;

export const settings = definePluginSettings({
    channelStyle: {
        description: "The style used to display hidden channels.",
        type: OptionType.SELECT,
        options: [
            { label: "Classic", value: ChannelStyle.Classic, default: true },
            { label: "Muted", value: ChannelStyle.Muted },
            { label: "Show Unreads", value: ChannelStyle.Unread },
            { label: "Muted and Show Unreads", value: ChannelStyle.MutedUnread }
        ],
        restartNeeded: true
    },
    showMode: {
        description: "The mode used to display hidden channels.",
        type: OptionType.SELECT,
        options: [
            { label: "Lock Icon replacing channel icon", value: ShowMode.LockIcon, default: true },
            { label: "Eye icon on the right", value: ShowMode.EyeIconRight },
            { label: "Lock icon on the right", value: ShowMode.LockIconRight }
        ],
        restartNeeded: true
    },
    defaultAllowedUsersAndRolesDropdownState: {
        description: "Whether the allowed users and roles dropdown on hidden channels should be open by default",
        type: OptionType.BOOLEAN,
        default: true
    }
});

function isUncategorized(objChannel: { channel: Channel; comparator: number; }) {
    return objChannel.channel.id === "null" && objChannel.channel.name === "Uncategorized" && objChannel.comparator === -1;
}

export default definePlugin({
    name: "ShowHiddenChannels",
    description: "Show channels that you do not have access to view.",
    tags: ["Servers", "Utility"],
    authors: [Devs.BigDuck, Devs.AverageReactEnjoyer, Devs.D3SOX, Devs.Ven, Devs.Nuckyz, Devs.Nickyux, Devs.Rini, EquicordDevs.Oggetto],
    isModified: true,
    settings,

    patches: [
        {
            // RenderLevel defines if a channel is hidden, collapsed in category, visible, etc
            find: '"placeholder-channel-id"',
            replacement: [
                // Remove the special logic for channels we don't have access to
                {
                    match: /if\(!\i\.\i\.can\(\i\.\i\.VIEW_CHANNEL[^{}]{0,100}{if\(this\.id===\i\).{0,200}?threadIds:\[\]}}/,
                    replace: ""
                },
                // Do not check for unreads when selecting the render level if the channel is hidden
                {
                    match: /(?<=&&)(?=!\i\.\i\.hasUnread\(this\.record\.id\))/,
                    replace: "$self.isHiddenChannel(this.record)||"
                },
                // Make channels we dont have access to be the same level as normal ones
                {
                    match: /(this\.record\)\?{renderLevel:([^,]{1,30}),threadIds:[^;]{0,150}?renderLevel:)[^,]{1,30}(?=,threadIds)/g,
                    replace: "$1$2"
                },
                // Remove permission checking for getRenderLevel function
                {
                    match: /(?<=getRenderLevel\(\i\){[^{}]{0,100}?return)!\i\.\i\.can\(\i\.\i\.VIEW_CHANNEL,this\.record\)\|\|/,
                    replace: " "
                }
            ]
        },
        {
            find: "VoiceChannel, transitionTo: Channel does not have a guildId",
            replacement: [
                {
                    // Do not show confirmation to join a voice channel when already connected to another if clicking on a hidden voice channel
                    match: /(?<=getIgnoredUsersForVoiceChannel\((\i)\.id\)[^;]{0,300}?;return\()/,
                    replace: "!$self.isHiddenChannel($1)&&"
                },
                {
                    // Prevent Discord from trying to connect to hidden voice channels
                    match: /(?=\|\|\i\.\i\.selectVoiceChannel\((\i)\.id\))/,
                    replace: "||$self.isHiddenChannel($1)"
                },
                {
                    // Make Discord show inside the channel if clicking on a hidden or locked channel
                    match: /(?<=selectVoiceChannel\((\i)\.id\),)!__OVERLAY__&&\(/,
                    replace: "$&$self.isHiddenChannel($1,true)||"
                }
            ]
        },
        // Prevent Discord from trying to connect to hidden stage channels
        {
            find: ".AUDIENCE),{isSubscriptionGated",
            replacement: {
                match: /(\i)\.isRoleSubscriptionTemplatePreviewChannel\(\)/,
                replace: (m, channel) => `${m}||$self.isHiddenChannel(${channel})`
            }
        },
        {
            find: 'tutorialId:"instant-invite"',
            replacement: [
                // Render null instead of the buttons if the channel is hidden
                ...[
                    "renderEditButton",
                    "renderInviteButton",
                ].map(func => ({
                    match: new RegExp(`(?<=${func}\\(\\){)`, "g"), // Global because Discord has multiple declarations of the same functions
                    replace: "if($self.isHiddenChannel(this?.props?.channel))return null;"
                }))
            ]
        },
        {
            find: "VoiceChannel.renderPopout: There must always be something to render",
            all: true,
            // Render null instead of the buttons if the channel is hidden
            replacement: {
                match: /(?<=renderOpenChatButton(?:",|=)\(\)=>{)/,
                replace: "if($self.isHiddenChannel(this?.props?.channel))return null;"
            }
        },
        {
            find: "#{intl::CHANNEL_TOOLTIP_DIRECTORY}",
            predicate: () => settings.store.showMode === ShowMode.LockIcon,
            replacement: {
                // Lock Icon
                match: /(?<=(\i)\.isNSFW\(\);)switch\(\i\.type\).{0,15}\.GUILD_ANNOUNCEMENT/,
                replace: (m, channel) => `if($self.isHiddenChannel(${channel}))return $self.LockIcon;${m}`
            }
        },
        {
            find: "UNREAD_IMPORTANT:",
            predicate: () => settings.store.showMode !== ShowMode.LockIcon,
            replacement: [
                // Add the hidden eye icon if the channel is hidden
                {
                    predicate: () => settings.store.showMode === ShowMode.EyeIconRight,
                    match: /\.Children\.count[^;]{0,150}?:null(?<=,channel:(\i),[^;]{0,200})/,
                    replace: "$&,$self.isHiddenChannel($1)?$self.EyeRightIcon():null"
                },
                // Add the hidden lock icon if the channel is hidden
                {
                    predicate: () => settings.store.showMode === ShowMode.LockIconRight,
                    match: /\.Children\.count[^;]{0,150}?:null(?<=,channel:(\i),[^;]{0,200})/,
                    replace: "$&,$self.isHiddenChannel($1)?$self.LockRightIcon():null"
                },
            ]
        },
        {
            find: "UNREAD_IMPORTANT:",
            predicate: () => settings.store.channelStyle === ChannelStyle.Muted || settings.store.channelStyle === ChannelStyle.MutedUnread,
            replacement: [
                // Make the channel appear as muted if it's hidden
                {
                    match: /(?=return\(0,\i\.jsxs?\)\(\i\.\i,{focusTarget:.{0,350}?if\((\i)\)return \i\.MUTED)/,
                    replace: "$1=$self.isHiddenChannel(arguments[0].channel)?true:$1;"
                },
                // Make voice channels also appear as muted if they are muted
                {
                    match: /(?<=\?\i\.\i:\i\.\i,)(.{0,150}?)if\((\i)(?:\)return |\?)(\i\.MUTED)/,
                    replace: '$2?$3:"",$1if($2)return ""'
                }
            ]
        },
        {
            find: "UNREAD_IMPORTANT:",
            predicate: () => settings.store.channelStyle !== ChannelStyle.Unread && settings.store.channelStyle !== ChannelStyle.MutedUnread,
            replacement: [
                {
                    match: /(?<=\.LOCKED;if\()(?=.{0,500}?onMouseUp:\i=>\i\?\.\(\i,(\i)\))/,
                    replace: "!$self.isHiddenChannel($1)&&"
                },
                {
                    // Hide unreads
                    match: /(?=return\(0,\i\.jsxs?\)\(\i\.\i,{focusTarget:.{0,450}?if\((\i)\)if\(\i\)return \i\.UNREAD_IMPORTANT)/,
                    replace: "$1=$self.isHiddenChannel(arguments[0].channel)?false:$1;"
                }
            ]
        },
        {
            // Hide the new version of unreads box for hidden channels
            find: '"ChannelListUnreadsStore"',
            replacement: {
                match: /(?<=\.id\)\))(?=&&\(0,\i\.\i\)\((\i)\))/,
                replace: (_, channel) => `&&!$self.isHiddenChannel(${channel})`
            }
        },
        {
            // Make the old version of unreads box not visible for hidden channels
            find: "renderBottomUnread(){",
            replacement: {
                match: /(?<=!0\))(?=&&\(0,\i\.\i\)\((\i\.record)\))/,
                replace: "&&!$self.isHiddenChannel($1)"
            }
        },
        {
            // Make the state of the old version of unreads box not include hidden channels
            find: "GUILD_EVENT)}),[",
            replacement: {
                match: /(?<=\.id\)\))(?=&&\(0,\i\.\i\)\((\i)\))/,
                replace: "&&!$self.isHiddenChannel($1)"
            }
        },
        // Only render the channel header and buttons that work when transitioning to a hidden channel
        {
            find: "Missing channel in Channel.renderHeaderToolbar",
            replacement: [
                {
                    match: /case \i\.\i\.GUILD_(?:TEXT|MEDIA|APP):(?=.{0,150}?(\i)\|\|.{0,150}?(\i\.push.{0,50}?channel:(\i)},"notifications"\)\)))/g,
                    replace: "$&if(!$1&&$self.isHiddenChannel($3)){$2;break;}"
                },
                {
                    match: /(?<=\.GUILD_MEDIA:case \i\.\i\.GUILD_DIRECTORY:)(?=\i\.push\(.{0,50}?channelId:(\i)\.id)/,
                    replace: "if($self.isHiddenChannel($1))break;"
                },
                {
                    match: /(?<=hideSearch:(\i)\.isDirectory\(\))(?=,toolbar:this\.renderHeaderToolbar\(\))/,
                    replace: "||$self.isHiddenChannel($1)"
                },
                {
                    match: /(?<=renderSidebar\(\){)/,
                    replace: "if($self.isHiddenChannel(this?.props?.channel))return null;"
                },
                {
                    match: /(?<=renderChat\(\){)/,
                    replace: "if($self.isHiddenChannel(this?.props?.channel))return $self.HiddenChannelLockScreen(this?.props?.channel);"
                }
            ]
        },
        // Avoid trying to fetch messages from hidden channels
        {
            find: '"MessageManager"',
            replacement: {
                match: /(?<=forceFetch:\i,isPreload:[^{}]{0,200}}=\i;)(?=if\(null==(\i)\|\|)/,
                replace: "if($self.isHiddenChannel({channelId:$1}))return;"
            }
        },
        // Patch keybind handlers so you can't accidentally jump to hidden channels
        {
            find: '"alt+shift+down"',
            replacement: {
                match: /(?<=getChannel\(\i\);return null!=(\i))(?=.{0,200}?>0\)&&\(0,\i\.\i\)\(\i\))/,
                replace: "&&!$self.isHiddenChannel($1)"
            }
        },
        // Patch keybind handlers so you can't accidentally jump to hidden channels
        {
            find: ".APPLICATION_STORE&&null!=",
            replacement: {
                match: /(?<=withCurrentVoiceChannel:!0}\))(?=\.map\(\i=>\i\.id)/,
                replace: ".filter(e=>!$self.isHiddenChannel(e))"
            }
        },
        {
            find: "#{intl::ROLE_REQUIRED_SINGLE_USER_MESSAGE}",
            replacement: [
                {
                    // Change the role permission check to CONNECT if the channel is locked
                    match: /(?<=context:(\i)}\);return \i\.\i\(\i,)(\i\.\i\(\i\.\i\.ADMINISTRATOR,\i\.\i\.VIEW_CHANNEL\))/,
                    replace: "$self.swapViewChannelWithConnectPermission($2,$1)"
                },
                {
                    // Change the permissionOverwrite check to CONNECT if the channel is locked
                    match: /(?<=(\i)\.permissionOverwrites\[\i\.id\]\?\?\i\.\i,\i=)(?=(\i\.\i\(\i\.allow,\i\.\i\.)VIEW_CHANNEL)/,
                    replace: `!Vencord.Webpack.Common.PermissionStore.can(${CONNECT}n,$1)?$2CONNECT):`
                },
                {
                    // Include the @everyone role in the allowed roles list for Hidden Channels
                    match: /(?<=\.useMemo\(\(\)=>null!=\i\?\i\.filter\(\i=>)(?=!\(0,\i\.\i\)\(\i\)\):\[\],\[\i\]\))/,
                    replace: "$self.isHiddenChannel(arguments[0]?.channel)?true:"
                },
                {
                    // If the @everyone role has the required permissions, make the array only contain it
                    match: /(?<=\.useMemo\(\(\)=>)(\i\(\)\(\i\)\.filter\(\i=>\{(?=.{0,100}forceRoles:).{0,300}?\}\)\.value\(\))/,
                    replace: "$self.getAllowedRoles($1,arguments[0].channel.guild_id)"
                },
                {
                    // Patch the header to only return allowed users and roles if it's a hidden channel or locked channel (Like when it's used on the HiddenChannelLockScreen)
                    match: /return\(0,\i\.jsxs?\)\(\i\.\i,{channelId:(\i)\.id,children:\[(?=.{0,650}?(\(0,\i\.jsxs?\)\("div",{className:\i\.\i,children:\[.{0,100}\i\.length>0.{0,900}?\]}\)),)/,
                    replace: "if($self.isHiddenChannel($1,true)){return$2;}$&"
                },
                {
                    // Export the channel for the users allowed component patch
                    match: /(?<=guildId:(\i)\.guild_id,[^{}]{0,100}maxUsers:\d{1,3},users:\i)(?=})/,
                    replace: ",shcChannel:$1"
                },
                {
                    // Always render the component for multiple allowed users
                    match: /1!==\i\.length(?=\|\|)/,
                    replace: "true"
                }
            ]
        },
        {
            find: '="interactive-text-default",overflowCountClassName:',
            group: true,
            replacement: [
                {
                    match: /(?<=\(\i,{count:\i,textVariant:\i,)/,
                    replace: "shcChannel:arguments[0].shcChannel,"
                },
                {
                    // Make Discord always render the plus button if the component is used inside the HiddenChannelLockScreen
                    match: /\i>0(?=&&!\i&&!\i)/,
                    replace: "($self.isHiddenChannel(arguments[0].shcChannel,true)?true:$&)"
                },
                {
                    match: /(?<=#{intl::VIDEO_CALL_VIEW_ALL_COUNT},{count:)\i/,
                    replace: "$self.isHiddenChannel(arguments[0].shcChannel,true)?arguments[0].users.length:$&"
                },
                {
                    // Show only the plus text without overflowed children amount
                    // if the overflow amount is <= 0 and the component is used inside the HiddenChannelLockScreen
                    match: /(?<=`\+\$\{)\i(?=\})/,
                    replace: '$self.isHiddenChannel(arguments[0].shcChannel,true)&&($&-1)<=0?"":$&'
                }
            ]
        },
        {
            find: "#{intl::CHANNEL_CALL_CURRENT_SPEAKER}",
            replacement: [
                {
                    // Remove the open chat button for the HiddenChannelLockScreen
                    match: /(?<=&&)\i\.push\(.{0,120}"chat-spacer"/,
                    replace: "(arguments[0]?.inCall||!$self.isHiddenChannel(arguments[0]?.channel,true))&&$&"
                }
            ]
        },
        {
            find: "#{intl::EMBEDDED_ACTIVITIES_DEVELOPER_ACTIVITY_SHELF_FETCH_ERROR}",
            replacement: [
                {
                    // Render our HiddenChannelLockScreen component instead of the main voice channel component
                    match: /(?<=hideControls:\i,idle:\i,children:)/,
                    replace: "$&!this?.props?.inCall&&$self.isHiddenChannel(this?.props?.channel,true)?$self.HiddenChannelLockScreen(this?.props?.channel):"
                },
                {
                    // Disable gradients for the HiddenChannelLockScreen of voice channels
                    match: /(?<=screenMessage:this\.screenMessage,disableGradients:)/,
                    replace: "$&!this?.props?.inCall&&$self.isHiddenChannel(this?.props?.channel,true)||"
                },
                {
                    // Disable useless components for the HiddenChannelLockScreen of voice channels
                    match: /(?:{|,)render(?!Header|ExternalHeader).{0,30}?:/g,
                    replace: "$&!this?.props?.inCall&&$self.isHiddenChannel(this?.props?.channel,true)?()=>null:"
                },
                {
                    // Disable bad CSS class which mess up hidden voice channels styling
                    match: /(?=\i\|\|\i!==\i\.\i\.FULL_SCREEN.{0,100}?this\._callContainerRef)/,
                    replace: '$&!this?.props?.inCall&&$self.isHiddenChannel(this?.props?.channel,true)?"":'
                }
            ]
        },
        {
            find: '"HasBeenInStageChannel"',
            replacement: [
                {
                    // Render our HiddenChannelLockScreen component instead of the main stage channel component
                    match: /(?<=screenMessage:(\i)\?{[^{}]{0,100}}:null,\.\.\.\i,children:)(?=!\1&&)/,
                    replace: "$self.isHiddenChannel(arguments[0].channel)?$self.HiddenChannelLockScreen(arguments[0].channel):"
                },
                {
                    // Disable useless components for the HiddenChannelLockScreen of stage channels
                    match: /(?<=render(?:BottomLeft|BottomCenter|BottomRight|ChatToasts):(?:\(\)=>|function\(\){return))(?=.{0,150}?channel(?:Id)?:(\i)(?=[,}.]))/g,
                    replace: " $self.isHiddenChannel($1)?null:"
                },
                {
                    // Disable gradients for the HiddenChannelLockScreen of stage channels
                    match: /(?<=paddingTop:\i},disableGradients:)/,
                    replace: "$self.isHiddenChannel(arguments[0].channel)||"
                },
                {
                    // Disable strange styles applied to the header for the HiddenChannelLockScreen of stage channels
                    match: /(?<=style:)(?={height:`calc\(100% - \$\{\i}\)`,paddingTop:\i},disableGradients:)/,
                    replace: "$self.isHiddenChannel(arguments[0].channel)?void 0:"
                }
            ]
        },
        {
            find: "#{intl::STAGE_FULL_MODERATOR_TITLE}",
            replacement: [
                {
                    // Remove the divider and amount of users in stage channel components for the HiddenChannelLockScreen
                    match: /\(0,\i\.jsx\)\(\i\.\i\.Divider,{[^{}]{0,100}}\),\(0,\i\.jsxs?\)\(\i\.\i\.Title,{children:\[.{0,500}?\]}\)/,
                    replace: "...($self.isHiddenChannel(arguments[0].channel)?[]:[$&])"
                },
                {
                    // Remove the open chat button for the HiddenChannelLockScreen
                    match: /(?<=numRequestToSpeak:\i\}\)\}\):null,!\i&&)\(0,\i\.jsxs?\).{0,280}?iconClassName:/,
                    replace: "!$self.isHiddenChannel(arguments[0]?.channel,true)&&$&"
                }
            ]
        },
        {
            // Make the chat input bar channel list contain hidden channels
            find: ",queryStaticRouteChannels(",
            replacement: [
                {
                    // Make the getChannels call to GuildChannelStore return hidden channels
                    match: /(?<=queryChannels\(\i\){.+?getChannels\(\i)(?=\))/,
                    replace: ",true"
                },
                {
                    // Avoid filtering out hidden channels from the channel list
                    match: /(?<=queryChannels\(\i\){.+?\)\((\i)\.type\))(?=&&!\i\.\i\.can\()/,
                    replace: "&&!$self.isHiddenChannel($1)"
                }
            ]
        },
        {
            find: "\"^/guild-stages/(\\\\d+)(?:/)?(\\\\d+)?\"",
            replacement: {
                // Make mentions of hidden channels work
                match: /\i\.\i\.can\(\i\.\i\.VIEW_CHANNEL,\i\)/,
                replace: "true"
            },
        },
        {
            find: 'getConfig({location:"channel_mention"})',
            replacement: {
                // Show inside voice channel instead of trying to join them when clicking on a channel mention
                match: /(?<=getChannel\(\i\);if\(null!=(\i)).{0,200}?return void (?=\i\.default\.selectVoiceChannel)/,
                replace: (m, channel) => `${m}!$self.isHiddenChannel(${channel})&&`
            }
        },
        {
            find: '"GuildChannelStore"',
            replacement: [
                {
                    // Make GuildChannelStore contain hidden channels
                    match: /isChannelGated\(.+?\)(?=&&)/,
                    replace: m => `${m}&&false`
                },
                {
                    // Filter hidden channels from GuildChannelStore.getChannels unless told otherwise
                    match: /(?<=getChannels\(\i)(\){.*?)return (.+?)}/,
                    replace: (_, rest, channels) => `,shouldIncludeHidden${rest}return $self.resolveGuildChannels(${channels},shouldIncludeHidden??arguments[0]==="@favorites");}`
                },
            ]
        },
        {
            find: "GuildTooltip - ",
            replacement: {
                // Make GuildChannelStore.getChannels return hidden channels
                match: /(?<=getChannels\(\i)(?=\))/,
                replace: ",true"
            }
        },
        {
            find: '"NowPlayingViewStore"',
            replacement: {
                // Make active now voice states on hidden channels
                match: /(getVoiceStateForUser.{0,150}?)&&\i\.\i\.canWithPartialContext.{0,20}VIEW_CHANNEL.+?}\)(?=\?)/,
                replace: "$1"
            }
        },
        {
            find: "#{intl::ROLE_REQUIRED_SINGLE_USER_MESSAGE}",
            replacement: {
                match: /(?=function (\i)\(\i\){let{channel:.{0,200}?getSortedRoles\()/,
                replace: "$self.ChannelBeginHeader=$1;"
            }
        },
        {
            find: "2026-02-private-channel-hiding",
            replacement: {
                match: /(function \i\(\i\)).{0,50}\.enableObfuscation\}/g,
                replace: "$1{return false;}"
            }
        }
    ],

    set ChannelBeginHeader(value: any) {
        setChannelBeginHeader(value);
    },

    swapViewChannelWithConnectPermission(mergedPermissions: bigint, channel: Channel) {
        if (!PermissionStore.can(PermissionsBits.CONNECT, channel)) {
            mergedPermissions &= ~PermissionsBits.VIEW_CHANNEL;
            mergedPermissions |= PermissionsBits.CONNECT;
        }

        return mergedPermissions;
    },

    isHiddenChannel(channel: Channel & { channelId?: string; }, checkConnect = false) {
        try {
            if (channel == null || Object.hasOwn(channel, "channelId") && channel.channelId == null) return false;

            if (channel.channelId != null) channel = ChannelStore.getChannel(channel.channelId);
            if (channel == null || channel.isDM() || channel.isGroupDM() || channel.isMultiUserDM()) return false;
            if (["browse", "customize", "guide"].includes(channel.id)) return false;

            return !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel) || checkConnect && !PermissionStore.can(PermissionsBits.CONNECT, channel);
        } catch (e) {
            console.error("[ViewHiddenChannels#isHiddenChannel]: ", e);
            return false;
        }
    },

    resolveGuildChannels(channels: Record<string | number, Array<{ channel: Channel; comparator: number; }> | string | number>, shouldIncludeHidden: boolean) {
        if (shouldIncludeHidden) return channels;

        const res = {};
        for (const [key, maybeObjChannels] of Object.entries(channels)) {
            if (!Array.isArray(maybeObjChannels)) {
                res[key] = maybeObjChannels;
                continue;
            }

            res[key] ??= [];

            for (const objChannel of maybeObjChannels) {
                if (isUncategorized(objChannel) || objChannel.channel.id === null || !this.isHiddenChannel(objChannel.channel)) res[key].push(objChannel);
            }
        }

        return res;
    },

    getAllowedRoles(roles: Role[], guildId: string) {
        const everyoneRole = roles.find(role => role.id === guildId);
        return everyoneRole ? [everyoneRole] : roles;
    },

    HiddenChannelLockScreen: (channel: any) => <HiddenChannelLockScreen channel={channel} />,

    LockIcon: ErrorBoundary.wrap(() => (
        <svg
            className={cl("channel-list-icon")}
            height="18"
            width="20"
            viewBox="0 0 24 24"
            aria-hidden={true}
            role="img"
        >
            <path fillRule="evenodd" d="M17 11V7C17 4.243 14.756 2 12 2C9.242 2 7 4.243 7 7V11C5.897 11 5 11.896 5 13V20C5 21.103 5.897 22 7 22H17C18.103 22 19 21.103 19 20V13C19 11.896 18.103 11 17 11ZM12 18C11.172 18 10.5 17.328 10.5 16.5C10.5 15.672 11.172 15 12 15C12.828 15 13.5 15.672 13.5 16.5C13.5 17.328 12.828 18 12 18ZM15 11H9V7C9 5.346 10.346 4 12 4C13.654 4 15 5.346 15 7V11Z" />
        </svg>
    ), { noop: true }),

    EyeRightIcon: ErrorBoundary.wrap(() => (
        <Tooltip text="Hidden Channel">
            {({ onMouseLeave, onMouseEnter }) => (
                <svg
                    onMouseLeave={onMouseLeave}
                    onMouseEnter={onMouseEnter}
                    className={classes(cl("channel-list-icon"), cl("hidden-channel-icon"))}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    aria-hidden={true}
                    role="img"
                >
                    <path fillRule="evenodd" d="m19.8 22.6-4.2-4.15q-.875.275-1.762.413Q12.95 19 12 19q-3.775 0-6.725-2.087Q2.325 14.825 1 11.5q.525-1.325 1.325-2.463Q3.125 7.9 4.15 7L1.4 4.2l1.4-1.4 18.4 18.4ZM12 16q.275 0 .512-.025.238-.025.513-.1l-5.4-5.4q-.075.275-.1.513-.025.237-.025.512 0 1.875 1.312 3.188Q10.125 16 12 16Zm7.3.45-3.175-3.15q.175-.425.275-.862.1-.438.1-.938 0-1.875-1.312-3.188Q13.875 7 12 7q-.5 0-.938.1-.437.1-.862.3L7.65 4.85q1.025-.425 2.1-.638Q10.825 4 12 4q3.775 0 6.725 2.087Q21.675 8.175 23 11.5q-.575 1.475-1.512 2.738Q20.55 15.5 19.3 16.45Zm-4.625-4.6-3-3q.7-.125 1.288.112.587.238 1.012.688.425.45.613 1.038.187.587.087 1.162Z" />
                </svg>
            )}
        </Tooltip>
    ), { noop: true }),

    LockRightIcon: ErrorBoundary.wrap(() => (
        <Tooltip text="Hidden Channel">
            {({ onMouseLeave, onMouseEnter }) => (
                <svg
                    onMouseLeave={onMouseLeave}
                    onMouseEnter={onMouseEnter}
                    className={classes(cl("channel-list-icon"), cl("hidden-channel-icon"))}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    aria-hidden={true}
                    role="img"
                >
                    <path fillRule="evenodd" d="M17 11V7C17 4.243 14.756 2 12 2C9.242 2 7 4.243 7 7V11C5.897 11 5 11.896 5 13V20C5 21.103 5.897 22 7 22H17C18.103 22 19 21.103 19 20V13C19 11.896 18.103 11 17 11ZM12 18C11.172 18 10.5 17.328 10.5 16.5C10.5 15.672 11.172 15 12 15C12.828 15 13.5 15.672 13.5 16.5C13.5 17.328 12.828 18 12 18ZM15 11H9V7C9 5.346 10.346 4 12 4C13.654 4 15 5.346 15 7V11Z" />
                </svg>
            )}
        </Tooltip>
    ), { noop: true })
});
