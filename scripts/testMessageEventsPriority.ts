import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

import type {
    MessageContentOptions,
    MessageEditListener,
    MessageEventListenerOptions,
    MessageObject,
    MessageSendListener,
    SendMessageOptions,
    SendMessageProps,
} from "../src/api/MessageEvents";
import messageEventsPlugin from "../src/plugins/_api/messageEvents";
import { canonicalizeMatch } from "../src/utils/patches";

type MessageEventsModule = typeof import("../src/api/MessageEvents");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const runtimeStubs: Plugin = {
    name: "message-events-runtime-stubs",
    setup(build) {
        build.onResolve({ filter: /^@utils\/Logger$/ }, () => ({ path: "logger", namespace: "message-events-test" }));
        build.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: "webpack-common", namespace: "message-events-test" }));

        build.onLoad({ filter: /^logger$/, namespace: "message-events-test" }, () => ({
            contents: "export class Logger { error() {} }",
            loader: "js",
        }));
        build.onLoad({ filter: /^webpack-common$/, namespace: "message-events-test" }, () => ({
            contents: "export const MessageStore = { getMessage() { return undefined; } };",
            loader: "js",
        }));
    },
};

async function loadMessageEvents(): Promise<MessageEventsModule> {
    const result = await build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryPoints: ["src/api/MessageEvents.ts"],
        format: "esm",
        platform: "node",
        plugins: [runtimeStubs],
        write: false,
    });
    const [output] = result.outputFiles;

    assert(output, "MessageEvents test bundle was generated");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
    return import(moduleUrl);
}

const messageObj: MessageObject = {
    content: "test",
    invalidEmojis: [],
    tts: false,
    validNonShortcutEmojis: [],
};

const contentOptions: MessageContentOptions = {
    channelId: "channel",
    command: null,
    content: "test",
};

const sendOptions: SendMessageOptions = {
    ...contentOptions,
    location: "test",
};

const sendProps: SendMessageProps = {
    channel: {} as SendMessageProps["channel"],
    content: "test",
    hasAttachments: false,
    hasStickers: false,
    openWarningPopout: () => undefined,
};

function handleSend(events: MessageEventsModule): Promise<boolean> {
    return events._handlePreSend("channel", messageObj, sendOptions, sendProps, contentOptions);
}

function handleEdit(events: MessageEventsModule): Promise<boolean> {
    return events._handlePreEdit("channel", "message", messageObj);
}

function testCurrentDiscordSendPatch(): void {
    const patch = messageEventsPlugin.patches?.find(candidate => candidate.find === ".handleSendMessage,onResize:");
    assert(patch, "the MessageEvents chat-input patch exists");
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    assert.equal(patch.group, true);

    const source = `class ChatInput {handleSendMessage=async e=>Promise.resolve({valid:true}).then(v=>{let{valid:s,failureReason:r}=v;let _=tU.Ay.parse(h,t);_.tts=_.tts||A,null!=o&&(_.content="",_.components=o);let I={...x.A.getSendMessageOptions({content:t,channelId:h.id,uploads:n,stickers:l,command:i,isGif:a,pendingReply:m,alsoForwardToChannelId:p?h.parent_id??void 0:void 0,scheduledTimestamp:this.props.pendingScheduledMessage?.scheduledTimestamp}),location:nB.Hx.CHAT_INPUT};if(null!=n&&n.length>0)I.attachmentsToUpload=n;return{shouldClear:true}})};const chatInput=new ChatInput(),view={handleSendMessage:chatInput.handleSendMessage,onResize:null};`;
    let patched = source;
    for (const replacement of replacements) {
        const match = canonicalizeMatch(replacement.match);
        const next = typeof replacement.replace === "string"
            ? patched.replace(match, replacement.replace)
            : patched.replace(match, replacement.replace);
        assert.notEqual(next, patched, "each grouped replacement must match");
        patched = next;
    }

    assert.notEqual(patched, source, "the current Discord chat-input source must match the MessageEvents patch");
    assert.equal(
        patched.split("Vencord.Api.MessageEvents._handlePreSend").length - 1,
        1,
        "the current Discord chat-input send path invokes MessageEvents exactly once",
    );
    assert.match(patched, /hasAttachments:\(vcContentOptions\.uploads\?\.length\?\?0\)>0/);
    assert.doesNotThrow(() => Function(patched), "the patched current Discord chat-input source must remain valid JavaScript");
}

