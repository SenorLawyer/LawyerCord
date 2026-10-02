/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { HiddenServersStore } from "@equicordplugins/hideServers/HiddenServersStore";
import { classNameFactory } from "@utils/css";
import { Button, GuildStore, useStateFromStores } from "@webpack/common";

import { openHiddenServersModal } from "./HiddenServersMenu";

const cl = classNameFactory("vc-hideservers-");

function HiddenServersButton() {
    // if youve left a server dont show it in the count
    const actuallyHidden = useStateFromStores([HiddenServersStore, GuildStore], () => {
        let count = 0;
        for (const guildId of HiddenServersStore.hiddenGuilds) {
            if (GuildStore.getGuild(guildId)) count++;
        }
        return count;
    });

    return (
        <div className={cl("button-wrapper")}>
            {actuallyHidden > 0 ? (
                <Button
                    className={cl("button")}
                    look={Button.Looks.FILLED}
                    size={Button.Sizes.MIN}
                    onClick={() => openHiddenServersModal()}
                >
                    {actuallyHidden} Hidden
                </Button>
            ) : null}
        </div >
    );
}

export default () => { return <HiddenServersButton />; };
