/**
 * PromptSuggestionGenerator — predicts the user's likely next message
 * (Track 24.3). A sibling of `TitleGenerator`: one cheap background model
 * call, drained the same way, wrapped in the same retry orchestrator.
 *
 * SUGGESTION ONLY. There is deliberately NO speculative execution: browser
 * tool calls drive non-idempotent side effects (navigation/clicks/form-fills/
 * payments) with no COW-overlay analog — same hazard class as Track 23's
 * "never auto-pay on navigation". Rules 11–14 below are that prohibition
 * expressed on the suggestion path.
 *
 * @module core/suggestions/promptSuggestion
 */

import type { ResponseItem } from '../protocol/types';
import type { ModelClient } from '../models/ModelClient';
import { withModelRetry } from '../models/resilience/withRetry';
import { isOutputTextDelta, isCompleted } from '../models/types/ResponseEvent';
import { scanForSecrets } from '../security/secretScanner';
import { DEFAULT_SUGGESTION_CONFIG, SUGGESTION_PROMPT } from './constants';
import type { PromptSuggestionConfig, PromptSuggestionResult } from './types';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a: string, b: string): number {
  const sa = new Set(normalize(a).split(' ').filter(Boolean));
  const sb = new Set(normalize(b).split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

interface RejectCtx {
  lastAssistant: string;
  maxLength: number;
}

/** Ordered. First match ⇒ discard the suggestion (show nothing). */
const REJECT_RULES: Array<{ id: string; test: (s: string, ctx: RejectCtx) => boolean }> = [
  { id: 'empty', test: (s) => s.trim() === '' },
  { id: 'none-sentinel', test: (s) => /^NONE$/i.test(s.trim()) },
  { id: 'too-short', test: (s) => s.trim().length < 6 },
  { id: 'too-long', test: (s, c) => s.length > c.maxLength },
  { id: 'multiline', test: (s) => /\n/.test(s) },
  { id: 'code', test: (s) => /```/.test(s) || /(^|\s)`[^`]+`/.test(s) },
  {
    id: 'refusal',
    test: (s) =>
      /^(I (cannot|can't|am unable)|I'm (sorry|unable)|As an AI|As a language model|I do not|I don't have)/i.test(
        s.trim(),
      ),
  },
  {
    id: 'preamble',
    test: (s) =>
      /^(Here(\s|')s|Here is|Sure[,!]|Certainly[,!]|Of course[,!]|Below is|The (next|following))/i.test(
        s.trim(),
      ),
  },
  { id: 'echoes-assistant', test: (s, c) => jaccard(s, c.lastAssistant) > 0.6 },
  // High-confidence secrets only (`.block`), not the scanner's low-confidence
  // generic-high-entropy heuristic — keeps suggestion filtering decoupled
  // from redaction tuning.
  { id: 'secret', test: (s) => scanForSecrets(s).block },
  {
    id: 'destructive',
    test: (s) => /\b(delete|remove|drop|erase|wipe|purge|uninstall|format)\b/i.test(s),
  },
  {
    id: 'financial',
    test: (s) =>
      /\b(pay|payment|purchase|buy|checkout|order now|place (the|an) order|subscribe|confirm payment)\b/i.test(
        s,
      ),
  },
  {
    id: 'form-submit',
    test: (s) =>
      /\b(submit|send|confirm|sign in|log ?in|authori[sz]e)\b.*\b(form|payment|order|application|request)\b/i.test(
        s,
      ) || /\bsubmit (the|this) form\b/i.test(s),
  },
  { id: 'external-url', test: (s) => /https?:\/\/\S+/i.test(s) },
];

export class PromptSuggestionGenerator {
  private config: PromptSuggestionConfig;

  constructor(config: Partial<PromptSuggestionConfig> = {}) {
    this.config = { ...DEFAULT_SUGGESTION_CONFIG, ...config };
  }

  /** Count assistant message turns in history. */
  countAssistantTurns(history: ResponseItem[]): number {
    return history.filter(
      (i) => i.type === 'message' && (i as { role?: string }).role === 'assistant',
    ).length;
  }

  /** Last N user/assistant message turns, chronological. */
  private extractRecentTurns(history: ResponseItem[]): Turn[] {
    const turns: Turn[] = [];
    for (let i = history.length - 1; i >= 0 && turns.length < this.config.maxTurns; i--) {
      const item = history[i];
      if (item.type !== 'message') continue;
      const role = (item as { role?: string }).role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = (item as { content?: unknown }).content;
      let text = '';
      if (Array.isArray(content)) {
        for (const c of content) {
          if (
            c &&
            typeof c === 'object' &&
            'text' in c &&
            typeof (c as { text?: unknown }).text === 'string'
          ) {
            text = (c as { text: string }).text;
            break;
          }
        }
      } else if (typeof content === 'string') {
        text = content;
      }
      if (text.trim() === '') continue;
      turns.push({ role, text });
    }
    return turns.reverse();
  }

  private packContext(turns: Turn[]): string {
    const lines = turns.map((t) => {
      const label = t.role === 'user' ? 'User' : 'Assistant';
      let text = t.text.trim();
      if (text.length > this.config.maxCharsPerTurn) {
        text = text.slice(0, this.config.maxCharsPerTurn) + '…';
      }
      return `${label}: ${text}`;
    });
    let packed = lines.join('\n');
    // Keep the most recent context when over the hard cap.
    if (packed.length > this.config.maxContextChars) {
      packed = packed.slice(packed.length - this.config.maxContextChars);
    }
    return packed;
  }

  private clean(raw: string): string {
    let s = raw.trim();
    for (const prefix of ['Next message:', 'Suggestion:']) {
      if (s.toLowerCase().startsWith(prefix.toLowerCase())) {
        s = s.slice(prefix.length).trim();
      }
    }
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  private async callModel(packedContext: string, modelClient: ModelClient): Promise<string> {
    const input: ResponseItem[] = [
      {
        type: 'message' as const,
        role: 'user',
        content: [
          {
            type: 'input_text' as const,
            text: SUGGESTION_PROMPT.replace('{packedContext}', packedContext),
          },
        ],
      },
    ];

    const stream = await modelClient.stream({ input, tools: [] });
    let out = '';
    for await (const event of stream) {
      if (isOutputTextDelta(event)) out += event.delta;
      if (isCompleted(event)) break;
    }
    return out.trim();
  }

  /**
   * Produce a filtered next-prompt suggestion, or `{ success:true,
   * suggestion:undefined }` when there is nothing worth showing.
   */
  async generateSuggestion(
    history: ResponseItem[],
    modelClient: ModelClient,
  ): Promise<PromptSuggestionResult> {
    const turns = this.extractRecentTurns(history);
    if (turns.length === 0) {
      return { success: true, suggestion: undefined };
    }
    const lastAssistant =
      [...turns].reverse().find((t) => t.role === 'assistant')?.text ?? '';
    const ctx: RejectCtx = { lastAssistant, maxLength: this.config.maxLength };

    try {
      const suggestion = await withModelRetry(
        async () => {
          const packed = this.packContext(turns);
          const raw = await this.callModel(packed, modelClient);
          return this.clean(raw);
        },
        {
          maxRetries: this.config.maxRetries,
          unattended: false,
          source: 'background',
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          computeBackoffMs: (attempt) =>
            this.config.baseBackoffMs * Math.pow(2, attempt - 1),
        },
      );

      for (const rule of REJECT_RULES) {
        if (rule.test(suggestion, ctx)) {
          return { success: true, suggestion: undefined };
        }
      }
      return { success: true, suggestion };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
