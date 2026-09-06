/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Bump this on every change that gets injected locally, so the settings tab shows whether the rebuild landed.
import { EXTENDED_BLOCKS, EXTENDED_DEFAULTS, EXTENDED_TYPES } from "./catalog";
import { CLIENT_EVENT_TYPES, type ClientEventType, isClientEventType } from "./clientEvents";
import { eventOutputFields, outputFields } from "./outputs";
import { SYSTEM_TRIGGER_TYPES } from "./system";

export const LAYOUT_VERSION = 2;
export const AUTOMATION_FILE_FORMAT = "lawyercord-automation";
export const AUTOMATION_FILE_VERSION = 2;

export const AUTOMATION_UNITS = ["minutes", "hours", "days", "weeks", "months", "years"] as const;
export type AutomationUnit = typeof AUTOMATION_UNITS[number];
export const AUTOMATION_TRIGGER_TYPES = ["schedule", "mention", "message", "dm", "startup", "message-edit", "message-delete", "reaction-add", "reaction-remove", "voice-join", "voice-leave", "voice-move", ...CLIENT_EVENT_TYPES, ...SYSTEM_TRIGGER_TYPES] as const;
export type AutomationTriggerType = typeof AUTOMATION_TRIGGER_TYPES[number];

export const AUTOMATION_BLOCK_TYPES = [
    ...EXTENDED_TYPES,
    "send-message",
    "send-embed",
    "send-components",
    "send-dm",
    "reply-message",
    "edit-message",
    "delete-message",
    "react-message",
    "remove-reaction",
    "pin-message",
    "unpin-message",
    "forward-message",
    "create-thread",
    "mark-read",
    "typing-indicator",
    "open-channel",
    "crosspost-message",
    "search-messages",
    "get-user",
    "list-connections",
    "spotify-play",
    "spotify-pause",
    "spotify-next",
    "spotify-previous",
    "spotify-seek",
    "spotify-volume",
    "spotify-now-playing",
    "notify",
    "split-text",
    "regex-extract",
    "random-item",
    "run-command",
    "wait-reply",
    "wait-dm",
    "wait-until",
    "fetch-dm",
    "fetch-messages",
    "fetch-mentions",
    "fetch-unread",
    "interact-button",
    "interact-select",
    "interact-modal",
    "read-components",
    "read-embed",
    "delay",
    "set-variable",
    "math-variable",
    "delete-variable",
    "text-variable",
    "random-number",
    "current-time",
    "array-length",
    "join-array",
    "json-value",
    "filter-array",
    "ai-prompt",
    "ai-summarize",
    "ai-classify",
    "ai-extract-json",
    "condition",
    "else",
    "end-if",
    "chance",
    "repeat",
    "end-repeat",
    "break-loop",
    "stop",
    "fail",
    "log",
    "note",
    "list-processes",
    "check-process",
    "wait-process",
    "run-program",
    "read-file",
    "open-link",
    "roblox-current-game",
    "roblox-game-info",
    "codex-last-turn",
    "codex-sessions",
] as const;
export type AutomationBlockType = typeof AUTOMATION_BLOCK_TYPES[number];

export const AUTOMATION_BLOCK_CATEGORIES = ["messages", "commands", "client", "spotify", "data", "ai", "waits", "interactions", "flow", "variables", "computer", "roblox", "codex"] as const;
export type AutomationBlockCategory = typeof AUTOMATION_BLOCK_CATEGORIES[number];

export interface BlockDefinition {
    type: AutomationBlockType;
    label: string;
    description: string;
    category: AutomationBlockCategory;
    available?: boolean;
}

