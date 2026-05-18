import { describe, it, expect } from 'vitest';
import { parsePaymentRequirement } from '@/core/payments/x402/detect';
import { USDC_ADDRESSES } from '@/core/payments/x402/types';

function valid(): string {
  return JSON.stringify({
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '50000',
    resource: 'https://api.example.com/data',
    description: 'premium data',
    payTo: '0xPayee',
    maxTimeoutSeconds: 120,
    asset: USDC_ADDRESSES.base,
  });
}

describe('parsePaymentRequirement', () => {
  it('parses a well-formed header', () => {
    const r = parsePaymentRequirement(valid());
    expect(r.scheme).toBe('exact');
    expect(r.network).toBe('base');
    expect(r.maxAmountRequired).toBe('50000');
    expect(r.payTo).toBe('0xPayee');
    expect(r.maxTimeoutSeconds).toBe(120);
  });

  it('throws on malformed JSON', () => {
    expect(() => parsePaymentRequirement('{not json')).toThrow(/Invalid x402/);
  });

  it('throws on missing required fields', () => {
    expect(() =>
      parsePaymentRequirement(JSON.stringify({ scheme: 'exact', network: 'base' })),
    ).toThrow(/missing required field/);
  });

  it('throws on unsupported scheme', () => {
    const bad = JSON.parse(valid());
    bad.scheme = 'upto';
    expect(() => parsePaymentRequirement(JSON.stringify(bad))).toThrow(/Unsupported x402 scheme/);
  });

  it('throws on unsupported network', () => {
    const bad = JSON.parse(valid());
    bad.network = 'not-a-chain';
    expect(() => parsePaymentRequirement(JSON.stringify(bad))).toThrow(/Unsupported x402 network/);
  });

  it('defaults maxTimeoutSeconds when absent/invalid', () => {
    const o = JSON.parse(valid());
    delete o.maxTimeoutSeconds;
    expect(parsePaymentRequirement(JSON.stringify(o)).maxTimeoutSeconds).toBe(60);
  });
});
