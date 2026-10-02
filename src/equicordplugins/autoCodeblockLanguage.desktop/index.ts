/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import shikiCodeblocks from "@plugins/shikiCodeblocks.desktop";
import { hljs, requireHljs } from "@plugins/shikiCodeblocks.desktop/utils/misc";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

const PRIMARY_AUTO_LANGUAGES = [
    "bash",
    "powershell",
    "dos",
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "javascript",
    "jsx",
    "typescript",
    "tsx",
    "python",
    "ruby",
    "rust",
    "swift",
    "kotlin",
    "lua",
    "php",
    "json",
    "yaml",
    "toml",
    "ini",
    "xml",
    "html",
    "css",
    "scss",
    "less",
    "sql",
    "markdown",
    "diff",
    "dockerfile",
] as const;

const STRONG_SIGNAL_PATTERNS = [
    /(?:^|\n)\s*(?:const|let|var|function|class|import|export|return)\b/m,
    /(?:^|\n)\s*def\s+\w+\s*\(/m,
    /(?:^|\n)\s*(?:if|elif|for|while|match)\b.+:\s*$/m,
    /(?:^|\n)\s*#include\s*[<"]/m,
    /(?:^|\n)\s*using\s+namespace\b/m,
    /(?:^|\n)\s*(?:fn|impl|trait|struct|enum)\b/m,
    /(?:^|\n)\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]+\b(?:FROM|INTO|SET)\b/im,
    /<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>/,
    /^\s*(?:\{|\[)[\s\S]*[:"][\s\S]*(?:\}|\])\s*$/m,
] as const;

const LANGUAGE_ALIASES: Record<string, string> = {
    console: "bash",
    csharp: "cs",
    dos: "bat",
    javascript: "js",
    luau: "lua",
    plaintext: "",
    rbxlua: "lua",
    shell: "bash",
    text: "",
    typescript: "ts",
};

const MINIMUM_LINES = 2;
const MINIMUM_CHARACTERS = 16;
const MINIMUM_RELEVANCE = 4;
const MINIMUM_RELEVANCE_WITH_STRONG_SIGNAL = 2;
const MINIMUM_CONFIDENCE_GAP = 2;
const SECONDARY_MINIMUM_LINES = 4;
const SECONDARY_MINIMUM_CHARACTERS = 48;
const SECONDARY_MINIMUM_RELEVANCE = 10;
const SECONDARY_MINIMUM_CONFIDENCE_GAP = 4;
const MAX_DETECTION_CACHE_SIZE = 200;
const MAX_CACHED_CONTENT_LENGTH = 50_000;

const LANGUAGE_HINTS = [
    {
        language: "lua",
        minimumMatches: 2,
        patterns: [
            /\b(?:script\.|game:(?:GetService|WaitForService)|WaitForChild\s*\(|task\.|warn\s*\()/,
            /\blocal\b/,
            /\bthen\b/,
            /\bend\b/,
            /\bfunction\b/,
            /\b(?:elseif|nil|not|repeat|until)\b/,
            /\.\./,
        ],
    },
    {
        language: "sql",
        minimumMatches: 2,
        patterns: [
            /\bselect\b/i,
            /\bfrom\b/i,
            /\bwhere\b/i,
            /\bjoin\b/i,
            /\b(?:insert\s+into|update|delete\s+from)\b/i,
            /\border\s+by\b/i,
        ],
    },
    {
        language: "js",
        minimumMatches: 2,
        patterns: [
            /\b(?:const|let|var)\b/,
            /\bconsole\.\w+\s*\(/,
            /=>/,
            /===|!==/,
            /\bimport\b[\s\S]*\bfrom\b/,
            /\bexport\b/,
        ],
    },
    {
        language: "ts",
        minimumMatches: 2,
        patterns: [
            /\binterface\b/,
            /\btype\s+\w+\s*=/,
            /\b(?:readonly|implements|private|public|protected)\b/,
            /:\s*(?:string|number|boolean|unknown|any|never|void)\b/,
            /\bas const\b/,
        ],
    },
    {
        language: "py",
        minimumMatches: 2,
        patterns: [
            /\bdef\s+\w+\s*\(/,
            /\belif\b/,
            /\bNone\b/,
            /\bself\b/,
            /\bprint\s*\(/,
        ],
    },
    {
        language: "bash",
        minimumMatches: 2,
        patterns: [
            /^\s*#!/m,
            /\becho\b/,
            /\bfi\b/,
            /\bdone\b/,
            /\$\w+/,
        ],
    },
] as const;

type RenderHighlighterArgs = Parameters<NonNullable<typeof shikiCodeblocks.renderHighlighter>>[0];
type RenderHighlighter = NonNullable<typeof shikiCodeblocks.renderHighlighter>;
type DetectionResult = {
    language: string | null;
    relevance: number;
    confidenceGap: number;
};

let originalShikiRender: RenderHighlighter | null = null;
let primaryDetectableLanguagesCache: string[] | null = null;
let secondaryDetectableLanguagesCache: string[] | null = null;
const detectionCache = new Map<string, DetectionResult>();
const logger = new Logger("AutoCodeblockLanguage");

function clearDetectionCaches() {
    primaryDetectableLanguagesCache = null;
    secondaryDetectableLanguagesCache = null;
    detectionCache.clear();
}

function setDetectionCache(cacheKey: string, result: DetectionResult) {
    if (cacheKey.length > MAX_CACHED_CONTENT_LENGTH) return;

    if (detectionCache.size >= MAX_DETECTION_CACHE_SIZE) {
        const oldestKey = detectionCache.keys().next().value;
        if (oldestKey) detectionCache.delete(oldestKey);
    }

    detectionCache.set(cacheKey, result);
}

function normalizeLanguage(language: string | undefined) {
    if (!language) return null;

    const normalized = LANGUAGE_ALIASES[language] ?? language;
    if (!normalized || !hljs?.getLanguage?.(normalized)) return null;

    return normalized;
}

function getLineCount(content: string) {
    let count = 1;

    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) count++;
    }

    return count;
}

function detectHintedLanguage(content: string) {
    if (LANGUAGE_HINTS[0].patterns[0].test(content)) return "lua";

    let bestMatch: { language: string; score: number; } | null = null;
    let runnerUpScore = 0;

    for (const hint of LANGUAGE_HINTS) {
        const score = hint.patterns.reduce((matches, pattern) => matches + Number(pattern.test(content)), 0);
        if (score < hint.minimumMatches) continue;

        if (!bestMatch || score > bestMatch.score) {
            runnerUpScore = bestMatch?.score ?? 0;
            bestMatch = { language: hint.language, score };
        } else if (score > runnerUpScore) {
            runnerUpScore = score;
        }
    }

    if (!bestMatch || bestMatch.score === runnerUpScore) return null;
    return bestMatch.language;
}

function hasStrongSignal(content: string) {
    if (STRONG_SIGNAL_PATTERNS.some(pattern => pattern.test(content))) return true;

    const punctuationScore = content.match(/[{}()[\];<>]/g)?.length ?? 0;
    if (punctuationScore >= 4) return true;

    const operatorScore = content.match(/=>|->|::|:=|==|!=|<=|>=/g)?.length ?? 0;
    return operatorScore >= 2;
}

function getSupportedLanguages(): string[] {
    return hljs?.listLanguages?.() ?? [...PRIMARY_AUTO_LANGUAGES].filter(language => hljs?.getLanguage?.(language));
}

function getPrimaryDetectableLanguages(): string[] {
    return primaryDetectableLanguagesCache ??= [...PRIMARY_AUTO_LANGUAGES].filter(language => hljs?.getLanguage?.(language));
}

function getSecondaryDetectableLanguages(): string[] {
    if (secondaryDetectableLanguagesCache) return secondaryDetectableLanguagesCache;

    const primary = new Set<string>(getPrimaryDetectableLanguages());
    secondaryDetectableLanguagesCache = getSupportedLanguages().filter(language => !primary.has(language));
    return secondaryDetectableLanguagesCache;
}

function runAutoDetection(content: string, languages: string[]): DetectionResult {
    try {
        const result = languages.length
            ? hljs.highlightAuto(content, languages)
            : hljs.highlightAuto(content);

        const language = normalizeLanguage(result.language);
        if (!language) {
            return {
                language: null,
                relevance: 0,
                confidenceGap: 0,
            };
        }

        const relevance = result.relevance ?? 0;
        const secondBest = "secondBest" in result ? result.secondBest : void 0;
        const confidenceGap = secondBest ? relevance - (secondBest.relevance ?? 0) : relevance;

        return {
            language,
            relevance,
            confidenceGap,
        };
    } catch {
        return {
            language: null,
            relevance: 0,
            confidenceGap: 0,
        };
    }
}

function detectLanguageResult(content: string): DetectionResult {
    const trimmed = content.trim();
    if (!trimmed) {
        return {
            language: null,
            relevance: 0,
            confidenceGap: 0,
        };
    }

    const cached = detectionCache.get(trimmed);
    if (cached) {
        detectionCache.delete(trimmed);
        detectionCache.set(trimmed, cached);
        return cached;
    }

    const hintedLanguage = detectHintedLanguage(trimmed);
    if (hintedLanguage) {
        const result: DetectionResult = {
            language: hintedLanguage,
            relevance: Number.POSITIVE_INFINITY,
            confidenceGap: Number.POSITIVE_INFINITY,
        };
        setDetectionCache(trimmed, result);
        return result;
    }

    const strongSignal = hasStrongSignal(trimmed);
    const lineCount = getLineCount(trimmed);
    const meetsLengthThreshold =
        lineCount >= MINIMUM_LINES ||
        trimmed.length >= MINIMUM_CHARACTERS;

    if (!strongSignal && !meetsLengthThreshold) {
        const result: DetectionResult = {
            language: null,
            relevance: 0,
            confidenceGap: 0,
        };
        setDetectionCache(trimmed, result);
        return result;
    }

    const primaryResult = runAutoDetection(trimmed, getPrimaryDetectableLanguages());
    if (primaryResult.language && primaryResult.relevance >= MINIMUM_RELEVANCE) {
        setDetectionCache(trimmed, primaryResult);
        return primaryResult;
    }

    if (
        primaryResult.language &&
        primaryResult.confidenceGap >= MINIMUM_CONFIDENCE_GAP &&
        strongSignal &&
        primaryResult.relevance >= MINIMUM_RELEVANCE_WITH_STRONG_SIGNAL
    ) {
        setDetectionCache(trimmed, primaryResult);
        return primaryResult;
    }

    const shouldTrySecondaryDetection =
        lineCount >= SECONDARY_MINIMUM_LINES ||
        trimmed.length >= SECONDARY_MINIMUM_CHARACTERS;

    if (!shouldTrySecondaryDetection) {
        const result: DetectionResult = {
            language: null,
            relevance: 0,
            confidenceGap: primaryResult.confidenceGap,
        };
        setDetectionCache(trimmed, result);
        return result;
    }

    const secondaryResult = runAutoDetection(trimmed, getSecondaryDetectableLanguages());
    if (
        secondaryResult.language &&
        secondaryResult.relevance >= SECONDARY_MINIMUM_RELEVANCE &&
        secondaryResult.confidenceGap >= SECONDARY_MINIMUM_CONFIDENCE_GAP
    ) {
        setDetectionCache(trimmed, secondaryResult);
        return secondaryResult;
    }

    const result: DetectionResult = {
        language: null,
        relevance: 0,
        confidenceGap: Math.max(primaryResult.confidenceGap, secondaryResult.confidenceGap),
    };
    setDetectionCache(trimmed, result);
    return result;
}

function installShikiWrapper() {
    if (originalShikiRender || typeof shikiCodeblocks.renderHighlighter !== "function") return;

    const { renderHighlighter } = shikiCodeblocks;
    originalShikiRender = renderHighlighter;
    shikiCodeblocks.renderHighlighter = (args: RenderHighlighterArgs) => {
        const resolvedLanguage = resolveLanguage(args.lang, args.content);
        if (resolvedLanguage === args.lang || !resolvedLanguage) return renderHighlighter.call(shikiCodeblocks, args);

        return renderHighlighter.call(shikiCodeblocks, {
            ...args,
            lang: resolvedLanguage,
        });
    };
}

function uninstallShikiWrapper() {
    if (!originalShikiRender) return;

    shikiCodeblocks.renderHighlighter = originalShikiRender;
    originalShikiRender = null;
}

function resolveLanguage(currentLanguage: string | undefined, content: string) {
    if (currentLanguage || content.length > MAX_CACHED_CONTENT_LENGTH) return currentLanguage;
    return detectLanguageResult(content).language || currentLanguage;
}

export default definePlugin({
    name: "AutoCodeblockLanguage",
    performance: { impact: "high", description: "Detects untagged code languages synchronously across multiple syntax grammars." },
    description: "Detects languages for fenced code blocks that were sent without a language tag.",
    authors: [EquicordDevs.nobody],
    tags: ["Chat", "Utility", "Developers"],
    patches: [
        {
            find: "codeBlock:{react(",
            predicate: () => !isPluginEnabled(shikiCodeblocks.name),
            replacement: {
                match: /codeBlock:\{react\((\i),(\i),(\i)\)\{/,
                replace: "$&$1.lang=$self.resolveLanguage($1.lang,$1.content);"
            }
        },
        {
            find: "#{intl::PREVIEW_NUM_LINES}",
            predicate: () => !isPluginEnabled(shikiCodeblocks.name),
            replacement: {
                match: /(?<=function \i\((\i)\)\{)(?=let\{text:\i,language:)/,
                replace: "$1.language=$self.resolveLanguage($1.language,$1.text);"
            }
        }
    ],

    start() {
        clearDetectionCaches();
        void Promise.resolve(requireHljs()).then(clearDetectionCaches, error => logger.error("Failed to load the highlighter", error));
        installShikiWrapper();
    },

    stop() {
        uninstallShikiWrapper();
        clearDetectionCaches();
    },

    resolveLanguage,
});