export const BLOCK_DEFINITIONS: readonly BlockDefinition[] = [
    ...EXTENDED_BLOCKS,
    { type: "send-message", label: "Send message", description: "Post text in a channel.", category: "messages" },
    { type: "send-embed", label: "Send embed", description: "Legacy app-only block.", category: "messages", available: false },
    { type: "send-components", label: "Send Components V2", description: "Legacy app-only block.", category: "messages", available: false },
    { type: "send-dm", label: "Send DM", description: "Open a DM and post a message.", category: "messages" },
    { type: "reply-message", label: "Reply to message", description: "Reply to a saved Discord message.", category: "messages" },
    { type: "edit-message", label: "Edit message", description: "Edit a message sent by this account.", category: "messages" },
    { type: "delete-message", label: "Delete message", description: "Delete a saved message.", category: "messages" },
    { type: "react-message", label: "Add reaction", description: "React to a saved message with an emoji.", category: "messages" },
    { type: "remove-reaction", label: "Remove reaction", description: "Take your reaction back off a message.", category: "messages" },
    { type: "pin-message", label: "Pin message", description: "Pin a saved message in its channel.", category: "messages" },
    { type: "unpin-message", label: "Unpin message", description: "Remove a saved message from the pins.", category: "messages" },
    { type: "forward-message", label: "Forward message", description: "Forward a saved message to another channel.", category: "messages" },
    { type: "create-thread", label: "Start thread", description: "Open a thread on a saved message.", category: "messages" },
    { type: "mark-read", label: "Mark as read", description: "Clear the unread marker on a channel.", category: "client" },
    { type: "typing-indicator", label: "Show typing", description: "Send the typing indicator in a channel.", category: "client" },
    { type: "open-channel", label: "Open channel", description: "Jump the client to a channel.", category: "client" },
    { type: "crosspost-message", label: "Publish announcement", description: "Push a message from an announcement channel to followers.", category: "messages" },
    { type: "search-messages", label: "Search messages", description: "Find messages in a server and save the matches.", category: "data" },
    { type: "get-user", label: "Look up a user", description: "Save a user's profile details.", category: "data" },
    { type: "list-connections", label: "List my connections", description: "Save the accounts linked in Discord settings.", category: "data" },
    { type: "notify", label: "Notify me", description: "Show a LawyerCord notification.", category: "client" },
    { type: "spotify-play", label: "Play", description: "Resume Spotify on the active device.", category: "spotify" },
    { type: "spotify-pause", label: "Pause", description: "Pause Spotify.", category: "spotify" },
    { type: "spotify-next", label: "Next track", description: "Skip to the next Spotify track.", category: "spotify" },
    { type: "spotify-previous", label: "Previous track", description: "Go back a Spotify track.", category: "spotify" },
    { type: "spotify-seek", label: "Seek", description: "Jump to a position in the current track.", category: "spotify" },
    { type: "spotify-volume", label: "Set volume", description: "Set Spotify playback volume.", category: "spotify" },
    { type: "spotify-now-playing", label: "Now playing", description: "Save the track Spotify is on.", category: "spotify" },
    { type: "split-text", label: "Split text", description: "Break text into a list on a separator.", category: "variables" },
    { type: "regex-extract", label: "Extract with regex", description: "Pull the first match out of text.", category: "variables" },
    { type: "random-item", label: "Pick a random item", description: "Choose one entry from a list.", category: "variables" },
    { type: "run-command", label: "Run command", description: "Invoke a slash or context menu command.", category: "commands" },
    { type: "wait-reply", label: "Wait for reply", description: "Pause until a matching channel message arrives.", category: "waits" },
    { type: "wait-dm", label: "Wait for DM", description: "Pause until a matching DM arrives.", category: "waits" },
    { type: "wait-until", label: "Wait until time", description: "Pause until an exact date or timestamp.", category: "waits" },
    { type: "fetch-dm", label: "Read latest DMs", description: "Open a user's DM and save recent messages.", category: "data" },
    { type: "fetch-messages", label: "Fetch channel messages", description: "Save recent messages from a channel.", category: "data" },
    { type: "fetch-mentions", label: "Fetch recent mentions", description: "Save recent messages that mention you.", category: "data" },
    { type: "fetch-unread", label: "Fetch unread messages", description: "Save messages after the channel read marker.", category: "data" },
    { type: "ai-prompt", label: "Ask AI", description: "Run a custom prompt through OpenRouter.", category: "ai" },
    { type: "ai-summarize", label: "Summarize with AI", description: "Turn messages or text into a concise summary.", category: "ai" },
    { type: "ai-classify", label: "Classify with AI", description: "Choose one label for an input.", category: "ai" },
    { type: "ai-extract-json", label: "Extract structured data", description: "Return validated JSON from unstructured text.", category: "ai" },
    { type: "interact-button", label: "Interact with button", description: "Click a button from a saved message.", category: "interactions" },
    { type: "interact-select", label: "Interact with select menu", description: "Choose an option from a saved message.", category: "interactions" },
    { type: "interact-modal", label: "Submit modal", description: "Submit structured modal fields.", category: "interactions" },
    { type: "read-components", label: "List buttons and menus", description: "Save every button and menu on a message, with its row and label.", category: "interactions" },
    { type: "read-embed", label: "Read embed", description: "Save an embed's title, text, fields and images.", category: "data" },
    { type: "delay", label: "Wait", description: "Pause for a precise amount of time.", category: "waits" },
    { type: "list-processes", label: "List running programs", description: "Save every program running on this computer.", category: "computer" },
    { type: "check-process", label: "Is a program running?", description: "Branch on whether a program is open right now.", category: "computer" },
    { type: "wait-process", label: "Wait for a program", description: "Pause until a program starts or closes.", category: "computer" },
    { type: "run-program", label: "Run a program", description: "Start a program or script and save what it prints.", category: "computer" },
    { type: "read-file", label: "Read a file", description: "Save the text of a file in your user folder.", category: "computer" },
    { type: "open-link", label: "Open a link", description: "Open an https link in your browser.", category: "computer" },
    { type: "roblox-current-game", label: "Current Roblox game", description: "Save the game you are playing, with players, visits and icon.", category: "roblox" },
    { type: "roblox-game-info", label: "Look up a Roblox game", description: "Save a game's details from its place or universe ID.", category: "roblox" },
    { type: "codex-last-turn", label: "Last Codex result", description: "Save what Codex last finished, with its closing message.", category: "codex" },
    { type: "codex-sessions", label: "Recent Codex sessions", description: "Save the latest Codex sessions and their projects.", category: "codex" },
    { type: "condition", label: "If", description: "Start a conditional branch.", category: "flow" },
    { type: "else", label: "Else", description: "Run when the matching If is false.", category: "flow" },
    { type: "end-if", label: "End If", description: "Close an If and Else branch.", category: "flow" },
    { type: "chance", label: "Chance", description: "Branch using a configurable percentage.", category: "flow" },
    { type: "repeat", label: "Repeat", description: "Run enclosed blocks a fixed number of times.", category: "flow" },
    { type: "end-repeat", label: "End Repeat", description: "Close a repeat loop.", category: "flow" },
    { type: "break-loop", label: "Break loop", description: "Exit the nearest repeat loop.", category: "flow" },
    { type: "stop", label: "Stop automation", description: "Finish the workflow successfully.", category: "flow" },
    { type: "fail", label: "Fail automation", description: "Stop and write a custom failure log.", category: "flow" },
    { type: "set-variable", label: "Set variable", description: "Save a reusable value for later blocks.", category: "variables" },
    { type: "math-variable", label: "Variable math", description: "Add, subtract, multiply, divide, or round.", category: "variables" },
    { type: "delete-variable", label: "Delete variable", description: "Remove a value from the current run.", category: "variables" },
    { type: "text-variable", label: "Manipulate text", description: "Replace, append, trim, or change case.", category: "variables" },
    { type: "random-number", label: "Random number", description: "Generate an integer inside a range.", category: "variables" },
    { type: "current-time", label: "Current time", description: "Save the current timestamp or ISO date.", category: "variables" },
    { type: "array-length", label: "Count items", description: "Count items in an array or characters in text.", category: "variables" },
    { type: "join-array", label: "Join items", description: "Combine array items into text.", category: "variables" },
    { type: "json-value", label: "Read data path", description: "Read a nested object or array value.", category: "variables" },
    { type: "filter-array", label: "Filter items", description: "Keep array items that match a condition.", category: "variables" },
    { type: "log", label: "Write log", description: "Add a named checkpoint to the run log.", category: "flow" },
    { type: "note", label: "Note", description: "Document the workflow without running anything.", category: "flow" },
];

export interface Schedule {
    mode?: "interval" | "calendar" | "cron";
    timezone?: string;
    weekdays?: number[];
    time?: string;
    cron?: string;
    activeStart?: string;
    activeEnd?: string;
    missed?: "skip" | "once" | "legacy";
    interval: number;
    unit: AutomationUnit;
    startAt: number;
}

export interface AutomationTrigger {
    status?: string;
    emoji?: string;
    includeBots?: boolean;
    type: AutomationTriggerType;
    /** Let your own messages fire this trigger, for command-word style automations. */
    includeSelf?: boolean;
    /** Codex triggers: also fire for helper agents Codex spawns, not just the main conversation. */
    includeSubagents?: boolean;
    /** The server the chosen channel belongs to, so the picker can show it again. */
    guildId?: string;
    channelId?: string;
    authorId?: string;
    matchMode?: AutomationMatchMode;
    matchText?: string;
}

export interface EmbedConfig {
    title: string;
    description: string;
    url: string;
    color: string;
    footer: string;
    imageUrl: string;
    thumbnailUrl: string;
}

export interface AutomationComponentOption {
    label: string;
    value: string;
    description?: string;
    default?: boolean;
}

export interface AutomationComponent {
    type: number;
    /** Components V2 gives every component a numeric id, stable across renders. */
    id?: number;
    content?: string;
    style?: number;
    label?: string;
    custom_id?: string;
    url?: string;
    disabled?: boolean;
    required?: boolean;
    placeholder?: string;
    min_values?: number;
    max_values?: number;
    min_length?: number;
    max_length?: number;
    value?: string;
    options?: AutomationComponentOption[];
    components?: AutomationComponent[];
}

export interface AutomationCommandOptionValue {
    name: string;
    type: number;
    value: string | number | boolean;
}

