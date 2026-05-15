// File: src/core/queue/__tests__/priorityForOp.test.ts
//
// Track 08 — EngineOp → priority mapping lock test
//
// Adding a new EngineOp variant should also add a case in priorityForOp.ts
// and an assertion below.

import { describe, expect, it } from 'vitest';
import type { EngineOp } from '../../engine/RepublicAgentEngineConfig';
import { priorityForOp } from '../priorityForOp';

describe('priorityForOp', () => {
  describe("'now' ops (user is actively waiting)", () => {
    it("maps 'Interrupt' to 'now'", () => {
      expect(priorityForOp({ type: 'Interrupt' } as EngineOp)).toBe('now');
    });

    it("maps 'Shutdown' to 'now'", () => {
      expect(priorityForOp({ type: 'Shutdown' } as EngineOp)).toBe('now');
    });

    it("maps 'ExecApproval' to 'now'", () => {
      expect(priorityForOp({ type: 'ExecApproval' } as EngineOp)).toBe('now');
    });

    it("maps 'PatchApproval' to 'now'", () => {
      expect(priorityForOp({ type: 'PatchApproval' } as EngineOp)).toBe('now');
    });
  });

  describe("'next' ops (foreground submissions)", () => {
    it("maps 'UserInput' to 'next'", () => {
      expect(priorityForOp({ type: 'UserInput', items: [] } as EngineOp)).toBe('next');
    });

    it("maps 'UserTurn' to 'next'", () => {
      expect(priorityForOp({ type: 'UserTurn', items: [] } as EngineOp)).toBe('next');
    });

    it("maps 'ManualCompact' to 'next'", () => {
      expect(priorityForOp({ type: 'ManualCompact' } as EngineOp)).toBe('next');
    });

    it("maps 'ClearHistory' to 'next'", () => {
      expect(priorityForOp({ type: 'ClearHistory' } as EngineOp)).toBe('next');
    });
  });

  describe("'later' ops (background work)", () => {
    it("maps 'Compact' to 'later'", () => {
      expect(priorityForOp({ type: 'Compact' } as EngineOp)).toBe('later');
    });

    it("maps 'Compact' with mode 'auto' to 'later'", () => {
      expect(priorityForOp({ type: 'Compact', mode: 'auto' } as EngineOp)).toBe('later');
    });

    it("maps 'Compact' with mode 'manual' to 'later'", () => {
      // 'Compact' goes to 'later' regardless of mode; 'ManualCompact' is the
      // explicit user-triggered variant that goes to 'next'.
      expect(priorityForOp({ type: 'Compact', mode: 'manual' } as EngineOp)).toBe('later');
    });

    it("maps 'AddToHistory' to 'later'", () => {
      expect(priorityForOp({ type: 'AddToHistory', text: 'foo' } as EngineOp)).toBe('later');
    });
  });

  describe("default fallback", () => {
    it("returns 'next' for unknown op types (future variants)", () => {
      // Forced cast — verifies the default arm of the switch returns the
      // safe 'next' default rather than undefined.
      expect(priorityForOp({ type: 'SomeFutureOp' } as unknown as EngineOp)).toBe('next');
    });
  });
});
