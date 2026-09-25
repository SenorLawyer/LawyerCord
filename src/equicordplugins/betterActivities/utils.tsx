/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Activity, Application } from "@vencord/discord-types";
import { findByPropsLazy, findComponentByCodeLazy, findStoreLazy } from "@webpack";

import { settings } from "./settings";
import { ActivityViewProps, ApplicationIcon } from "./types";

const ApplicationStore: {
    getApplication: (id: string) => Application | null;
} = findStoreLazy("ApplicationStore");

const { fetchApplication }: {
    fetchApplication: (id: string) => Promise<Application | null>;
} = findByPropsLazy("fetchApplication");

const fetchedApplications = new Map<string, Application | null>();
const MAX_FETCHED_APPLICATIONS = 500;

const xboxUrl = "https://discord.com/assets/9a15d086141be29d9fcd.png"; // TODO: replace with "renderXboxImage"?

export const ActivityView = findComponentByCodeLazy<ActivityViewProps>('location:"UserProfileActivityCard",');

export const cl = classNameFactory("vc-bactivities-");

function getFetchedApplication(id: string) {
    if (!fetchedApplications.has(id)) return undefined;

    const application = fetchedApplications.get(id) ?? null;
    fetchedApplications.delete(id);
    fetchedApplications.set(id, application);

    return application;
}

function setFetchedApplication(id: string, application: Application | null) {
    if (fetchedApplications.has(id)) fetchedApplications.delete(id);

    fetchedApplications.set(id, application);
    while (fetchedApplications.size > MAX_FETCHED_APPLICATIONS) {
        const oldestKey = fetchedApplications.keys().next().value;
        if (oldestKey === undefined) return;
        fetchedApplications.delete(oldestKey);
    }
}

export function clearFetchedApplications() {
    fetchedApplications.clear();
}

export function getApplicationIcons(activities: Activity[], preferSmall = false): ApplicationIcon[] {
    const applicationIcons: ApplicationIcon[] = [];
    const applications = activities.filter(activity => activity != null && (activity.application_id || activity.platform || activity.id?.startsWith("spotify:")));

    for (const activity of applications) {
        const { assets, application_id, platform, id } = activity;
        if (!application_id && !platform && !id?.startsWith("spotify:")) continue;

        if (assets) {
            const { small_image, small_text, large_image, large_text } = assets;
            const smallText = small_text ?? "Small Text";
            const largeText = large_text ?? "Large Text";

            const addImage = (image: string, alt: string) => {
                if (image.startsWith("mp:")) {
                    const discordMediaLink = `https://media.discordapp.net/${image.replace(/mp:/, "")}`;
                    if (settings.store.renderGifs || !discordMediaLink.endsWith(".gif")) {
                        applicationIcons.push({
                            image: { src: discordMediaLink, alt },
                            activity
                        });
                    }
                } else if (image.startsWith("spotify:")) {
                    const url = `https://i.scdn.co/image/${image.split(":")[1]}`;
                    applicationIcons.push({
                        image: { src: url, alt },
                        activity
                    });
                } else {
                    const src = `https://cdn.discordapp.com/app-assets/${application_id}/${image}.png`;
                    applicationIcons.push({
                        image: { src, alt },
                        activity
                    });
                }
            };

            if (preferSmall) {
                if (small_image) {
                    addImage(small_image, smallText);
                } else if (large_image) {
                    addImage(large_image, largeText);
                }
            } else {
                if (large_image) {
                    addImage(large_image, largeText);
                } else if (small_image) {
                    addImage(small_image, smallText);
                }
            }
        } else if (application_id) {
            let application = ApplicationStore.getApplication(application_id);
            if (!application) {
                const fetchedApplication = getFetchedApplication(application_id);
                if (fetchedApplication !== undefined) {
                    application = fetchedApplication;
                } else {
                    setFetchedApplication(application_id, null);
                    fetchApplication(application_id).then(app => {
                        setFetchedApplication(application_id, app);
                    }).catch(error => {
                        fetchedApplications.delete(application_id);
                        console.error(error);
                    });
                }
            }

            if (application) {
                if (application.icon) {
                    const src = `https://cdn.discordapp.com/app-icons/${application.id}/${application.icon}.png`;
                    applicationIcons.push({
                        image: { src, alt: application.name },
                        activity,
                        application
                    });
                } else if (platform === "xbox") {
                    applicationIcons.push({
                        image: { src: xboxUrl, alt: "Xbox" },
                        activity,
                        application
                    });
                }
            } else if (platform === "xbox") {
                applicationIcons.push({
                    image: { src: xboxUrl, alt: "Xbox" },
                    activity
                });
            }
        } else if (platform === "xbox") {
            applicationIcons.push({
                image: { src: xboxUrl, alt: "Xbox" },
                activity
            });
        }
    }

    return applicationIcons;
}
