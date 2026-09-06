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

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { Microphone } from "@components/Icons";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { lastState as silentMessageEnabled } from "@plugins/silentMessageToggle";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { chooseFile } from "@utils/web";
import { RenderModalProps } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { Button, CloudUploader, Constants, FluxDispatcher, Forms, Menu, MessageActions, Modal, openModal, PendingReplyStore, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, Toasts, useEffect, useState } from "@webpack/common";
import { ComponentType } from "react";

import { VoiceRecorderDesktop } from "./components/DesktopRecorder";
import { VoiceMessageProps, VoicePreview } from "./components/VoicePreview";
import { VoiceRecorderWeb } from "./components/WebRecorder";
import { DEFAULT_WAVEFORM, generateWaveform } from "./waveform";

export { DEFAULT_WAVEFORM } from "./waveform";

const VOICE_MESSAGE_FLAG = 1 << 13;
const SILENT_MESSAGE_FLAG = 4096;
const DEFAULT_DURATION = 1;

const EMPTY_META: AudioMetadata = {
    waveform: DEFAULT_WAVEFORM,
    duration: DEFAULT_DURATION,
};

export const cl = classNameFactory("vc-vmsg-");

export type VoiceRecorder = React.ComponentType<{
    setAudioBlob(blob: Blob): void;
    onRecordingChange?(recording: boolean): void;
}>;

export let VoiceMessage: ComponentType<VoiceMessageProps> = () => null;

const VoiceRecorder = IS_DISCORD_DESKTOP ? VoiceRecorderDesktop : VoiceRecorderWeb;

export const settings = definePluginSettings({
    noiseSuppression: {
        type: OptionType.BOOLEAN,
        description: "Noise Suppression",
        default: true,
    },
    echoCancellation: {
        type: OptionType.BOOLEAN,
        description: "Echo Cancellation",
        default: true,
    },
});

const ctxMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (props.channel.guild_id && !(PermissionStore.can(PermissionsBits.SEND_VOICE_MESSAGES, props.channel) && PermissionStore.can(PermissionsBits.SEND_MESSAGES, props.channel))) return;

    children.push(
        <Menu.MenuItem
            id="vc-send-vmsg"
            iconLeft={Microphone}
            leadingAccessory={{
                type: "icon",
                icon: Microphone
            }}
            label="Send Voice Message"
            action={() => openModal(modalProps => <VoiceMessageModal modalProps={modalProps} />)}
        />
    );
};

export default definePlugin({
    name: "VoiceMessages",
    description: "Allows you to send voice messages like on mobile. To do so, right click the upload button and click Send Voice Message",
    tags: ["Voice"],
    authors: [Devs.Ven, Devs.Vap, Devs.Nickyux],
    settings,

    patches: [
        {
            find: "#{intl::PAUSE_VOICE_MESSAGE_A11Y_LABEL}",
            replacement: {
                match: /(?<=\i=)(?=\i\.memo\(.{0,50}?=1,onVolumeChange:[^}]+?waveform:[^}]+?playbackCacheKey:)/,
                replace: "$self.VoiceMessage=",
            }
        }
    ],

    set VoiceMessage(value) {
        VoiceMessage = value;
    },

    contextMenus: {
        "channel-attach": ctxMenuPatch
    }
});

type AudioMetadata = {
    waveform: string,
    duration: number,
};

function sendAudio(blob: Blob, meta: AudioMetadata) {
    const channelId = SelectedChannelStore.getChannelId();
    const reply = PendingReplyStore.getPendingReply(channelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

    const upload = new CloudUploader({
        file: new File([blob], "voice-message.ogg", { type: "audio/ogg; codecs=opus" }),
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB,
    }, channelId);

    upload.on("complete", () => {
        RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channelId),
            body: {
                flags: VOICE_MESSAGE_FLAG | (silentMessageEnabled ? SILENT_MESSAGE_FLAG : 0),
                channel_id: channelId,
                content: "",
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
                attachments: [{
                    id: "0",
                    filename: upload.filename,
                    uploaded_filename: upload.uploadedFilename,
                    waveform: meta.waveform,
                    duration_secs: meta.duration,
                }],
                message_reference: reply ? MessageActions.getSendMessageOptionsForReply(reply)?.messageReference : null,
            }
        });
    });
    upload.on("error", () => showToast("Failed to upload voice message", Toasts.Type.FAILURE));

    upload.upload();
}

function useObjectUrl() {
    const [url, setUrl] = useState<string>();
    const setWithFree = (blob: Blob) => {
        if (url) URL.revokeObjectURL(url);
        setUrl(URL.createObjectURL(blob));
    };

    return [url, setWithFree] as const;
}

function VoiceMessageModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [isRecording, setRecording] = useState(false);
    const [blob, setBlob] = useState<Blob>();
    const [blobUrl, setBlobUrl] = useObjectUrl();

    useEffect(() => () => {
        if (blobUrl)
            URL.revokeObjectURL(blobUrl);
    }, [blobUrl]);

    const [meta, metaError] = useAwaiter(async () => {
        if (!blob) return EMPTY_META;

        const audioContext = new AudioContext();
        try {
            const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
            return {
                waveform: generateWaveform(audioBuffer.getChannelData(0), audioBuffer.sampleRate),
                duration: audioBuffer.duration,
            };
        } finally {
            await audioContext.close();
        }
    }, {
        deps: [blob],
        fallbackValue: EMPTY_META,
    });

    const isUnsupportedFormat = blob && (!blob.type.startsWith("audio/ogg") || blob.type.includes("codecs") && !blob.type.includes("opus"));

    return (
        <Modal
            {...modalProps}
            title="Record Voice Message"
            actions={[{
                text: "Send",
                variant: "primary",
                onClick: () => {
                    sendAudio(blob!, meta ?? EMPTY_META);
                    modalProps.onClose();
                    showToast("Now sending voice message... Please be patient", Toasts.Type.MESSAGE);
                },
                disabled: !blob
            }]}
        >
            <div className={cl("buttons")}>
                <VoiceRecorder
                    setAudioBlob={blob => {
                        setBlob(blob);
                        setBlobUrl(blob);
                    }}
                    onRecordingChange={setRecording}
                />

                <Button
                    onClick={async () => {
                        const file = await chooseFile("audio/*");
                        if (file) {
                            setBlob(file);
                            setBlobUrl(file);
                        }
                    }}
                >
                    Upload File
                </Button>
            </div>

            <Forms.FormTitle>Preview</Forms.FormTitle>
            {metaError
                ? <Paragraph className={cl("error")}>Failed to parse selected audio file: {metaError.message}</Paragraph>
                : (
                    <VoicePreview
                        src={blobUrl}
                        waveform={meta.waveform}
                        recording={isRecording}
                    />
                )}

            {isUnsupportedFormat && (
                <Card variant="warning" className={Margins.top16} defaultPadding>
                    <Forms.FormText>Voice Messages have to be OggOpus to be playable on iOS. This file is <code>{blob.type}</code> so it will not be playable on iOS.</Forms.FormText>

                    <Forms.FormText className={Margins.top8}>
                        To fix it, first convert it to OggOpus, for example using the <Link href="https://convertio.co/mp3-opus/">convertio web converter</Link>
                    </Forms.FormText>
                </Card>
            )}
        </Modal>
    );
}