async function testSendOrderingAndAsyncHandlers(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const listeners: MessageSendListener[] = [];
    const add = (listener: MessageSendListener, options?: number | MessageEventListenerOptions) => {
        listeners.push(options === undefined
            ? events.addMessagePreSendListener(listener)
            : events.addMessagePreSendListener(listener, options));
    };

    try {
        add(() => { order.push("default-first"); });
        add(() => { order.push("low"); }, -10);
        add(async () => {
            order.push("high-start");
            await Promise.resolve();
            order.push("high-end");
        }, { priority: 10 });
        add(() => { order.push("default-second"); }, 0);

        assert.equal(await handleSend(events), false, "an ordinary listener chain permits the send");
        assert.deepEqual(
            order,
            ["high-start", "high-end", "default-first", "default-second", "low"],
            "send listeners run from highest to lowest priority, await async work, and preserve registration order for ties",
        );
    } finally {
        listeners.forEach(listener => events.removeMessagePreSendListener(listener));
    }
}

async function testSendStop(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const stopper: MessageSendListener = () => {
        order.push("stop");
        return { stop: true };
    };
    const skipped: MessageSendListener = () => { order.push("skipped"); };

    events.addMessagePreSendListener(skipped, -1);
    events.addMessagePreSendListener(stopper, 1);
    try {
        assert.equal(await handleSend(events), false, "stop ends listener processing without cancelling the send");
        assert.deepEqual(order, ["stop"], "listeners after stop are not invoked");
    } finally {
        events.removeMessagePreSendListener(stopper);
        events.removeMessagePreSendListener(skipped);
    }
}

async function testSendCancel(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const before: MessageSendListener = () => { order.push("before"); };
    const cancel: MessageSendListener = () => {
        order.push("cancel");
        return { cancel: true };
    };
    const skipped: MessageSendListener = () => { order.push("skipped"); };

    events.addMessagePreSendListener(skipped, -1);
    events.addMessagePreSendListener(cancel, 1);
    events.addMessagePreSendListener(before, 2);
    try {
        assert.equal(await handleSend(events), true, "the existing cancel result still aborts the send");
        assert.deepEqual(order, ["before", "cancel"], "cancel prevents all remaining listeners from running");
    } finally {
        events.removeMessagePreSendListener(before);
        events.removeMessagePreSendListener(cancel);
        events.removeMessagePreSendListener(skipped);
    }
}

async function testSendRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const removed: MessageSendListener = () => { order.push("removed"); };
    const retained: MessageSendListener = () => { order.push("retained"); };

    assert.equal(events.addMessagePreSendListener(removed, 100), removed, "add keeps returning the listener for API compatibility");
    events.addMessagePreSendListener(retained);
    assert.equal(events.removeMessagePreSendListener(removed), true, "a registered send listener can be removed");
    assert.equal(events.removeMessagePreSendListener(removed), false, "removing the same send listener twice reports false");
    try {
        assert.equal(await handleSend(events), false);
        assert.deepEqual(order, ["retained"], "a removed send listener is not invoked");
    } finally {
        events.removeMessagePreSendListener(retained);
    }
}

async function testSendDuplicateRegistrationAndMidDispatchRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const pending: MessageSendListener = () => { order.push("pending"); };
    const remover: MessageSendListener = () => {
        order.push("remover");
        events.removeMessagePreSendListener(pending);
    };
    const first: MessageSendListener = () => { order.push("first"); };

    events.addMessagePreSendListener(pending);
    events.addMessagePreSendListener(remover, 1);
    events.addMessagePreSendListener(first, 2);
    events.addMessagePreSendListener(remover, 100);
    try {
        assert.equal(await handleSend(events), false);
        assert.deepEqual(
            order,
            ["first", "remover"],
            "adding a listener twice remains a no-op and removing a pending listener prevents its invocation",
        );
    } finally {
        events.removeMessagePreSendListener(first);
        events.removeMessagePreSendListener(remover);
        events.removeMessagePreSendListener(pending);
    }
}

async function testSendThrownHandlerFailsOpen(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = () => {
        order.push("throw");
        throw new Error("expected test error");
    };
    const after: MessageSendListener = async () => {
        await Promise.resolve();
        order.push("after");
    };

    events.addMessagePreSendListener(after);
    events.addMessagePreSendListener(throwing, 1);
    try {
        assert.equal(await handleSend(events), false, "a throwing send listener fails open");
        assert.deepEqual(order, ["throw", "after"], "send processing continues after a listener throws");
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(after);
    }
}

async function testSendThrownHandlerCancelsOnError(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = async () => {
        order.push("throw-start");
        await Promise.resolve();
        order.push("throw-end");
        throw new Error("expected fail-closed test error");
    };
    const after: MessageSendListener = () => { order.push("after"); };

    events.addMessagePreSendListener(after);
    events.addMessagePreSendListener(throwing, { priority: 1, cancelOnError: true });
    try {
        assert.equal(await handleSend(events), true, "cancelOnError cancels a send when its listener rejects");
        assert.deepEqual(
            order,
            ["throw-start", "throw-end"],
            "send cancellation is returned immediately and no later listener runs",
        );
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(after);
    }
}

