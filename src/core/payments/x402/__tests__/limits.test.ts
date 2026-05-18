import { describe, it, expect } from 'vitest';
import { validatePaymentRequirement } from '@/core/payments/x402/limits';
import { USDC_ADDRESSES, type PaymentRequirement } from '@/core/payments/x402/types';

function req(over: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '50000', // $0.05
    resource: 'https://api.example.com/data',
    description: '',
    payTo: '0xPayee',
    maxTimeoutSeconds: 60,
    asset: USDC_ADDRESSES.base,
    ...over,
  };
}

const base = {
  sessionSpentUSD: 0,
  maxPaymentPerRequestUSD: 0.1,
  maxSessionSpendUSD: 5,
  configuredNetwork: 'base' as const,
};

describe('validatePaymentRequirement', () => {
  it('accepts a payment within all caps', () => {
    const r = validatePaymentRequirement({ requirement: req(), ...base });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.amountUSD).toBeCloseTo(0.05);
  });

  it('rejects over per-request cap', () => {
    const r = validatePaymentRequirement({
      requirement: req({ maxAmountRequired: '200000' }), // $0.20
      ...base,
    });
    expect(r.valid).toBe(false);
  });

  it('rejects over session cap', () => {
    const r = validatePaymentRequirement({
      requirement: req(),
      ...base,
      sessionSpentUSD: 4.99,
    });
    expect(r.valid).toBe(false);
  });

  it('rejects network mismatch', () => {
    const r = validatePaymentRequirement({
      requirement: req({ network: 'ethereum', asset: USDC_ADDRESSES.ethereum }),
      ...base,
    });
    expect(r.valid).toBe(false);
  });

  it('rejects unknown asset', () => {
    const r = validatePaymentRequirement({
      requirement: req({ asset: '0xDEADBEEF' }),
      ...base,
    });
    expect(r.valid).toBe(false);
  });

  it('rejects partially numeric or non-integer base-unit amounts', () => {
    for (const maxAmountRequired of [
      '50000abc',
      '0.5',
      '',
      ' 50000',
      '9007199254740992',
      '0',
    ]) {
      const r = validatePaymentRequirement({
        requirement: req({ maxAmountRequired }),
        ...base,
      });
      expect(r.valid).toBe(false);
    }
  });
});
