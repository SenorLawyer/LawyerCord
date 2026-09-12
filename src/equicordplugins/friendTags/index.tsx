/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Divider } from "@components/Divider";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { useAwaiter, useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Button, ChannelStore, Menu, React, RelationshipStore, showToast, TextInput, Toasts, UserStore, useState } from "@webpack/common";

interface UserTagData {
    tagName: string;
    userIds: string[];
}

let SavedData: UserTagData[] = [];
let savedDataSerialized: string | undefined;
let dataPromise: Promise<void> | undefined;
const logger = new Logger("FriendTags");
const tagStoreName = "vc-friendtags-tags";
const tagIds = new WeakMap<UserTagData, number>();
let nextTagId = 0;

function getTagId(tag: UserTagData) {
    let id = tagIds.get(tag);
    if (id === undefined) tagIds.set(tag, id = nextTagId++);
    return `vc-tag-${id}`;
}

function parseUsertags(text: string): string[] {
    const matches = text.match(/&([^&]+)/g);
    if (!matches) return [];
    const tags = matches.map(match => match.substring(1).trim());
    return tags.filter(tag => tag !== "");
}

function queryFriendTags(query) {
    const tags = new Set(parseUsertags(query).map(tag => tag.toLowerCase()));
    if (!tags.size) return [];

    const taggedUserIds = new Set<string>();
    for (const data of SavedData) {
        if (!data.tagName.length || !data.userIds.length || !tags.has(data.tagName.toLowerCase())) continue;

        for (const userId of data.userIds) taggedUserIds.add(userId);
    }
    if (!taggedUserIds.size) return [];

    const users: Array<{ type: "USER"; record: any; score: number; comparator: string; sortable: string; }> = [];
    const seenUserIds = new Set<string>();
    const addTaggedUser = (user: string) => {
        if (seenUserIds.has(user) || !taggedUserIds.has(user)) return;
        seenUserIds.add(user);

        const userObject: any = UserStore.getUser(user);
        if (!userObject) return;

        users.push({
            type: "USER",
            record: userObject,
            score: 20,
            comparator: userObject.globalName || userObject.username,
            sortable: userObject.globalName || userObject.username
        });
    };

    for (const user of ChannelStore.getDMUserIds()) addTaggedUser(user);
    for (const user of RelationshipStore.getFriendIDs()) addTaggedUser(user);

    return users;
}

async function SetData() {
    if (savedDataSerialized === undefined) return;
    const pending = dataPromise;
    const serialized = JSON.stringify(SavedData);
    if (serialized === savedDataSerialized) return;

    try {
        await DataStore.set(tagStoreName, serialized);
    } catch {
        if (dataPromise === pending) {
            logger.error("Could not save tags.");
            showToast("Could not save tags. Changes may be lost when FriendTags restarts.", Toasts.Type.FAILURE);
        }
        return;
    }
    if (dataPromise === pending) savedDataSerialized = serialized;
}

function GetData() {
    if (dataPromise) return dataPromise;
    const pending = DataStore.get<unknown>(tagStoreName).then(raw => {
        if (dataPromise !== pending) return;
        if (raw !== undefined && typeof raw !== "string") throw new Error("Invalid saved tags.");
        const data: unknown = raw === undefined ? [] : JSON.parse(raw);
        if (!Array.isArray(data) || !data.every((tag: unknown) =>
            typeof tag === "object" && tag !== null
            && "tagName" in tag && typeof tag.tagName === "string"
            && "userIds" in tag && Array.isArray(tag.userIds)
            && tag.userIds.every((id: unknown) => typeof id === "string")
        )) throw new Error("Invalid saved tags.");
        SavedData = data;
        savedDataSerialized = JSON.stringify(data);
    });
    dataPromise = pending;
    return pending;
}