export type AutomationMatchMode = "contains" | "exact" | "regex";
export type AutomationOptionMode = "exact" | "contains" | "regex" | "index";

export type AutomationPort = "next" | "alternate" | "error";
export type ValueInput = { kind: "literal"; value: unknown; } | { kind: "reference" | "template"; value: string; };
export interface AutomationBlockConfig {
    eventType?: ClientEventType;
    status?: string;
    jsonDrafts?: Record<string, string>;
    input?: ValueInput;
    secondInput?: ValueInput;
    workflowId?: string;
    cases?: { value: string; target: string; }[];
    persistentKey?: string;
    descending?: boolean;
    deviceId?: string;
    retryCount?: number;
    retryDelaySeconds?: number;
    sample?: unknown;
    conversation?: string;
    schema?: string;
    unsupported?: Record<string, unknown>;

    channelId?: string;
    guildId?: string;
    content?: string;
    userId?: string;
    authorId?: string;
    commandId?: string;
    applicationId?: string;
    commandName?: string;
    optionsJson?: string;
    commandOptions?: AutomationCommandOptionValue[];
    embed?: EmbedConfig;
    componentsJson?: string;
    components?: AutomationComponent[];
    timeoutSeconds?: number;
    variable?: string;
    sourceVariable?: string;
    matchMode?: AutomationMatchMode;
    matchText?: string;
    componentRow?: number;
    componentIndex?: number;
    customId?: string;
    optionMode?: AutomationOptionMode;
    optionQuery?: string;
    modalFieldsJson?: string;
    modalFields?: AutomationComponent[];
    messageId?: string;
    limit?: number;
    durationSeconds?: number;
    value?: string;
    operator?: "equals" | "not-equals" | "contains" | "greater" | "less" | "regex";
    compareValue?: string;
    skipCount?: number;
    repeatCount?: number;
    chancePercent?: number;
    operation?: "add" | "subtract" | "multiply" | "divide" | "round" | "uppercase" | "lowercase" | "trim" | "replace" | "append" | "prepend";
    amount?: number;
    needle?: string;
    replacement?: string;
    min?: number;
    max?: number;
    emoji?: string;
    errorMessage?: string;
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    labels?: string;
    fieldPath?: string;
    separator?: string;
    beforeMessageId?: string;
    includeBots?: boolean;
    targetId?: string;
    name?: string;
    /** Message blocks: write the body with AI instead of sending the text as typed. */
    aiEnabled?: boolean;
    /** Message blocks: let pings actually notify people. Off by default. */
    allowMentions?: boolean;
    /** Message blocks: send without a notification sound. */
    silent?: boolean;
    /** Interaction blocks: how to find the component. Defaults to the custom ID. */
    componentMatch?: "customId" | "label" | "position";
    /** Interaction blocks: the button or menu label to look for. */
    componentLabel?: string;
    /** Read embed: which embed on the message, 1 based. */
    embedIndex?: number;
    /** Message blocks: what the inline AI reads. Kept apart from the source message. */
    aiInput?: string;
    /** Wait blocks: only accept a genuine reply to the message the flow just sent. */
    requireReply?: boolean;
}

/** Points every target of an edge at its new id, used when copying an automation. */
export function remapEdge(edge: AutomationEdge | undefined, ids: Map<string, string>): AutomationEdge | undefined {
    const next = edgeTargets(edge).map(id => ids.get(id)).filter((id): id is string => id !== undefined);
    if (!next.length) return undefined;
    return next.length === 1 ? next[0] : next;
}

/** One target, or several when a port fans out. */
export type AutomationEdge = string | string[];

/** Every block a port points at, in the order they run. */
export function edgeTargets(edge: AutomationEdge | undefined): string[] {
    if (edge === undefined) return [];
    return Array.isArray(edge) ? edge : [edge];
}

/** Adds a target to a port, keeping a single target as a plain string. */
export function addEdgeTarget(edge: AutomationEdge | undefined, id: string): AutomationEdge {
    const targets = edgeTargets(edge);
    if (targets.includes(id)) return edge ?? id;
    const next = [...targets, id];
    return next.length === 1 ? next[0] : next;
}

/** Removes one target, collapsing back to a plain string or nothing. */
export function removeEdgeTarget(edge: AutomationEdge | undefined, id: string): AutomationEdge | undefined {
    const next = edgeTargets(edge).filter(target => target !== id);
    if (!next.length) return undefined;
    return next.length === 1 ? next[0] : next;
}

/** Drops any target that no longer exists, used after deleting a block. */
export function keepEdgeTargets(edge: AutomationEdge | undefined, exists: (id: string) => boolean): AutomationEdge | undefined {
    const next = edgeTargets(edge).filter(exists);
    if (!next.length) return undefined;
    return next.length === 1 ? next[0] : next;
}

export interface AutomationBlock {
    id: string;
    type: AutomationBlockType;
    config: AutomationBlockConfig;
    position?: { x: number; y: number; };
    /**
     * Where the flow goes on success, or down the true branch of a condition. A list runs
     * every target, one after another, so one block can feed several.
     */
    next?: AutomationEdge;
    /** Where the flow goes on the false branch, or when a repeat finishes. */
    alternate?: AutomationEdge;
    error?: AutomationEdge;
}

export interface Automation {
    schemaVersion?: 2;
    /** Positions laid out for the current node geometry. Older layouts are re-arranged when opened. */
    layoutVersion?: number;
    entryId?: string;
    runMode?: "queue" | "skip" | "parallel";
    concurrency?: number;
    queueLimit?: number;
    cooldownSeconds?: number;
    maxSteps?: number;
    lastScheduledAt?: number;
    ai?: { model?: string; systemPrompt?: string; temperature?: number; maxTokens?: number; timeoutSeconds?: number; };

    id: string;
    name: string;
    enabled: boolean;
    /** Give up on a run after this many minutes. 0 means no limit. */
    maxRunMinutes?: number;
    trigger: AutomationTrigger;
    schedule: Schedule;
    blocks: AutomationBlock[];
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: "success" | "failure";
}

/** Blocks that save a structured value, so the variable hints can offer the fields inside it. */
const BLOCK_VARIABLE_FIELDS: Partial<Record<AutomationBlockType, string[]>> = {
    "spotify-now-playing": ["id", "name", "artist", "artists", "album", "duration", "url"],
    "get-user": ["id", "username", "global_name", "discriminator", "avatar", "bot"],
    "read-embed": ["title", "description", "url", "color", "author.name", "footer.text"],
    "list-connections": ["0.type", "0.name", "0.id", "0.verified"],
    "read-components": ["0.type", "0.label", "0.custom_id"],
    "search-messages": ["0.id", "0.content", "0.author.id"],
    "roblox-current-game": ["game.name", "game.playing", "game.visits", "game.url", "game.icon", "game.placeId", "game.creator", "duration"],
    "roblox-game-info": ["name", "playing", "visits", "url", "icon", "placeId", "universeId", "creator"],
    "codex-last-turn": ["project", "cwd", "message", "question", "duration", "status"],
    "codex-sessions": ["0.project", "0.cwd", "0.originator"],
    "list-processes": ["0.name", "0.pid", "0.memoryKb"],
    "run-program": ["stdout", "stderr", "code"],
};

