/**
 * x402 Agentic Payments (Track 23) — public barrel.
 *
 * HTTP 402 micropayments as an explicit, per-platform, default-OFF capability.
 * Not a global fetch interceptor (browserx has no chokepoint and its web tools
 * are Chrome/CDP-driven and cannot see HTTP status) — only the resource-fetch
 * tool consumes this, and browser navigation 402s are never auto-paid.
 *
 * @module core/payments/x402
 */

export * from './types';
export {
  getX402Config,
  saveX402Config,
  isX402Enabled,
} from './config';
export {
  addX402Payment,
  getX402SessionSpentUSD,
  getX402SessionPayments,
  getX402PaymentCount,
  resetX402SessionPayments,
  formatX402Cost,
  setX402PaymentSink,
} from './tracker';
export { parsePaymentRequirement } from './detect';
export {
  validatePaymentRequirement,
  type LimitCheckInput,
  type LimitCheckResult,
} from './limits';
export { NoopSigner, CoinbaseX402Signer } from './signer';
export { PaymentKeyStore } from './PaymentKeyStore';
export {
  createPaymentCapability,
  type PaymentCapabilityDeps,
  type AuditFn,
} from './capability';
