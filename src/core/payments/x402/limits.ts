/**
 * x402 spend-limit validation — enforced BEFORE any signing.
 *
 * Ported from claudy's `validatePaymentRequirement`. Per-request and
 * per-session USD caps, network match, and USDC-asset match. The server adds
 * its own allowlist + per-day cap on top (see capability.ts).
 *
 * @module core/payments/x402/limits
 */

import {
  tokenAmountToUSD,
  USDC_ADDRESSES,
  type PaymentNetwork,
  type PaymentRequirement,
} from './types';

export interface LimitCheckInput {
  requirement: PaymentRequirement;
  /** USD already spent this session (from the tracker). */
  sessionSpentUSD: number;
  maxPaymentPerRequestUSD: number;
  maxSessionSpendUSD: number;
  /** The network the wallet is configured for. */
  configuredNetwork: PaymentNetwork;
}

export type LimitCheckResult =
  | { valid: true; amountUSD: number }
  | { valid: false; reason: string };

/** Validate a requirement against the configured caps + network + asset. */
export function validatePaymentRequirement(input: LimitCheckInput): LimitCheckResult {
  const {
    requirement,
    sessionSpentUSD,
    maxPaymentPerRequestUSD,
    maxSessionSpendUSD,
    configuredNetwork,
  } = input;

  const amountUSD = tokenAmountToUSD(requirement.maxAmountRequired);
  if (!Number.isFinite(amountUSD) || amountUSD < 0) {
    return { valid: false, reason: `Unparseable payment amount '${requirement.maxAmountRequired}'` };
  }

  if (amountUSD > maxPaymentPerRequestUSD) {
    return {
      valid: false,
      reason: `Payment of $${amountUSD.toFixed(4)} exceeds per-request limit of $${maxPaymentPerRequestUSD.toFixed(2)}`,
    };
  }

  if (sessionSpentUSD + amountUSD > maxSessionSpendUSD) {
    return {
      valid: false,
      reason: `Payment would exceed session limit of $${maxSessionSpendUSD.toFixed(2)} (already spent $${sessionSpentUSD.toFixed(4)})`,
    };
  }

  if (requirement.network !== configuredNetwork) {
    return {
      valid: false,
      reason: `Payment requires network '${requirement.network}' but wallet is configured for '${configuredNetwork}'`,
    };
  }

  const expectedAsset = USDC_ADDRESSES[requirement.network];
  if (expectedAsset && requirement.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    return {
      valid: false,
      reason: `Unknown payment token ${requirement.asset} (expected USDC ${expectedAsset})`,
    };
  }

  return { valid: true, amountUSD };
}