export function getAutomationVariableNames(automation: Automation, beforeBlockId?: string): string[] {
    const names = new Set<string>();
    const { type } = automation.trigger;
    if (type.startsWith("roblox-")) for (const name of ["game", "game.name", "game.playing", "game.visits", "game.url", "game.icon", "game.placeId", "game.creator", "joinedAt", ...(type === "roblox-leave" ? ["duration", "durationMs"] : [])]) names.add(name);
    if (type.startsWith("process-")) { names.add("process.name"); names.add("process.pid"); }
    if (type.startsWith("codex-")) for (const name of ["codex", "codex.project", "codex.cwd", "codex.message", "codex.question", "codex.duration", "codex.durationMs"]) names.add(name);
    if (isClientEventType(type)) {
        for (const field of eventOutputFields(type)) names.add(`triggerEvent.${field.path}`);
        names.add("triggerUserId");
    }
    if (!isClientEventType(type) && type !== "schedule" && type !== "startup" && !SYSTEM_TRIGGER_TYPES.some(candidate => candidate === type)) {
        names.add("triggerMessage");
        names.add("triggerMessage.id");
        names.add("triggerMessage.channel_id");
        names.add("triggerMessage.author.id");
        names.add("triggerMessage.content");
        names.add("triggerUserId");
    }
    // Follow the edges once the workflow is a graph. Blocks that are not wired up yet still
    // fall back to list order, so variables show while a workflow is being built.
    const blocks = beforeBlockId === undefined
        ? automation.blocks
        : isGraph(automation.blocks)
            ? upstreamChain(automation.blocks, beforeBlockId).reverse()
            : automation.blocks.slice(0, Math.max(0, automation.blocks.findIndex(block => block.id === beforeBlockId)));
    const addMessage = (name: string) => {
        names.add(name);
        names.add(`${name}.id`);
        names.add(`${name}.channel_id`);
        names.add(`${name}.author.id`);
        names.add(`${name}.content`);
    };

    for (const block of blocks) {
        const variable = block.config.variable?.trim();
        if (block.type === "delete-variable") {
            const deleted = block.config.sourceVariable?.trim();
            if (deleted) for (const name of names) if (name === deleted || name.startsWith(`${deleted}.`)) names.delete(name);
            continue;
        }
        if (variable) names.add(variable);
        if (variable) for (const field of [...BLOCK_VARIABLE_FIELDS[block.type] ?? [], ...outputFields(block.type, block.config.eventType).map(field => field.path)]) names.add(`${variable}.${field}`);
        if (block.type === "wait-reply" || block.type === "wait-dm") names.add("replyUserId");
        if (["send-message", "send-embed", "send-components", "send-dm", "reply-message", "edit-message", "forward-message", "wait-reply", "wait-dm", "interact-button", "interact-select", "interact-modal"].includes(block.type)) {
            addMessage("lastMessage");
            if (variable) addMessage(variable);
        }
        if (["fetch-dm", "fetch-messages", "fetch-mentions", "fetch-unread"].includes(block.type) && variable) {
            names.add(`${variable}.0.id`);
            names.add(`${variable}.0.author.id`);
            names.add(`${variable}.0.content`);
        }
    }

    return [...names];
}

export interface AutomationLog {
    usage?: string;
    inputPreview?: string;
    runId?: string;
    port?: AutomationPort;
    preview?: string;
    id: string;
    automationId: string;
    automationName: string;
    status: "running" | "success" | "failure";
    message: string;
    timestamp: number;
    blockId?: string;
    blockLabel?: string;
    durationMs?: number;
}

export interface GuildReference {
    id: string;
    name: string | null;
    icon: string | null;
    banner: string | null;
    inviteCode: string | null;
    available: boolean;
    error?: string;
}

export interface AutomationFile {
    format: typeof AUTOMATION_FILE_FORMAT;
    version: typeof AUTOMATION_FILE_VERSION;
    exportedAt: string;
    automations: Automation[];
    guilds: GuildReference[];
}

function newId(): string {
    return crypto.randomUUID();
}

function defaultEmbed(): EmbedConfig {
    return {
        title: "",
        description: "",
        url: "",
        color: "#5865f2",
        footer: "",
        imageUrl: "",
        thumbnailUrl: "",
    };
}

function defaultComponents(): AutomationComponent[] {
    return [
        {
            type: 1,
            components: [{ type: 2, style: 1, label: "Continue", custom_id: "continue" }],
        },
    ];
}

function defaultModalFields(): AutomationComponent[] {
    return [
        {
            type: 1,
            components: [{ type: 4, style: 1, label: "Value", custom_id: "value", required: true }],
        },
    ];
}

