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

import JSONParser from "@streamparser/json/jsonparser.js";
import { chooseFile as chooseFileWeb } from "@utils/web";
import { Toasts } from "@webpack/common";
import { showSaveFilePicker } from "native-file-system-adapter";

import { Native } from "..";
import { importMessagesIDB, iterateAllMessagesIDB } from "../db";
import { LoggedMessageJSON } from "../types";

export async function importLogs() {
    try {
        let count = 0;
        const batchSize = 50;
        let batch: LoggedMessageJSON[] = [];

        for await (const logItems of iterateLogItems()) {
            const items = logItems.flat();

            for (const item of items) {
                const { message } = item;
                if (!message || !message.id || !message.channel_id || !message.timestamp) continue;

                batch.push(message);

                if (batch.length >= batchSize) {
                    count += await importMessagesIDB(batch);
                    batch = [];
                }
            }
        }

        if (batch.length > 0) {
            count += await importMessagesIDB(batch);
        }

        if (count === 0) {
            Toasts.show({
                id: Toasts.genId(),
                message: "No new messages found in log file",
                type: Toasts.Type.FAILURE
            });
            return;
        }

        Toasts.show({
            id: Toasts.genId(),
            message: `Successfully imported ${count} logs`,
            type: Toasts.Type.SUCCESS
        });
    } catch (e) {
        console.error(e);

        Toasts.show({
            id: Toasts.genId(),
            message: "Error importing logs. Check the console for more information",
            type: Toasts.Type.FAILURE
        });
    }
}

export async function exportLogs() {
    const filename = "message-logger-logs-idb.json";

    try {
        if (!IS_WEB) {
            const streamId = await Native.startNativeLogExport(filename);
            try {
                await Native.writeNativeLogChunk(streamId, '{\n  "messages": [\n');

                let first = true;
                for await (const record of iterateAllMessagesIDB()) {
                    const prefix = first ? "" : ",\n";
                    first = false;

                    const chunk = prefix + "    " + JSON.stringify(record.map(({ channel_id, message_id, status, message }) => ({ channel_id, message_id, status, message })));

                    await Native.writeNativeLogChunk(streamId, chunk);
                }

                await Native.writeNativeLogChunk(streamId, "\n  ]\n}");
                await Native.finishNativeLogExport(streamId);
            } finally {
                await Native.cancelNativeLogExport(streamId);
            }

            Toasts.show({
                id: Toasts.genId(),
                message: "Successfully exported logs",
                type: Toasts.Type.SUCCESS
            });
            return;
        }

        // if check needed so esbuild doenst include native-file-system-adapter in native builds
        if (IS_WEB) {
            const handle = await showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: "JSON File",
                    accept: { "application/json": [".json"] },
                }],
            });

            const writable = await handle.createWritable();
            const writer = writable.getWriter();
            const encoder = new TextEncoder();
            let count = 0;
            let completed = false;
            try {
                await writer.write(encoder.encode('{\n  "messages": [\n'));

                let first = true;
                for await (const records of iterateAllMessagesIDB()) {
                    const prefix = first ? "" : ",\n";
                    first = false;
                    const chunk = prefix + "    " + JSON.stringify(records.map(({ channel_id, message_id, status, message }) => ({ channel_id, message_id, status, message })));
                    await writer.write(encoder.encode(chunk));
                    count++;
                }

                await writer.write(encoder.encode("\n  ]\n}"));
                await writer.close();
                completed = true;
            } finally {
                try { if (!completed) await writer.abort(); }
                finally { writer.releaseLock(); }
            }

            Toasts.show({
                id: Toasts.genId(),
                message: `Successfully exported ${count} logs`,
                type: Toasts.Type.SUCCESS
            });
        }
    } catch (e) {
        console.error(e);

        Toasts.show({
            id: Toasts.genId(),
            message: "Error exporting logs. Check the console for more information",
            type: Toasts.Type.FAILURE
        });
    }
}

async function* parseJsonStream(readChunk: () => Promise<string | null>) {
    const parser = new JSONParser({
        paths: ["$.messages.*"],
        keepStack: false,
    });
    const queue: any[] = [];
    let queueIndex = 0;
    let error: Error | null = null;

    parser.onValue = ({ value }) => {
        queue.push(value);
    };

    parser.onError = (err: Error) => {
        error = err;
    };

    try {
        while (true) {
            if (error) throw error;
            while (queueIndex < queue.length) {
                yield queue[queueIndex++];
            }
            if (queueIndex > 0) {
                queue.length = 0;
                queueIndex = 0;
            }

            const chunk = await readChunk();
            if (chunk === null) break;

            parser.write(chunk);
        }
    } catch (e) {
        throw e;
    } finally {
        if (!parser.isEnded)
            parser.end();
    }

    if (error) throw error;
    while (queueIndex < queue.length) {
        yield queue[queueIndex++];
    }
}

async function* iterateLogItems(): AsyncGenerator<any> {
    if (IS_WEB) {
        const file = await chooseFileWeb(".json");
        if (!file) throw new Error("No file selected");

        const stream = file.stream();
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        try {
            yield* parseJsonStream(async () => {
                const { done, value } = await reader.read();
                if (done) return decoder.decode() || null;
                return decoder.decode(value, { stream: true });
            });
        } finally {
            try { await reader.cancel(); }
            finally { reader.releaseLock(); }
        }
    } else {
        const settings = await Native.getSettings();
        const fileId = await Native.startNativeLogImport(settings.logsDir);

        try {
            yield* parseJsonStream(async () => {
                return await Native.readNativeLogChunk(fileId);
            });
        } finally {
            await Native.closeNativeLogImport(fileId);
        }
    }
}
