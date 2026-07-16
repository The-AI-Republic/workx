/**
 * queryEfficientLLM — shared one-shot inference on the "efficient" model.
 *
 * Layering (borrowed from the queryHaiku pattern):
 *   1. Base:    provider SDK clients (ModelClientFactory + client/*)
 *   2. This:    queryEfficientLLM() — cheap, non-streaming-to-caller,
 *               no-tools utility inference
 *   3. Top:     feature functions — session/chat-history title generation,
 *               tool-use summaries, date-time parsing, … (add more here)
 *
 * Scope: WorkX app-logistics ONLY. This seam must never run user-facing
 * tasks — user tasks go through the normal agent loop on the selected task
 * model. The efficient model is resolved by
 * {@link ModelClientFactory.createEfficientClient}: the user's explicit
 * choice (same provider as the task model), a gateway default when logged
 * in, or the task model itself.
 *
 * @module core/models/efficientQuery
 */

import type { ModelClient } from './ModelClient';
import type { ResponseItem } from '../protocol/types';
import { isOutputTextDelta } from './types/ResponseEvent';

export interface EfficientQuery {
  /** Instruction for the utility task (appended after the input, if any). */
  instruction: string;
  /**
   * Task input: conversation excerpt, tool output, text to parse, … Omit when
   * the instruction is a fully self-contained prompt (already interpolated).
   */
  input?: string;
}

/**
 * Run a single no-tools query against the given (efficient) model client and
 * return the collected text output.
 *
 * The caller supplies the client (obtained via
 * `ModelClientFactory.createEfficientClient()` or an equivalent fallback) so
 * this layer stays platform- and lifecycle-agnostic and unit-testable.
 */
export async function queryEfficientLLM(
  client: ModelClient,
  query: EfficientQuery
): Promise<string> {
  const promptText = query.input !== undefined
    ? `${query.input}\n\n${query.instruction}`
    : query.instruction;
  const input: ResponseItem[] = [
    {
      type: 'message' as const,
      role: 'user',
      content: [
        {
          type: 'input_text' as const,
          text: promptText,
        },
      ],
    },
  ];

  const stream = await client.stream({
    input,
    tools: [], // Utility inference never exposes tools
  });

  let text = '';
  for await (const event of stream) {
    if (isOutputTextDelta(event)) {
      text += event.delta;
    }
  }

  return text.trim();
}
