/**
 * Unit tests for NativeBrowserController.scroll()
 *
 * Verifies that coordinate values are safely coerced via Number() to
 * prevent JavaScript injection when building evaluate() expressions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock CDP dependencies before importing the SUT
// ---------------------------------------------------------------------------

const mockCDPClient = {
  attach: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
  enableDomain: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  sendCommand: vi.fn().mockResolvedValue({ result: { value: undefined } }),
  waitForEvent: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../NativeCDPClient', () => ({
  NativeCDPClient: vi.fn(() => mockCDPClient),
}));

const mockLauncher = {
  connectToRunning: vi.fn(),
  launchWithUserProfile: vi.fn(),
  launch: vi.fn(),
  close: vi.fn(),
};

vi.mock('../ChromeLauncher', () => ({
  ChromeLauncher: vi.fn(() => mockLauncher),
}));

import { NativeBrowserController } from '../NativeBrowserController';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialize the controller through the fallback chain */
async function createInitializedController(): Promise<NativeBrowserController> {
  const controller = new NativeBrowserController();
  await controller.initialize();
  return controller;
}

/**
 * Extract the `expression` string passed to Runtime.evaluate from the
 * most recent sendCommand call.
 */
function getLastEvaluatedExpression(): string {
  const calls = mockCDPClient.sendCommand.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === 'Runtime.evaluate') {
      return calls[i][1].expression;
    }
  }
  throw new Error('No Runtime.evaluate call found');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NativeBrowserController.scroll()', () => {
  let controller: NativeBrowserController;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Re-apply mocks after clearAllMocks (vitest restoreMocks resets them)
    mockLauncher.connectToRunning.mockResolvedValue({ success: false });
    mockLauncher.launchWithUserProfile.mockResolvedValue({ success: false });
    mockLauncher.launch.mockResolvedValue({ success: true, wsEndpoint: 'ws://localhost:9222' });
    mockLauncher.close.mockResolvedValue(undefined);

    mockCDPClient.attach.mockResolvedValue(undefined);
    mockCDPClient.enableDomain.mockResolvedValue(undefined);
    mockCDPClient.isConnected.mockReturnValue(true);

    // Default sendCommand mock: return appropriate shapes for each method
    mockCDPClient.sendCommand.mockImplementation(async (method: string, _params?: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: undefined } };
      }
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelector') {
        return { nodeId: 2 };
      }
      return {};
    });

    controller = await createInitializedController();
  });

  // -----------------------------------------------------------------------
  // Selector-based scroll (string target)
  // -----------------------------------------------------------------------

  describe('with string selector', () => {
    it('escapes the selector via JSON.stringify', async () => {
      await controller.scroll('#my-element');

      const expr = getLastEvaluatedExpression();
      // JSON.stringify produces: "#my-element" (with quotes)
      expect(expr).toContain('document.querySelector("#my-element")');
      expect(expr).toContain('scrollIntoView');
    });

    it('safely handles selectors with special characters', async () => {
      await controller.scroll('div[data-id="foo\'); alert(1); //"]');

      const expr = getLastEvaluatedExpression();
      // JSON.stringify wraps the value in double quotes and escapes internal
      // quotes, so the selector appears as an inert string literal — not as
      // raw executable code spliced into the expression.
      expect(expr).toContain('document.querySelector(');
      // The internal double quotes should be backslash-escaped by JSON.stringify
      expect(expr).toContain('\\"foo');
    });
  });

  // -----------------------------------------------------------------------
  // Coordinate-based scroll (object target)
  // -----------------------------------------------------------------------

  describe('with coordinate object', () => {
    it('produces valid numeric coordinates for normal numbers', async () => {
      await controller.scroll({ x: 100, y: 250 });

      const expr = getLastEvaluatedExpression();
      expect(expr).toContain('left: 100');
      expect(expr).toContain('top: 250');
      expect(expr).toContain('window.scrollTo');
    });

    it('handles zero coordinates', async () => {
      await controller.scroll({ x: 0, y: 0 });

      const expr = getLastEvaluatedExpression();
      expect(expr).toContain('left: 0');
      expect(expr).toContain('top: 0');
    });

    it('handles floating point coordinates', async () => {
      await controller.scroll({ x: 10.5, y: 20.7 });

      const expr = getLastEvaluatedExpression();
      expect(expr).toContain('left: 10.5');
      expect(expr).toContain('top: 20.7');
    });

    it('coerces non-numeric x to NaN instead of injecting code', async () => {
      // Simulate malformed runtime data bypassing TypeScript checks
      const malicious = { x: '0}); alert(1); //' as unknown as number, y: 0 };
      await controller.scroll(malicious);

      const expr = getLastEvaluatedExpression();
      // Number("0}); alert(1); //") produces NaN, not the raw string
      expect(expr).toContain('left: NaN');
      expect(expr).not.toContain('alert(1)');
    });

    it('coerces non-numeric y to NaN instead of injecting code', async () => {
      const malicious = { x: 0, y: '0}); document.cookie; //' as unknown as number };
      await controller.scroll(malicious);

      const expr = getLastEvaluatedExpression();
      expect(expr).toContain('top: NaN');
      expect(expr).not.toContain('document.cookie');
    });
  });
});
