import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addX402Payment,
  getX402SessionSpentUSD,
  getX402PaymentCount,
  resetX402SessionPayments,
  _resetAllX402Payments,
  formatX402Cost,
  setX402PaymentSink,
} from '@/core/payments/x402/tracker';
import type { X402PaymentRecord } from '@/core/payments/x402/types';

function rec(amountUSD: number, resource: string): X402PaymentRecord {
  return {
    timestamp: Date.now(),
    resource,
    amount: String(Math.round(amountUSD * 1e6)),
    amountUSD,
    token: 'USDC',
    network: 'base',
    payTo: '0xPayee',
    signature: '0xsig',
  };
}

describe('x402 tracker (session-scoped)', () => {
  beforeEach(() => {
    _resetAllX402Payments();
    setX402PaymentSink(undefined);
  });

  it('accumulates per session and never cross-contaminates', () => {
    addX402Payment('S1', rec(0.05, 'https://a.com/x'));
    addX402Payment('S1', rec(0.1, 'https://a.com/y'));
    addX402Payment('S2', rec(1.0, 'https://b.com/z'));

    expect(getX402SessionSpentUSD('S1')).toBeCloseTo(0.15);
    expect(getX402SessionSpentUSD('S2')).toBeCloseTo(1.0);
    expect(getX402SessionSpentUSD('S3')).toBe(0);
    expect(getX402PaymentCount('S1')).toBe(2);
    expect(getX402PaymentCount()).toBe(3); // aggregate
  });

  it('reset clears only the targeted session', () => {
    addX402Payment('S1', rec(1, 'https://a.com/x'));
    addX402Payment('S2', rec(2, 'https://b.com/x'));
    resetX402SessionPayments('S1');
    expect(getX402SessionSpentUSD('S1')).toBe(0);
    expect(getX402SessionSpentUSD('S2')).toBeCloseTo(2);
  });

  it('formats per-session and aggregate summaries', () => {
    addX402Payment('S1', rec(0.05, 'https://api.example.com/a'));
    addX402Payment('S2', rec(0.05, 'https://api.example.com/b'));
    expect(formatX402Cost('S1')).toContain('1 request');
    expect(formatX402Cost()).toContain('2 requests'); // aggregate
  });

  it('sink failure never breaks accounting', () => {
    const sink = vi.fn(() => {
      throw new Error('boom');
    });
    setX402PaymentSink(sink);
    expect(() => addX402Payment('S1', rec(0.05, 'https://a.com/x'))).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
    expect(getX402SessionSpentUSD('S1')).toBeCloseTo(0.05);
  });
});