export function createAutomationBlock(type: AutomationBlockType): AutomationBlock {
    const common = { variable: "lastMessage" };
    let config: AutomationBlockConfig = {};

    switch (type) {
        case "send-message":
            config = { ...common, channelId: "", content: "" };
            break;
        case "send-embed":
            config = { ...common, channelId: "", content: "", embed: defaultEmbed() };
            break;
        case "send-components":
            config = { ...common, channelId: "", content: "", components: defaultComponents() };
            break;
        case "send-dm":
            config = { ...common, userId: "", content: "" };
            break;
        case "reply-message":
        case "edit-message":
            config = { ...common, sourceVariable: "lastMessage", channelId: "", messageId: "", content: "" };
            break;
        case "delete-message":
            config = { sourceVariable: "lastMessage", channelId: "", messageId: "" };
            break;
        case "react-message":
        case "remove-reaction":
            config = { sourceVariable: "lastMessage", channelId: "", messageId: "", emoji: "👍" };
            break;
        case "pin-message":
        case "unpin-message":
            config = { sourceVariable: "lastMessage", channelId: "", messageId: "" };
            break;
        case "forward-message":
            config = { ...common, sourceVariable: "lastMessage", messageId: "", guildId: "", channelId: "" };
            break;
        case "create-thread":
            config = { sourceVariable: "lastMessage", messageId: "", channelId: "", name: "New thread" };
            break;
        case "mark-read":
            config = { sourceVariable: "lastMessage", guildId: "", channelId: "", messageId: "" };
            break;
        case "typing-indicator":
            config = { guildId: "", channelId: "", durationSeconds: 3 };
            break;
        case "open-channel":
            config = { guildId: "", channelId: "" };
            break;
        case "crosspost-message":
            config = { sourceVariable: "lastMessage", channelId: "", messageId: "" };
            break;
        case "search-messages":
            config = { guildId: "", channelId: "", matchText: "", limit: 25, variable: "results" };
            break;
        case "get-user":
            config = { userId: "", variable: "user" };
            break;
        case "list-connections":
            config = { variable: "connections" };
            break;
        case "notify":
            config = { name: "Automation", content: "" };
            break;
        case "spotify-seek":
            config = { durationSeconds: 30 };
            break;
        case "spotify-volume":
            config = { amount: 50 };
            break;
        case "spotify-now-playing":
            config = { variable: "track" };
            break;
        case "spotify-play":
        case "spotify-pause":
        case "spotify-next":
        case "spotify-previous":
            config = {};
            break;
        case "split-text":
            config = { sourceVariable: "text", separator: "\n", variable: "parts" };
            break;
        case "regex-extract":
            config = { sourceVariable: "text", matchText: "", variable: "match" };
            break;
        case "random-item":
            config = { sourceVariable: "messages", variable: "picked" };
            break;
        case "run-command":
            config = { guildId: "", channelId: "", commandId: "", applicationId: "", commandName: "", targetId: "", commandOptions: [] };
            break;
        case "wait-reply":
            config = { channelId: "", authorId: "", matchMode: "contains", matchText: "", timeoutSeconds: 60, requireReply: true, variable: "reply" };
            break;
        case "wait-dm":
            config = { userId: "", matchMode: "contains", matchText: "", timeoutSeconds: 60, variable: "dmReply" };
            break;
        case "wait-until":
            config = { value: new Date(Date.now() + 60_000).toISOString() };
            break;
        case "fetch-dm":
            config = { userId: "", limit: 10, variable: "latestMessages" };
            break;
        case "fetch-messages":
            config = { channelId: "", limit: 25, includeBots: true, variable: "messages" };
            break;
        case "fetch-mentions":
            config = { limit: 50, includeBots: true, variable: "mentions" };
            break;
        case "fetch-unread":
            config = { channelId: "", limit: 50, includeBots: true, variable: "unreadMessages" };
            break;
        case "ai-prompt":
            config = { content: "", sourceVariable: "", systemPrompt: "", model: "", maxTokens: 800, temperature: 0.2, variable: "aiResult" };
            break;
        case "ai-summarize":
            config = { content: "", sourceVariable: "messages", systemPrompt: "", model: "", maxTokens: 800, temperature: 0.2, variable: "summary" };
            break;
        case "ai-classify":
            config = { content: "", sourceVariable: "", labels: "important, normal, ignore", systemPrompt: "", model: "", maxTokens: 64, temperature: 0, variable: "classification" };
            break;
        case "ai-extract-json":
            config = { content: "", sourceVariable: "", systemPrompt: "", model: "", maxTokens: 800, temperature: 0, variable: "data" };
            break;
        case "interact-button":
            config = { sourceVariable: "lastMessage", componentMatch: "label", componentLabel: "", customId: "", componentRow: 1, componentIndex: 1, variable: "lastMessage" };
            break;
        case "read-components":
            config = { sourceVariable: "lastMessage", variable: "components" };
            break;
        case "read-embed":
            config = { sourceVariable: "lastMessage", embedIndex: 1, variable: "embed" };
            break;
        case "interact-select":
            config = { sourceVariable: "lastMessage", componentMatch: "label", componentLabel: "", customId: "", componentRow: 1, componentIndex: 1, optionMode: "exact", optionQuery: "", variable: "lastMessage" };
            break;
        case "interact-modal":
            config = { sourceVariable: "lastMessage", customId: "", modalFields: defaultModalFields(), variable: "lastMessage" };
            break;
        case "delay":
            config = { durationSeconds: 1 };
            break;
        case "list-processes":
            config = { variable: "processes" };
            break;
        case "check-process":
            config = { name: "" };
            break;
        case "wait-process":
            config = { name: "", value: "start", timeoutSeconds: 300 };
            break;
        case "run-program":
            config = { value: "", content: "", timeoutSeconds: 60, variable: "output" };
            break;
        case "read-file":
            config = { value: "", limit: 200_000, variable: "fileText" };
            break;
        case "open-link":
            config = { value: "https://" };
            break;
        case "roblox-current-game":
            config = { variable: "game" };
            break;
        case "roblox-game-info":
            config = { value: "", variable: "game" };
            break;
        case "codex-last-turn":
            config = { variable: "codex" };
            break;
        case "codex-sessions":
            config = { limit: 10, variable: "sessions" };
            break;
        case "set-variable":
            config = { variable: "value", value: "" };
            break;
        case "math-variable":
            config = { sourceVariable: "value", variable: "value", operation: "add", amount: 1 };
            break;
        case "delete-variable":
            config = { sourceVariable: "value" };
            break;
        case "text-variable":
            config = { sourceVariable: "value", variable: "value", operation: "trim", value: "", needle: "", replacement: "" };
            break;
        case "random-number":
            config = { variable: "random", min: 1, max: 100 };
            break;
        case "current-time":
            config = { variable: "now", value: "iso" };
            break;
        case "array-length":
            config = { sourceVariable: "messages", variable: "count" };
            break;
        case "join-array":
            config = { sourceVariable: "messages", fieldPath: "content", separator: "\n", variable: "text" };
            break;
        case "json-value":
            config = { sourceVariable: "data", fieldPath: "", variable: "value" };
            break;
        case "filter-array":
            config = { sourceVariable: "messages", fieldPath: "content", operator: "contains", compareValue: "", variable: "filtered" };
            break;
        case "condition":
            config = { sourceVariable: "", operator: "equals", compareValue: "", skipCount: 1 };
            break;
        case "chance":
            config = { chancePercent: 50 };
            break;
        case "repeat":
            config = { repeatCount: 2, variable: "loopIndex" };
            break;
        case "fail":
            config = { errorMessage: "Automation stopped at a failure block." };
            break;
        case "log":
        case "note":
            config = { content: "" };
            break;
        case "else":
        case "end-if":
        case "end-repeat":
        case "break-loop":
        case "stop":
            config = {};
            break;

    }

    if (type.startsWith("ai-")) { delete config.maxTokens; delete config.temperature; }
    return { id: newId(), type, config: structuredClone(EXTENDED_DEFAULTS[type] ?? config) };
}

export function createAutomation(): Automation {
    const now = Date.now();
    return {
        id: newId(),
        name: "New automation",
        enabled: false,
        schemaVersion: 2,
        layoutVersion: LAYOUT_VERSION,
        runMode: "queue",
        concurrency: 1,
        queueLimit: 50,
        maxSteps: 10_000,
        trigger: { type: "schedule" },
        maxRunMinutes: 15,
        schedule: { mode: "interval", interval: 1, unit: "hours", startAt: now + 60_000, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, missed: "skip" },
        blocks: [],
        createdAt: now,
        updatedAt: now,
    };
}

/** A deep copy of one block, keeping its id and wiring. */
export function cloneBlock(block: AutomationBlock): AutomationBlock {
    return structuredClone(block);
}

export function cloneAutomation(automation: Automation): Automation {
    return structuredClone(automation);
}

/**
 * A standalone copy of an automation, with fresh ids throughout so it can live alongside the
 * original. Edges are remapped to the new block ids rather than pointing back at the source.
 */
