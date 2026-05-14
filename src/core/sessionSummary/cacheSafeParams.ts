/**
 * Helper that builds the `SubAgentToolParams` for an extractor spawn.
 *
 * The single critical rule: do not override any field that would override
 * `SubAgentRunner.prepare()`'s inheritance of model / tools / systemPrompt /
 * browserContext / message-prefix. Drift = prompt-cache miss = ~3-5x cost.
 *
 * Mirrors claudy's createCacheSafeParams() pattern but realized as a
 * browserx-shaped `SubAgentToolParams` rather than a `forkContextMessages`
 * bundle — browserx's `SubAgentRunner` inherits from `parentEngine` directly.
 */

import type { PreExecuteCheck } from '@/tools/ToolRegistry';
import type { SubAgentToolParams } from '@/tools/AgentTool/types';
import { SESSION_SUMMARY_EXTRACTOR_TYPE_ID } from './extractorType';

/**
 * Build the params for an extractor run.
 *
 * @param prompt The per-call user prompt (typically the output of
 *   `buildSessionSummaryUpdatePrompt`). This is the ONLY content field
 *   that varies between runs; everything else is inherited from the parent.
 * @param canUseTool Per-call sync pre-execute gate (typically the output of
 *   `createSummaryFileCanUseTool`). Installed on the child tool registry
 *   so `file_edit` is restricted to the summary file path.
 */
export function buildExtractorParams(
  prompt: string,
  canUseTool: PreExecuteCheck,
): SubAgentToolParams {
  return {
    type: SESSION_SUMMARY_EXTRACTOR_TYPE_ID,
    prompt,
    description: 'session summary extraction',
    background: true,
    quietBackground: true,
    canUseTool,
    // Intentionally do NOT pass:
    //   - signal (background runs outlive any caller signal; SubAgentRunner
    //     emits a SubAgentWarning if signal is set on a background run)
    //   - model / tools / systemPrompt (any override would break the cache)
  };
}