function TagConfigCard(props: { tag: UserTagData; onRemove(): void; }) {
    const { tag } = props;
    const [tagName, setTagName] = useState(tag.tagName);
    const [userIds, setUserIDs] = useState(tag.userIds.join(", "));

    function changeUserIds(value: string) {
        if (!SavedData.includes(tag)) return;
        setUserIDs(value);
        tag.userIds = value.split(",").map(id => id.trim()).filter(Boolean);
        void SetData();
    }

    return (
        <>
            <BaseText size="md" tag="h5">Name</BaseText>
            <TextInput value={tagName} onChange={(value: string) => {
                if (!SavedData.includes(tag)) return;
                setTagName(value);
                tag.tagName = value;
                void SetData();
            }}></TextInput>
            <BaseText size="md" tag="h5">Users (Separated by comma)</BaseText>
            <TextInput value={userIds} onChange={changeUserIds}></TextInput>
            <div className={"vc-friend-tags-user-header-container"}>
                <BaseText>User List (Click A User To Remove)</BaseText>
                <div className={"vc-friend-tags-user-header-btns"}>
                    {
                        tag.userIds.map(user => {
                            const userData: any = UserStore.getUser(user);
                            if (!userData) return null;
                            return (
                                <div style={{ display: "flex" }} key={user}>
                                    <img src={userData.getAvatarURL()} style={{ height: "20px", borderRadius: "50%", marginRight: "5px" }}></img>
                                    <BaseText style={{ cursor: "pointer" }} size="md" onClick={() => changeUserIds(tag.userIds.filter(id => id !== user).join(", "))}>{userData.globalName || userData.username}</BaseText>
                                </div>
                            );
                        })
                    }
                </div>
            </div>
            <Button
                onClick={props.onRemove}
                color={Button.Colors.RED}
            >
                Remove
            </Button>
        </>
    );
}

function TagConfigurationComponent() {
    const update = useForceUpdater();
    const [, error, pending] = useAwaiter(GetData);

    if (pending) return <BaseText>Loading tags...</BaseText>;
    if (error) return <BaseText>Tags could not be loaded. Restart FriendTags to try again.</BaseText>;

    return (
        <>
            <Divider />
            {
                SavedData.map(tag => (
                    <React.Fragment key={getTagId(tag)}>
                        <TagConfigCard tag={tag} onRemove={() => {
                            if (!SavedData.includes(tag)) return;
                            SavedData = SavedData.filter(data => data !== tag);
                            update();
                            void SetData();
                        }} />
                        <Divider />
                    </React.Fragment>
                ))
            }
            <Button onClick={() => {
                SavedData.push(
                    {
                        tagName: "",
                        userIds: []
                    });
                SetData();
                update();
            }}>Add</Button>
        </>
    );
}

const settings = definePluginSettings({
    tagConfiguration: {
        type: OptionType.COMPONENT,
        description: "The tag configuration component",
        component: () => {
            return (
                <TagConfigurationComponent />
            );
        }
    }
});

function UserToTagID(user: string, dataTag: UserTagData, remove: boolean) {
    if (!SavedData.includes(dataTag)) return;

    if (remove) {
        dataTag.userIds = dataTag.userIds.filter(e => e !== user);
    }
    else if (!dataTag.userIds.includes(user)) {
        dataTag.userIds.push(user);
    }
    SetData();
}

const userPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user?.id || savedDataSerialized === undefined) return;

    const buttonElement =
        <Menu.MenuItem
            id="vc-tag-group"
            label="Tag"
        >
            {SavedData.map(tag => {
                const isTagged = tag.userIds.includes(user.id);

                return (
                    <Menu.MenuItem
                        label={`${isTagged ? "Remove from" : "Add to"} ${tag.tagName}`}
                        key={getTagId(tag)}
                        id={getTagId(tag)}
                        action={() => { UserToTagID(user.id, tag, isTagged); }}
                    />
                );
            })}
        </Menu.MenuItem>;

    children.push(buttonElement);
};

export default definePlugin({
    name: "FriendTags",
    description: "Allows you to filter by custom tags in the quick switcher by starting a search with &",
    tags: ["Shortcuts"],
    authors: [Devs.Samwich],
    settings,
    contextMenus: {
        "user-context": userPatch
    },
    patches: [
        {
            find: "#{intl::QUICKSWITCHER_PLACEHOLDER}",
            replacement: {
                match: /let{selectedIndex:\i,results:\i}/,
                replace: "if(this.state.query.includes(\"&\")){ this.props.results = $self.queryFriendTags(this.state.query); }$&"
            },
        }
    ],
    start() {
        void GetData().catch(() => logger.error("Could not load saved tags."));
    },
    stop() {
        dataPromise = undefined;
        savedDataSerialized = undefined;
        SavedData = [];
    },
    queryFriendTags,
});