export function remapBlockConfig(config: AutomationBlockConfig, ids: Map<string, string>): AutomationBlockConfig {
    const json = JSON.stringify(config).replace(/blocks\.([\w-]+)\./g, (match: string, id: string) => ids.has(id) ? `blocks.${ids.get(id)}.` : match);
    const copy: AutomationBlockConfig = JSON.parse(json);
    if (copy.cases) copy.cases = copy.cases.map(item => ({ ...item, target: ids.get(item.target) ?? item.target }));
    return copy;
}

export function duplicateAutomation(automation: Automation, name?: string): Automation {
    const copy = cloneAutomation(automation);
    const ids = new Map(copy.blocks.map(block => [block.id, crypto.randomUUID()]));
    const now = Date.now();

    return {
        ...copy,
        entryId: copy.entryId ? ids.get(copy.entryId) : undefined,
        id: crypto.randomUUID(),
        name: name ?? `${copy.name} copy`,
        enabled: false,
        createdAt: now,
        updatedAt: now,
        lastRunAt: undefined,
        lastScheduledAt: undefined,
        lastStatus: undefined,
        blocks: copy.blocks.map(block => ({
            ...block,
            id: ids.get(block.id) ?? block.id,
            next: remapEdge(block.next, ids),
            alternate: remapEdge(block.alternate, ids),
            error: remapEdge(block.error, ids),
            config: remapBlockConfig(block.config, ids),
        })),
    };
}

export interface AutomationIfBoundary {
    elseIndex?: number;
    endIndex: number;
}

export function findIfBoundary(blocks: AutomationBlock[], start: number): AutomationIfBoundary | undefined {
    let depth = 0;
    let elseIndex: number | undefined;
    for (let index = start + 1; index < blocks.length; index++) {
        const { type } = blocks[index];
        if (type === "condition" || type === "chance") depth++;
        else if (type === "end-if") {
            if (depth === 0) return { elseIndex, endIndex: index };
            depth--;
        } else if (type === "else" && depth === 0) elseIndex = index;
    }
    return undefined;
}

export function findEndIf(blocks: AutomationBlock[], start: number): number | undefined {
    let depth = 0;
    for (let index = start + 1; index < blocks.length; index++) {
        const { type } = blocks[index];
        if (type === "condition" || type === "chance") depth++;
        else if (type === "end-if") {
            if (depth === 0) return index;
            depth--;
        }
    }
    return undefined;
}

export function findEndRepeat(blocks: AutomationBlock[], start: number): number | undefined {
    let depth = 0;
    for (let index = start + 1; index < blocks.length; index++) {
        if (blocks[index].type === "repeat") depth++;
        else if (blocks[index].type === "end-repeat") {
            if (depth === 0) return index;
            depth--;
        }
    }
    return undefined;
}

export function findStartRepeat(blocks: AutomationBlock[], end: number): number | undefined {
    let depth = 0;
    for (let index = end - 1; index >= 0; index--) {
        if (blocks[index].type === "end-repeat") depth++;
        else if (blocks[index].type === "repeat") {
            if (depth === 0) return index;
            depth--;
        }
    }
    return undefined;
}

/** Blocks with two outputs. Everything else has one, and stop/fail have none. */
export const BRANCH_TYPES: AutomationBlockType[] = ["wait-presence", "wait-client-event", "condition", "chance", "repeat", "for-each", "switch", "wait-reply", "wait-dm", "wait-reaction", "check-process", "wait-process"];
/** Structural markers from the old linear format. Converted away by migrateToGraph. */
export const MARKER_TYPES: AutomationBlockType[] = ["else", "end-if", "end-repeat"];
export const TERMINAL_TYPES: AutomationBlockType[] = ["stop", "stop-run", "return", "break-loop"];

export function isGraph(blocks: AutomationBlock[]): boolean {
    return blocks.some(block => block.next !== undefined || block.alternate !== undefined);
}

export function outputPorts(type: AutomationBlockType): AutomationPort[] {
    if (TERMINAL_TYPES.includes(type)) return [];
    if (type === "note") return ["next"];
    return BRANCH_TYPES.includes(type) ? ["next", "alternate", "error"] : ["next", "error"];
}

export function portLabel(type: AutomationBlockType, port: AutomationPort): string {
    if (port === "error") return "On error";
    if (type === "repeat" || type === "for-each") return port === "next" ? "Each pass" : "When done";
    if (type === "wait-presence" || type === "wait-client-event" || type === "wait-reply" || type === "wait-dm" || type === "wait-reaction" || type === "wait-process") return port === "next" ? "Got one" : "Timed out";
    if (type === "check-process") return port === "next" ? "Running" : "Not running";
    if (BRANCH_TYPES.includes(type)) return port === "next" ? "Yes" : "No";
    return "Next";
}

interface Tail {
    id: string;
    port: "next" | "alternate";
}

/**
 * Converts the old linear block list, which used else/end-if/end-repeat markers, into
 * an explicit node graph. Branch and loop structure is preserved; the markers are dropped.
 */
export function migrateToGraph(source: AutomationBlock[]): AutomationBlock[] {
    if (!source.length || isGraph(source)) return source;

    const blocks = source.map(block => ({ ...block }));
    const byId = new Map(blocks.map(block => [block.id, block]));
    const keep = new Set<string>();

    const attach = (tails: Tail[], target: string | undefined) => {
        for (const tail of tails) {
            const block = byId.get(tail.id);
            if (block) block[tail.port] = target;
        }
    };

    const convert = (start: number, end: number): { entry?: string; tails: Tail[]; } => {
        let entry: string | undefined;
        let tails: Tail[] = [];

        for (let index = start; index < end; index++) {
            const block = blocks[index];
            if (MARKER_TYPES.includes(block.type)) continue;
            keep.add(block.id);
            if (entry === undefined) entry = block.id;
            else attach(tails, block.id);

            if (block.type === "condition" || block.type === "chance") {
                const boundary = findIfBoundary(blocks, index);
                const close = boundary ? boundary.endIndex : end;
                const thenEnd = boundary?.elseIndex ?? close;
                const thenBranch = convert(index + 1, thenEnd);
                const elseBranch = boundary?.elseIndex === undefined
                    ? { entry: undefined, tails: [] as Tail[] }
                    : convert(boundary.elseIndex + 1, close);

                block.next = thenBranch.entry;
                block.alternate = elseBranch.entry;
                tails = [
                    ...(thenBranch.entry === undefined ? [{ id: block.id, port: "next" as const }] : thenBranch.tails),
                    ...(elseBranch.entry === undefined ? [{ id: block.id, port: "alternate" as const }] : elseBranch.tails),
                ];
                index = close;
                continue;
            }

            if (block.type === "repeat") {
                const close = findEndRepeat(blocks, index) ?? end;
                const body = convert(index + 1, close);
                block.next = body.entry;
                attach(body.tails, block.id);
                tails = [{ id: block.id, port: "alternate" }];
                index = close;
                continue;
            }

            tails = TERMINAL_TYPES.includes(block.type) ? [] : [{ id: block.id, port: "next" }];
        }

        return { entry, tails };
    };

    convert(0, blocks.length);
    const kept = blocks.filter(block => keep.has(block.id));
    for (const block of kept) {
        block.next = keepEdgeTargets(block.next, id => keep.has(id));
        block.alternate = keepEdgeTargets(block.alternate, id => keep.has(id));
    }
    return layoutGraph(kept);
}

