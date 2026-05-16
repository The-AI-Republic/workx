import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addX402Payment,
  getX402SessionSpentUSD,
  getX402PaymentCount,
  resetX402SessionPayments,
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

describe('x402 tracker', () => {
  beforeEach(() => {
    resetX402SessionPayments();
    setX402PaymentSink(undefined);
  });

  it('accumulates spend and count', () => {
    addX402Payment(rec(0.05, 'https://a.com/x'));
    addX402Payment(rec(0.1, 'https://a.com/y'));
    expect(getX402PaymentCount()).toBe(2);
    expect(getX402SessionSpentUSD()).toBeCloseTo(0.15);
  });

  it('reset zeroes the ledger', () => {
    addX402Payment(rec(1, 'https://a.com/x'));
    resetX402SessionPayments();
    expect(getX402SessionSpentUSD()).toBe(0);
    expect(getX402PaymentCount()).toBe(0);
    expect(formatX402Cost()).toBe('');
  });

  it('groups the summary by domain', () => {
    addX402Payment(rec(0.05, 'https://api.example.com/a'));
    addX402Payment(rec(0.05, 'https://api.example.com/b'));
    const out = formatX402Cost();
    expect(out).toContain('api.example.com');
    expect(out).toContain('2 requests');
  });

  it('invokes the fold-in sink without letting it break accounting', () => {
    const sink = vi.fn(() => {
      throw new Error('boom');
    });
    setX402PaymentSink(sink);
    expect(() => addX402Payment(rec(0.05, 'https://a.com/x'))).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
    expect(getX402SessionSpentUSD()).toBeCloseTo(0.05);
  });
});
