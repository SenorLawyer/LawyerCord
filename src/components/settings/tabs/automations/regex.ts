/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createRegexEvaluator } from "@utils/regex";

export type { RegexResult } from "@utils/regex";

export const { evaluateRegex, stopRegexWorker } = createRegexEvaluator();