/** Blocks that can reach this one, nearest first. Follows edges backwards, stops at a cycle. */
export function upstreamChain(blocks: AutomationBlock[], id: string): AutomationBlock[] {
    const chain: AutomationBlock[] = [];
    const seen = new Set<string>([id]);
    let current = id;

    for (let steps = 0; steps < blocks.length; steps++) {
        const parents = blocks.filter(block => edgeTargets(block.next).includes(current) || edgeTargets(block.alternate).includes(current) || edgeTargets(block.error).includes(current) || block.config.cases?.some(item => item.target === current));
        const parent = parents.length === 1 ? parents[0] : undefined;
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        chain.push(parent);
        current = parent.id;
    }
    return chain;
}

export interface ReplyCandidate {
    channelId: string;
    authorId: string;
    /** The message this one replies to, when it is a reply. */
    referencedId?: string;
}

export interface ReplyFilter {
    channelId: string;
    /** The current account, so a flow never satisfies its own wait. */
    selfId?: string;
    /** Only accept this author, when set. */
    authorId?: string;
    /** Only accept a reply pointing at this message, when set. */
    awaitedMessageId?: string;
}

/** Whether an incoming message satisfies a wait block, ignoring its text filter. */
export function acceptsReply(filter: ReplyFilter, message: ReplyCandidate): boolean {
    if (message.channelId !== filter.channelId) return false;
    if (filter.selfId && message.authorId === filter.selfId) return false;
    if (filter.authorId && message.authorId !== filter.authorId) return false;
    if (filter.awaitedMessageId && message.referencedId !== filter.awaitedMessageId) return false;
    return true;
}

/**
 * The template a condition compares. Accepts a bare variable name and a written-out template
 * equally, because every other field in the editor takes a template and people write one here.
 * Returns null when the block names nothing, meaning "use the message the flow just handled".
 */
export function conditionLeftTemplate(sourceVariable?: string, value?: string): string | null {
    const variable = sourceVariable?.trim();
    if (variable) return variable.includes("{{") ? variable : `{{${variable}}}`;
    const literal = value?.trim();
    return literal || null;
}

/** Blocks that leave a message behind for later blocks to act on. */
export const MESSAGE_BLOCKS: AutomationBlockType[] = [
    "send-message", "send-dm", "reply-message", "edit-message", "forward-message",
    "wait-reply", "wait-dm", "interact-button", "interact-select", "interact-modal",
    "fetch-dm", "fetch-messages", "fetch-mentions", "fetch-unread", "search-messages",
];

export interface InheritedContext {
    channelId?: string;
    guildId?: string;
    userId?: string;
    /** The variable an earlier block saved a message into. */
    messageVariable?: string;
    /** Which block each value came from, so the editor can name it. */
    channelFrom?: AutomationBlock;
    userFrom?: AutomationBlock;
    messageFrom?: AutomationBlock;
}

/**
 * What a block already knows from everything feeding into it. The engine falls back to the
 * last channel and message it touched at run time, so the editor should say what is already
 * decided instead of asking for it again.
 */
export function inheritedContext(blocks: AutomationBlock[], id: string): InheritedContext {
    const context: InheritedContext = {};

    const incoming = blocks.filter(block => [block.next, block.alternate, block.error].some(edge => edgeTargets(edge).includes(id)) || block.config.cases?.some(item => item.target === id));
    if (incoming.length > 1) return context;

    for (const block of upstreamChain(blocks, id)) {
        const channelId = block.config.channelId?.trim();
        if (!context.channelFrom && (channelId || block.config.userId?.trim())) {
            context.channelFrom = block;
            if (channelId) context.channelId = channelId;
            if (block.config.guildId?.trim()) context.guildId = block.config.guildId.trim();
        }

        const userId = block.config.userId?.trim() || block.config.authorId?.trim();
        if (!context.userFrom && userId) {
            context.userFrom = block;
            context.userId = userId;
        }

        if (!context.messageFrom && MESSAGE_BLOCKS.includes(block.type)) {
            context.messageFrom = block;
            context.messageVariable = block.config.variable?.trim() || "lastMessage";
        }
    }

    return context;
}

/** The block a run starts from: the first without an incoming edge, else the first block. */
export function graphEntry(blocks: AutomationBlock[]): AutomationBlock | undefined {
    const targets = new Set(blocks.flatMap(block => [...edgeTargets(block.next), ...edgeTargets(block.alternate), ...edgeTargets(block.error), ...(block.config.cases ?? []).map(route => route.target)]));
    return blocks.find(block => !targets.has(block.id)) ?? blocks[0];
}

const NODE_STEP_X = 300;
const NODE_STEP_Y = 130;

/** Gives every block without a saved position a readable spot, following the edges. */
export function layoutGraph(blocks: AutomationBlock[]): AutomationBlock[] {
    const byId = new Map(blocks.map(block => [block.id, block]));
    const placed = new Set<string>();
    const targets = new Set(blocks.flatMap(block => [...edgeTargets(block.next), ...edgeTargets(block.alternate), ...edgeTargets(block.error), ...(block.config.cases ?? []).map(route => route.target)]));
    const roots = blocks.filter(block => !targets.has(block.id));
    let column = 0;

    const walk = (id: string | undefined, depth: number, lane: number) => {
        if (id === undefined || placed.has(id)) return;
        const block = byId.get(id);
        if (!block) return;
        placed.add(id);
        block.position ??= { x: 80 + lane * NODE_STEP_X, y: 60 + depth * NODE_STEP_Y };
        edgeTargets(block.next).forEach((target, index) => walk(target, depth + 1, lane + index));
        edgeTargets(block.alternate).forEach((target, index) => walk(target, depth + 1, lane + 1 + index));
        edgeTargets(block.error).forEach((target, index) => walk(target, depth + 1, lane + 2 + index));
        block.config.cases?.forEach((route, index) => walk(route.target, depth + 1, lane + index));
    };

    for (const root of roots.length ? roots : blocks.slice(0, 1)) walk(root.id, 0, column++);
    for (const block of blocks) if (!placed.has(block.id)) walk(block.id, 0, column++);
    return blocks;
}

