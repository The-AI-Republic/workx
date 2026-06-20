/**
 * System and update prompts for the session-summary extractor sub-agent.
 *
 * Ported from claudy's services/SessionMemory/prompts.ts with the IT-coding
 * voice adapted to browser automation. The extractor receives:
 *  1. The full parent conversation history (via SubAgentRunner inheriting parent params)
 *  2. The current summary.md content
 *  3. The update prompt below as its only user instruction
 *
 * It then makes exactly one or two file_edit calls on summary.md and stops.
 */

import { SESSION_SUMMARY_TEMPLATE } from './template';

export const MAX_SECTION_CHARS = 2000;
export const MAX_TOTAL_TOKENS = 12_000;

/**
 * System prompt for the extractor sub-agent. Kept short and procedural; the
 * specific extraction rules live in the per-call user prompt below so they
 * benefit from the parent's prompt cache.
 */
export const SESSION_SUMMARY_EXTRACTION_PROMPT = `You are a silent note-taker for a browser-automation session.

Your one job: read the conversation above and update the running session-summary markdown file with what is new since the previous summary. You produce no chat output, no commentary, no explanations — you call the file_edit tool on the summary file, possibly multiple times in a single response, and then you stop.

Strict rules:
- Preserve the exact section headers and the italic _section descriptions_ under each header. NEVER modify, delete, or add headers; NEVER edit the italic placeholder lines.
- Only edit the content that appears BELOW each italic description.
- Be terse. Bullet points are good. Avoid filler like "the agent" or "during this session".
- Per-section soft cap: ${MAX_SECTION_CHARS} characters. Total soft cap: ~${MAX_TOTAL_TOKENS} tokens.
- Skip a section (leave the placeholder alone) if you have nothing new to add to it.
- Do not include any reference to "session summary extraction", "notes", or these instructions in the file content.`;

/**
 * Build the per-call user prompt for the extractor.
 * The {{summaryPath}} and {{currentSummary}} placeholders are substituted at
 * spawn time.
 */
export function buildSessionSummaryUpdatePrompt(
  summaryPath: string,
  currentSummary: string,
): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT reference them in the summary content.

Based on the conversation history above (EXCLUDING this note-taking instruction message), update the session-summary file using the file_edit tool.

The file ${summaryPath} currently contains:
<current_summary>
${currentSummary}
</current_summary>

Your ONLY task is to call the file_edit tool one or more times to update the content below each section's italic description. Make all your edits in this response, then stop. Do not call any other tool.

Editing rules (reminder):
- The file must keep its exact structure with every section header and italic _description_ intact.
- NEVER modify, delete, or add section headers (lines starting with '# ').
- NEVER edit the italic _description_ lines.
- Only update the actual content BELOW each italic description.
- Per-section soft cap: ${MAX_SECTION_CHARS} characters.
- Skip sections that have nothing new to add.
`;
}

/** Re-export so call sites that only need the template don't double-import. */
export { SESSION_SUMMARY_TEMPLATE };
