/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Devs } from "@utils/constants";
import { identity } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, lodash, MediaEngineStore, Select, Slider, useState, useStateFromStores } from "@webpack/common";

const settings = definePluginSettings({
    title1: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Appearance</BaseText>,
        description: ""
    },
    uncollapseSettingsByDefault: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Automatically uncollapse voice settings by default"
    },
    title2: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Settings to show</BaseText>,
        description: ""
    },
    outputVolume: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an output volume slider"
    },
    inputVolume: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an input volume slider"
    },
    outputDevice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an output device selector"
    },
    inputDevice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an input device selector"
    },
    camera: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show a camera selector"
    },
    title3: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Headers to show</BaseText>,
        description: ""
    },
    showOutputVolumeHeader: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show header above output volume slider"
    },
    showInputVolumeHeader: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show header above input volume slider"
    },
    showOutputDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above output device selector"
    },
    showInputDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above input device selector"
    },
    showVideoDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above camera selector"
    },
});

function OutputVolumeComponent() {
    const outputVolume = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getOutputVolume());

    return (
        <>
            {settings.store.showOutputVolumeHeader && <Heading>Output volume</Heading>}
            <Slider maxValue={200} minValue={0} onValueRender={v => `${v.toFixed(0)}%`} initialValue={outputVolume} asValueChanges={volume => {
                FluxDispatcher.dispatch({
                    type: "AUDIO_SET_OUTPUT_VOLUME",
                    volume
                });
            }} />
        </>
    );
}

function InputVolumeComponent() {
    const inputVolume = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getInputVolume());

    return (
        <>
            {settings.store.showInputVolumeHeader && <Heading>Input volume</Heading>}
            <Slider maxValue={100} minValue={0} initialValue={inputVolume} asValueChanges={volume => {
                FluxDispatcher.dispatch({
                    type: "AUDIO_SET_INPUT_VOLUME",
                    volume
                });
            }} />
        </>
    );
}

function OutputDeviceComponent() {
    const outputDevice = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getOutputDeviceId());
    const devices = useStateFromStores([MediaEngineStore], () => Object.values(MediaEngineStore.getOutputDevices()).map(device => ({ id: device.id, name: device.name })), [], lodash.isEqual);

    return (
        <>
            {settings.store.showOutputDeviceHeader && <Heading>Output device</Heading>}
            <Select options={devices.map(device => {
                return { value: device.id, label: settings.store.showOutputDeviceHeader ? device.name : `🔊 ${device.name}` };
            })}
                serialize={identity}
                isSelected={value => value === outputDevice}
                select={id => {
                    FluxDispatcher.dispatch({
                        type: "AUDIO_SET_OUTPUT_DEVICE",
                        id
                    });
                }}>

            </Select>
        </>
    );
}

function InputDeviceComponent() {
    const inputDevice = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getInputDeviceId());
    const devices = useStateFromStores([MediaEngineStore], () => Object.values(MediaEngineStore.getInputDevices()).map(device => ({ id: device.id, name: device.name })), [], lodash.isEqual);

    return (
        <div style={{ marginTop: "10px" }}>
            {settings.store.showInputDeviceHeader && <Heading>Input device</Heading>}
            <Select options={devices.map(device => {
                return { value: device.id, label: settings.store.showInputDeviceHeader ? device.name : `🎤 ${device.name}` };
            })}
                serialize={identity}
                isSelected={value => value === inputDevice}
                select={id => {
                    FluxDispatcher.dispatch({
                        type: "AUDIO_SET_INPUT_DEVICE",
                        id
                    });
                }}>

            </Select>
        </div>
    );
}

function VideoDeviceComponent() {
    const videoDevice = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getVideoDeviceId());
    const devices = useStateFromStores([MediaEngineStore], () => Object.values(MediaEngineStore.getVideoDevices()).map(device => ({ id: device.id, name: device.name })), [], lodash.isEqual);

    return (
        <div style={{ marginTop: "10px" }}>
            {settings.store.showVideoDeviceHeader && <Heading>Camera</Heading>}
            <Select options={devices.map(device => {
                return { value: device.id, label: settings.store.showVideoDeviceHeader ? device.name : `📷 ${device.name}` };
            })}
                serialize={identity}
                isSelected={value => value === videoDevice}
                select={id => {
                    FluxDispatcher.dispatch({
                        type: "MEDIA_ENGINE_SET_VIDEO_DEVICE",
                        id
                    });
                }}>

            </Select>
        </div>
    );
}

function VoiceSettings() {
    const [showSettings, setShowSettings] = useState(settings.store.uncollapseSettingsByDefault);
    return <div style={{ marginTop: "20px" }}>
        <div style={{ marginBottom: "10px" }}>
            <Link className="vc-panelsettings-underline-on-hover" style={{ color: "var(--text-default)" }} onClick={() => { setShowSettings(!showSettings); }}>{!showSettings ? "► Settings" : "▼ Hide"}</Link>
        </div>

        {
            showSettings && <>
                {settings.store.outputVolume && <OutputVolumeComponent />}
                {settings.store.inputVolume && <InputVolumeComponent />}
                {settings.store.outputDevice && <OutputDeviceComponent />}
                {settings.store.inputDevice && <InputDeviceComponent />}
                {settings.store.camera && <VideoDeviceComponent />}
            </>
        }
    </div>;
}

export default definePlugin({
    name: "VCPanelSettings",
    description: "Control voice settings right from the voice panel",
    tags: ["Utility", "Voice"],
    authors: [Devs.nin0dev],
    settings,
    renderVoiceSettings() { return <VoiceSettings />; },
    patches: [
        {
            find: "}getAccessibilityLabel(){",
            replacement: {
                match: /this.renderVoiceStates\(\),\i/,
                replace: "$&,$self.renderVoiceSettings()"
            }
        }
    ]
});