async function testSendDuplicatePreservesOriginalFailOpenRegistration(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = () => {
        order.push("throw");
        throw new Error("expected duplicate registration test error");
    };
    const before: MessageSendListener = () => { order.push("before"); };
    const after: MessageSendListener = () => { order.push("after"); };

    events.addMessagePreSendListener(throwing, { priority: 1 });
    events.addMessagePreSendListener(before, 2);
    events.addMessagePreSendListener(after);
    assert.equal(
        events.addMessagePreSendListener(throwing, { priority: 100, cancelOnError: true }),
        throwing,
        "duplicate add still returns the listener",
    );
    try {
        assert.equal(await handleSend(events), false, "a duplicate registration cannot change fail-open to fail-closed");
        assert.deepEqual(
            order,
            ["before", "throw", "after"],
            "a duplicate registration preserves the original priority, order, and error policy",
        );
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(before);
        events.removeMessagePreSendListener(after);
    }
}

async function testEditOrderingStopAndAsyncHandlers(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const high: MessageEditListener = async () => {
        order.push("high-start");
        await Promise.resolve();
        order.push("high-end");
    };
    const stopper: MessageEditListener = () => {
        order.push("default-stop");
        return { stop: true };
    };
    const skipped: MessageEditListener = () => { order.push("skipped"); };

    events.addMessagePreEditListener(skipped, -1);
    events.addMessagePreEditListener(stopper);
    events.addMessagePreEditListener(high, 1);
    try {
        assert.equal(await handleEdit(events), false, "stop ends edit processing without cancelling the edit");
        assert.deepEqual(
            order,
            ["high-start", "high-end", "default-stop"],
            "edit listeners honor priority, await async handlers, and stop before lower-priority handlers",
        );
    } finally {
        events.removeMessagePreEditListener(high);
        events.removeMessagePreEditListener(stopper);
        events.removeMessagePreEditListener(skipped);
    }
}

async function testEditCancelAndRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const removed: MessageEditListener = () => { order.push("removed"); };
    const cancel: MessageEditListener = async () => {
        await Promise.resolve();
        order.push("cancel");
        return { cancel: true };
    };
    const skipped: MessageEditListener = () => { order.push("skipped"); };

    assert.equal(events.addMessagePreEditListener(removed, 100), removed, "edit add keeps returning the listener");
    events.addMessagePreEditListener(skipped, -1);
    events.addMessagePreEditListener(cancel, 1);
    assert.equal(events.removeMessagePreEditListener(removed), true, "a registered edit listener can be removed");
    assert.equal(events.removeMessagePreEditListener(removed), false, "removing the same edit listener twice reports false");
    try {
        assert.equal(await handleEdit(events), true, "cancel still aborts an edit");
        assert.deepEqual(order, ["cancel"], "removed and post-cancel edit listeners are not invoked");
    } finally {
        events.removeMessagePreEditListener(cancel);
        events.removeMessagePreEditListener(skipped);
    }
}

async function testEditThrownHandlerFailsOpen(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected test error");
    };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, 1);
    try {
        assert.equal(await handleEdit(events), false, "a throwing edit listener fails open");
        assert.deepEqual(order, ["throw", "after"], "edit processing continues after a listener throws");
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(after);
    }
}

async function testEditThrownHandlerCancelsOnError(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected fail-closed test error");
    };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, { priority: 1, cancelOnError: true });
    try {
        assert.equal(await handleEdit(events), true, "cancelOnError cancels an edit when its listener throws");
        assert.deepEqual(order, ["throw"], "edit cancellation is returned immediately and no later listener runs");
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(after);
    }
}

async function testEditDuplicatePreservesOriginalFailClosedRegistration(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected duplicate registration test error");
    };
    const before: MessageEditListener = () => { order.push("before"); };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(throwing, { priority: 1, cancelOnError: true });
    events.addMessagePreEditListener(before, 2);
    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, -100);
    try {
        assert.equal(await handleEdit(events), true, "a duplicate registration cannot change fail-closed to fail-open");
        assert.deepEqual(
            order,
            ["before", "throw"],
            "a duplicate registration preserves its original priority and prevents later edit listeners",
        );
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(before);
        events.removeMessagePreEditListener(after);
    }
}

async function main(): Promise<void> {
    testCurrentDiscordSendPatch();
    const events = await loadMessageEvents();

    await testSendOrderingAndAsyncHandlers(events);
    await testSendStop(events);
    await testSendCancel(events);
    await testSendRemoval(events);
    await testSendDuplicateRegistrationAndMidDispatchRemoval(events);
    await testSendThrownHandlerFailsOpen(events);
    await testSendThrownHandlerCancelsOnError(events);
    await testSendDuplicatePreservesOriginalFailOpenRegistration(events);
    await testEditOrderingStopAndAsyncHandlers(events);
    await testEditCancelAndRemoval(events);
    await testEditThrownHandlerFailsOpen(events);
    await testEditThrownHandlerCancelsOnError(events);
    await testEditDuplicatePreservesOriginalFailClosedRegistration(events);

    console.log("message event priority checks passed");
}

void main();
