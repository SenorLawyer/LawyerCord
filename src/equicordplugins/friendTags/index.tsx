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
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Button, ChannelStore, Menu, RelationshipStore, TextInput, useEffect, UserStore, useState } from "@webpack/common";

interface UserTagData {
    tagName: string;
    userIds: string[];
}

let SavedData: UserTagData[] = [];
let savedDataSerialized = "[]";
const tagStoreName = "vc-friendtags-tags";

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
    const serialized = JSON.stringify(SavedData);
    if (serialized === savedDataSerialized) return true;

    await DataStore.set(tagStoreName, serialized);
    savedDataSerialized = serialized;
    return true;
}

async function GetData() {
    const fetchData = await DataStore.get<string>(tagStoreName);
    if (!fetchData) {
        SavedData = [];
        savedDataSerialized = "[]";
        void DataStore.set(tagStoreName, savedDataSerialized);
        return;
    }

    try {
        SavedData = JSON.parse(fetchData);
        savedDataSerialized = fetchData;
    } catch {
        SavedData = [];
        savedDataSerialized = "[]";
        void DataStore.set(tagStoreName, savedDataSerialized);
    }
}

function TagConfigCard(props) {
    const { tag } = props;
    const [tagName, setTagName] = useState(tag.tagName);
    const [userIds, setUserIDs] = useState(tag.userIds.join(", "));
    const update = useForceUpdater();

    useEffect(() => {
        const dataTag = SavedData.find(obj => obj.tagName === tag.tagName);
        if (dataTag) {
            dataTag.tagName = tagName;
        }
        SetData();
        update();
    }, [tagName]);

    useEffect(() => {
        const dataTag = SavedData.find(obj => obj.userIds === tag.userIds);
        if (dataTag) {
            dataTag.userIds = userIds.split(", ");
        }
        SetData();
        update();
    }, [userIds]);

    return (
        <>
            <BaseText size="md" tag="h5">Name</BaseText>
            <TextInput value={tagName} onChange={setTagName}></TextInput>
            <BaseText size="md" tag="h5">Users (Seperated by comma)</BaseText>
            <TextInput value={userIds} onChange={setUserIDs}></TextInput>
            <div className={"vc-friend-tags-user-header-container"}>
                <BaseText>User List (Click A User To Remove)</BaseText>
                <div className={"vc-friend-tags-user-header-btns"}>
                    {
                        userIds.split(", ").map(user => {
                            const userData: any = UserStore.getUser(user);
                            if (!userData) return null;
                            return (
                                <div style={{ display: "flex" }} key={user}>
                                    <img src={userData.getAvatarURL()} style={{ height: "20px", borderRadius: "50%", marginRight: "5px" }}></img>
                                    <BaseText style={{ cursor: "pointer" }} size="md" onClick={() => setUserIDs(userIds.replace(`, ${user}`, "").replace(user, ""))}>{userData.globalName || userData.username}</BaseText>
                                </div>
                            );
                        })
                    }
                </div>
            </div>
            <Button
                onClick={async () => {
                    SavedData = SavedData.filter(data => (data.tagName !== tagName));
                    await SetData();
                    update();
                }}
                color={Button.Colors.RED}
            >
                Remove
            </Button>
        </>
    );
}

function TagConfigurationComponent() {
    const update = useForceUpdater();

    return (
        <>
            <Divider />
            {
                SavedData?.map(e => (
                    <>
                        <TagConfigCard tag={e} />
                        <Divider />
                    </>
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

function UserToTagID(user, tag, remove) {
    const dataTag = SavedData.find(e => e.tagName === tag);
    if (!dataTag) return;

    if (remove) {
        dataTag.userIds = dataTag.userIds.filter(e => e !== user);
    }
    else if (!dataTag.userIds.includes(user)) {
        dataTag.userIds.push(user);
    }
    SetData();
}

const userPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user?.id) return;

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
                        key={`vc-tag-${tag.tagName}`}
                        id={`vc-tag-${tag.tagName}`}
                        action={() => { UserToTagID(user.id, tag.tagName, isTagged); }}
                    />
                );
            })}
        </Menu.MenuItem>;

    children.push({ ...buttonElement });
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
    async start() {
        GetData();
    },
    queryFriendTags,
});
