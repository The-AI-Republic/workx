import { describe, it, expect } from 'vitest';
import type { ResponseItem } from '../../protocol/types';
import {
  DEFAULT_SESSION_SUMMARY_CONFIG,
  countToolCalls,
  createInitialExtractionState,
  recordExtractionSnapshot,
  shouldExtractSessionSummary,
} from '../sessionSummaryUtils';

function userMsg(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function asstMsg(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function toolCall(name: string, args: string): ResponseItem {
  return {
    type: 'function_call',
    name,
    call_id: 'cid-' + Math.random().toString(36).slice(2, 8),
    arguments: args,
  } as ResponseItem;
}

/** A "big" history that puts us comfortably over the 15k init threshold. */
function bigHistory(): ResponseItem[] {
  const items: ResponseItem[] = [];
  // Each message ~600 chars → ~150 tokens. 120 messages → ~18k tokens.
  for (let i = 0; i < 120; i++) {
    const filler = 'x'.repeat(600);
    items.push(i % 2 === 0 ? userMsg(filler) : asstMsg(filler));
  }
  return items;
}

describe('sessionSummaryUtils', () => {
  describe('countToolCalls', () => {
    it('counts function_call items', () => {
      const history = [
        toolCall('a', '{}'),
        userMsg('q'),
        toolCall('b', '{}'),
      ];
      expect(countToolCalls(history)).toBe(2);
    });

    it('counts custom_tool_call items', () => {
      const history: ResponseItem[] = [
        { type: 'custom_tool_call', name: 'x', call_id: 'c1', input: '{}' } as ResponseItem,
        userMsg('q'),
      ];
      expect(countToolCalls(history)).toBe(1);
    });

    it('returns 0 for chat-only history', () => {
      expect(countToolCalls([userMsg('hi'), asstMsg('hello')])).toBe(0);
    });
  });

  describe('shouldExtractSessionSummary', () => {
    it('returns false below init threshold', () => {
      const history = [userMsg('hi')];
      const state = createInitialExtractionState();
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: false,
        }),
      ).toBe(false);
    });

    it('init fires once tokens cross threshold and last turn had no tool calls', () => {
      const history = bigHistory();
      const state = createInitialExtractionState();
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: false,
        }),
      ).toBe(true);
    });

    it('does not fire on init alone if last turn had tool calls and tool delta is low', () => {
      const history = bigHistory();
      // Only 2 tool calls — below the toolCallsBetweenUpdates threshold of 5
      history.push(toolCall('t1', '{}'), toolCall('t2', '{}'));
      const state = createInitialExtractionState();
      // Tool calls in last turn → only fires when BOTH thresholds met
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: true,
        }),
      ).toBe(false);
    });

    it('fires on both thresholds (tokens + 5 tool calls) when last turn had tools', () => {
      const history = bigHistory();
      for (let i = 0; i < 5; i++) history.push(toolCall('t', '{}'));
      const state = createInitialExtractionState();
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: true,
        }),
      ).toBe(true);
    });

    it('after first extraction, requires token growth before firing again', () => {
      const history = bigHistory();
      const state = createInitialExtractionState();
      recordExtractionSnapshot(state, history);

      // Same history — no growth. Should not fire.
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: false,
        }),
      ).toBe(false);
    });

    it('fires again after the configured token growth has accumulated', () => {
      const history = bigHistory();
      const state = createInitialExtractionState();
      recordExtractionSnapshot(state, history);

      // Add ~9k tokens of growth (config requires 8k).
      for (let i = 0; i < 60; i++) {
        history.push(userMsg('y'.repeat(600)));
      }
      expect(
        shouldExtractSessionSummary({
          history,
          state,
          lastTurnHadToolCalls: false,
        }),
      ).toBe(true);
    });
  });

  describe('DEFAULT_SESSION_SUMMARY_CONFIG', () => {
    it('has the locked-in 15k/8k/5 thresholds', () => {
      expect(DEFAULT_SESSION_SUMMARY_CONFIG).toEqual({
        minimumMessageTokensToInit: 15_000,
        minimumTokensBetweenUpdate: 8_000,
        toolCallsBetweenUpdates: 5,
      });
    });
  });
});