function cloneComponents(components: AutomationComponent[] | undefined): AutomationComponent[] | undefined {
    return components?.map(component => ({
        ...component,
        options: component.options?.map(option => ({ ...option })),
        components: cloneComponents(component.components),
    }));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutomationUnit(value: unknown): value is AutomationUnit {
    return typeof value === "string" && AUTOMATION_UNITS.some(unit => unit === value);
}

function isAutomationBlockType(value: unknown): value is AutomationBlockType {
    return typeof value === "string" && AUTOMATION_BLOCK_TYPES.some(type => type === value);
}

function isAutomationTrigger(value: unknown): value is AutomationTrigger {
    return isRecord(value)
        && typeof value.type === "string"
        && AUTOMATION_TRIGGER_TYPES.some(type => type === value.type);
}

function isSchedule(value: unknown): value is Schedule {
    return isRecord(value)
        && typeof value.interval === "number"
        && Number.isFinite(value.interval)
        && value.interval > 0
        && isAutomationUnit(value.unit)
        && typeof value.startAt === "number"
        && Number.isFinite(value.startAt);
}

function isAutomationBlock(value: unknown): value is AutomationBlock {
    return isRecord(value)
        && typeof value.id === "string"
        && isAutomationBlockType(value.type)
        && isRecord(value.config);
}

export function isAutomation(value: unknown): value is Automation {
    return isRecord(value)
        && typeof value.id === "string"
        && typeof value.name === "string"
        && typeof value.enabled === "boolean"
        && (value.trigger === undefined || isAutomationTrigger(value.trigger))
        && isSchedule(value.schedule)
        && Array.isArray(value.blocks)
        && value.blocks.length <= 100
        && value.blocks.every(isAutomationBlock)
        && typeof value.createdAt === "number"
        && typeof value.updatedAt === "number";
}

function isGuildReference(value: unknown): value is GuildReference {
    return isRecord(value)
        && typeof value.id === "string"
        && (typeof value.name === "string" || value.name === null)
        && (typeof value.icon === "string" || value.icon === null)
        && (typeof value.banner === "string" || value.banner === null)
        && (typeof value.inviteCode === "string" || value.inviteCode === null)
        && typeof value.available === "boolean";
}

function isComponentOption(value: unknown): value is AutomationComponentOption {
    return isRecord(value) && typeof value.label === "string" && typeof value.value === "string";
}

function isComponent(value: unknown): value is AutomationComponent {
    if (!isRecord(value) || typeof value.type !== "number" || !Number.isInteger(value.type)) return false;
    if (value.options !== undefined && (!Array.isArray(value.options) || !value.options.every(isComponentOption))) return false;
    return value.components === undefined || (Array.isArray(value.components) && value.components.every(isComponent));
}

export function parseComponents(value: string): { components: AutomationComponent[]; error?: string; } {
    if (value.length > 200_000) return { components: [], error: "Components JSON is too large." };
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every(isComponent)) return { components: [], error: "Components must be a JSON array with numeric type values." };
        return { components: parsed };
    } catch {
        return { components: [], error: "Components JSON is not valid." };
    }
}

export function parseAutomationFile(value: unknown): AutomationFile {
    if (!isRecord(value)
        || value.format !== AUTOMATION_FILE_FORMAT
        || (value.version !== 1 && value.version !== AUTOMATION_FILE_VERSION)
        || !Array.isArray(value.automations)
        || value.automations.length > 100
        || !value.automations.every(isAutomation)) {
        throw new Error("This is not a valid LawyerCord automation file.");
    }

    return {
        format: AUTOMATION_FILE_FORMAT,
        version: AUTOMATION_FILE_VERSION,
        exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
        automations: value.automations,
        guilds: Array.isArray(value.guilds) ? value.guilds.filter(isGuildReference) : [],
    };
}

export function createAutomationFile(automations: Automation[], guilds: GuildReference[] = []): AutomationFile {
    return {
        format: AUTOMATION_FILE_FORMAT,
        version: AUTOMATION_FILE_VERSION,
        exportedAt: new Date().toISOString(),
        automations: automations.map(cloneAutomation),
        guilds: collectGuildReferences(automations, guilds),
    };
}

export function collectGuildReferences(automations: Automation[], existing: GuildReference[] = []): GuildReference[] {
    const references = new Map(existing.map(reference => [reference.id, reference]));
    for (const automation of automations) {
        for (const block of automation.blocks) {
            const guildId = block.config.guildId?.trim();
            if (guildId && !references.has(guildId)) {
                references.set(guildId, {
                    id: guildId,
                    name: null,
                    icon: null,
                    banner: null,
                    inviteCode: null,
                    available: false,
                });
            }
        }
    }
    return [...references.values()];
}

export function addScheduleInterval(timestamp: number, unit: AutomationUnit, interval: number): number {
    const steps = Math.max(1, Math.trunc(interval));
    const date = new Date(timestamp);

    if (unit === "minutes") date.setMinutes(date.getMinutes() + steps);
    if (unit === "hours") date.setHours(date.getHours() + steps);
    if (unit === "days") date.setDate(date.getDate() + steps);
    if (unit === "weeks") date.setDate(date.getDate() + steps * 7);
    if (unit === "months" || unit === "years") {
        const day = date.getDate();
        date.setDate(1);
        if (unit === "months") date.setMonth(date.getMonth() + steps);
        else date.setFullYear(date.getFullYear() + steps);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(day, lastDay));
    }

    return date.getTime();
}

export function getNextRunAt(schedule: Schedule, now = Date.now()): number {
    if (schedule.startAt > now) return schedule.startAt;

    const interval = Math.max(1, Math.trunc(schedule.interval));
    if (schedule.unit === "minutes" || schedule.unit === "hours" || schedule.unit === "days" || schedule.unit === "weeks") {
        const milliseconds = schedule.unit === "minutes"
            ? 60_000
            : schedule.unit === "hours"
                ? 3_600_000
                : schedule.unit === "days"
                    ? 86_400_000
                    : 604_800_000;
        return schedule.startAt + Math.ceil((now - schedule.startAt + 1) / (milliseconds * interval)) * milliseconds * interval;
    }

    const date = new Date(schedule.startAt);
    const monthDistance = (new Date(now).getFullYear() - date.getFullYear()) * 12 + new Date(now).getMonth() - date.getMonth();
    const roughSteps = schedule.unit === "months" ? Math.max(0, Math.floor(monthDistance / interval)) : Math.max(0, Math.floor((new Date(now).getFullYear() - date.getFullYear()) / interval));
    let next = roughSteps ? addScheduleInterval(schedule.startAt, schedule.unit, roughSteps * interval) : schedule.startAt;
    for (let attempts = 0; next <= now && attempts < 1000; attempts++) next = addScheduleInterval(next, schedule.unit, interval);
    return next > now ? next : addScheduleInterval(now, schedule.unit, interval);
}

export function formatSchedule(schedule: Schedule): string {
    if (schedule.mode === "cron") return `${schedule.cron || "Choose a cron expression"} (${schedule.timezone || "local time"})`;
    if (schedule.mode === "calendar") return `${(schedule.weekdays ?? [1, 2, 3, 4, 5]).map(day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")} at ${schedule.time || "09:00"} (${schedule.timezone || "local time"})`;
    return `Every ${schedule.interval} ${schedule.unit.slice(0, -1)}${schedule.interval === 1 ? "" : "s"}`;
}

export function toDateTimeLocal(timestamp: number): string {
    const date = new Date(timestamp - dateTimezoneOffset(timestamp));
    return date.toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value: string): number | null {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function dateTimezoneOffset(timestamp: number): number {
    return new Date(timestamp).getTimezoneOffset() * 60_000;
}
