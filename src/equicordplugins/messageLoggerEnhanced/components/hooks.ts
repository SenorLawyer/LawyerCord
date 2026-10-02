/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

import { countMessagesIDB, DBMessageRecord, DBMessageStatus, getMessagesPageIDB } from "../db";
import { Flogger } from "../index";
import { doesMatch, tokenizeQuery } from "../utils/parseQuery";
import { LogTabs } from "./LogsModal";

function useDebouncedValue<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);

        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);

    return debouncedValue;
}

// this is so shit
export function useMessages(query: string, currentTab: LogTabs, sortNewest: boolean, numDisplayedMessages: number) {
    // only for initial load
    const [pending, setPending] = useState(true);
    const [messages, setMessages] = useState<DBMessageRecord[]>([]);
    const [statusTotal, setStatusTotal] = useState<number>(0);
    const [total, setTotal] = useState<number>(0);
    const [revision, setRevision] = useState(0);

    const debouncedQuery = useDebouncedValue(query, 300);

    useEffect(() => {
        const controller = new AbortController();
        setPending(true);

        const loadMessages = async () => {
            const status = getStatus(currentTab);

            const { queries, rest } = tokenizeQuery(debouncedQuery);
            const terms = rest.map(term => term.toLowerCase());
            const matches = debouncedQuery === "" ? undefined : (record: DBMessageRecord) => {
                for (const query of queries) {
                    const matching = doesMatch(query.key, query.value, record.message);
                    if (query.negate ? matching : !matching) {
                        return false;
                    }
                }

                const content = record.message.content.toLowerCase();
                return terms.every(term => content.includes(term));
            };
            const [page, total] = await Promise.all([
                getMessagesPageIDB(sortNewest, numDisplayedMessages, status, matches, controller.signal),
                countMessagesIDB()
            ]);
            if (!controller.signal.aborted) {
                setMessages(page.messages);
                setStatusTotal(page.total);
                setTotal(total);
            }
        };

        void loadMessages().catch(error => {
            if (!controller.signal.aborted) Flogger.error("Failed to load message logs", error);
        }).finally(() => {
            if (!controller.signal.aborted) setPending(false);
        });

        return () => {
            controller.abort();
        };

    }, [debouncedQuery, sortNewest, numDisplayedMessages, currentTab, revision]);

    return { messages, statusTotal, total, pending, reset: () => setRevision(value => value + 1) };
}

function getStatus(currentTab: LogTabs) {
    switch (currentTab) {
        case LogTabs.DELETED:
            return DBMessageStatus.DELETED;
        case LogTabs.EDITED:
            return DBMessageStatus.EDITED;
        default:
            return DBMessageStatus.GHOST_PINGED;
    }
}
