/**
 * x402 402 detection / requirement parsing.
 *
 * Ported from claudy's `parsePaymentRequirement`. This is the ONLY supported
 * way a 402 enters the payment path — and only the resource-fetch tool calls
 * it. Browser navigation 402s are observed-and-surfaced by NetworkInterceptTool,
 * never routed here (design decision 2).
 *
 * @module core/payments/x402/detect
 */

import type { PaymentRequirement } from './types';

/**
 * Parse the `x-payment-required` header value into a PaymentRequirement.
 * Throws on malformed input — callers treat a throw as "cannot pay, surface
 * the original 402".
 */
export function parsePaymentRequirement(headerValue: string): PaymentRequirement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch (err) {
    throw new Error(
      `Invalid x402 payment requirement header: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const p = parsed as Partial<PaymentRequirement>;
  if (!p || typeof p !== 'object') {
    throw new Error('Invalid x402 payment requirement: not an object');
  }
  if (!p.scheme || !p.network || !p.maxAmountRequired || !p.payTo || !p.asset) {
    throw new Error(
      'Invalid x402 payment requirement: missing required field(s) (scheme/network/maxAmountRequired/payTo/asset)',
    );
  }
  if (p.scheme !== 'exact') {
    throw new Error(`Unsupported x402 scheme: ${String(p.scheme)} (only 'exact' supported)`);
  }
  return {
    scheme: 'exact',
    network: p.network,
    maxAmountRequired: String(p.maxAmountRequired),
    resource: typeof p.resource === 'string' ? p.resource : '',
    description: typeof p.description === 'string' ? p.description : '',
    mimeType: typeof p.mimeType === 'string' ? p.mimeType : undefined,
    payTo: p.payTo,
    maxTimeoutSeconds:
      typeof p.maxTimeoutSeconds === 'number' && p.maxTimeoutSeconds > 0
        ? p.maxTimeoutSeconds
        : 60,
    asset: p.asset,
    extra: p.extra,
  };
}
