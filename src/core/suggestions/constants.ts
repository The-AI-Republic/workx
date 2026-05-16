/**
 * Constants for the next-prompt suggestion service (Track 24.3).
 *
 * The prompt and reject heuristics were authored in-repo (the claudy
 * reference is not vendored). N=160 ≈ one comfortable line in the 3-line
 * input; the `NONE` sentinel gives the model a clean refusal channel mapped
 * to "show nothing" by REJECT_RULES.
 */

import type { PromptSuggestionConfig } from './types';

export const DEFAULT_SUGGESTION_CONFIG: PromptSuggestionConfig = {
  maxRetries: 2,
  baseBackoffMs: 1000,
  maxLength: 160,
  maxTurns: 6,
  maxCharsPerTurn: 400,
  maxContextChars: 3000,
};

/** `{packedContext}` is replaced with the chronological turn block. */
export const SUGGESTION_PROMPT = `You predict the user's single most likely NEXT message in this chat. The user is talking to a browser-automation agent.

Conversation so far (oldest first):
<<<
{packedContext}
>>>

Output ONLY the predicted next user message, as if the user typed it. Rules:
- One short line. No preamble, no quotes, no labels, no markdown, no code fences.
- Maximum 160 characters.
- Plain natural request, phrased as the user (imperative or question).
- Do NOT propose destructive or irreversible actions (delete, pay, purchase, checkout, submit, or navigating to an external site).
- If you cannot confidently predict a useful follow-up, output exactly: NONE

Next message:`;
