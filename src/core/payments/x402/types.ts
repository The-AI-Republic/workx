/**
 * x402 Protocol Types (Track 23)
 *
 * HTTP 402 Payment Required micropayments (USDC). Ported in spirit from
 * claudy's `services/x402/types.ts` but adapted to workx's per-platform
 * capability model — there is no global fetch interceptor; payment is an
 * explicit capability the resource-fetch tool opts into.
 *
 * @see https://github.com/coinbase/x402
 * @module core/payments/x402/types
 */

/** Supported payment schemes (claudy supports only 'exact'; we match that). */
export type PaymentScheme = 'exact';

/** Supported blockchain networks. */
export type PaymentNetwork =
  | 'base'
  | 'base-sepolia'
  | 'ethereum'
  | 'ethereum-sepolia';

export const PAYMENT_NETWORKS = [
  'base',
  'base-sepolia',
  'ethereum',
  'ethereum-sepolia',
] as const satisfies readonly PaymentNetwork[];

export function isPaymentNetwork(value: unknown): value is PaymentNetwork {
  return typeof value === 'string' && (PAYMENT_NETWORKS as readonly string[]).includes(value);
}

/** The three workx deploy targets. */
export type PaymentPlatform = 'extension' | 'desktop' | 'server';

/** Payment requirement parsed from the `x-payment-required` 402 header. */
export interface PaymentRequirement {
  scheme: PaymentScheme;
  network: PaymentNetwork;
  /** Max amount in the token's smallest unit (USDC has 6 decimals). */
  maxAmountRequired: string;
  /** The resource URL being paid for. */
  resource: string;
  /** Human-readable description of what is being purchased. */
  description: string;
  mimeType?: string;
  /** Recipient wallet address (EIP-55 checksummed). */
  payTo: string;
  /** Max seconds the server waits for settlement. */
  maxTimeoutSeconds: number;
  /** Token contract address. */
  asset: string;
  extra?: {
    name?: string;
    version?: string;
  };
}

/** Signed payment payload base64-encoded into the `x-payment` request header. */
export interface PaymentPayload {
  x402Version: 1;
  scheme: PaymentScheme;
  network: PaymentNetwork;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/** A recorded x402 payment, for the session ledger / cost surface. */
export interface X402PaymentRecord {
  timestamp: number;
  resource: string;
  amount: string;
  amountUSD: number;
  token: string;
  network: PaymentNetwork;
  payTo: string;
  signature: string;
}

/**
 * x402 user configuration (extension/desktop). The server does NOT use this —
 * it reads `server.x402` from the server Zod config instead (Track 20 absent).
 */
export interface X402Config {
  enabled: boolean;
  network: PaymentNetwork;
  /** Derived wallet address (display only; never the private key). */
  address?: string;
  maxPaymentPerRequestUSD: number;
  maxSessionSpendUSD: number;
}

/** Header names used by the x402 protocol (lowercase, per claudy). */
export const X402_HEADERS = {
  /** Server → client: payment requirement (JSON). */
  PAYMENT_REQUIRED: 'x-payment-required',
  /** Client → server: signed payment payload (base64 JSON). */
  PAYMENT: 'x-payment',
} as const;

/** USDC contract addresses by network. */
export const USDC_ADDRESSES: Record<PaymentNetwork, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'ethereum': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ethereum-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
} as const;

/**
 * Default config — DISABLED everywhere (Track 22 feature-flag system is
 * absent in src/, so this in-track default is the gate). Matches claudy's
 * verified defaults: $0.10/request, $5.00/session.
 */
export const X402_DEFAULTS: X402Config = {
  enabled: false,
  network: 'base',
  maxPaymentPerRequestUSD: 0.1,
  maxSessionSpendUSD: 5.0,
} as const;

/** Context the resource-fetch tool passes when asking the capability to pay. */
export interface PaymentContext {
  /** The URL that returned 402. */
  url: string;
  sessionId?: string;
  turnId?: string;
}

/** Result of an attempted payment. */
export type PaymentResult =
  | { paid: true; paymentHeader: string; record: X402PaymentRecord }
  | { paid: false; reason: string; dryRun?: boolean };

/**
 * The payment capability, injected onto `ToolContext.payments` by each
 * platform bootstrap and consumed ONLY by the resource-fetch tool. Browser
 * navigation tools are never wired to this by construction (design decision 2).
 */
export interface PaymentCapability {
  /**
   * Attempt to satisfy a 402. Returns `{ paid: true, paymentHeader }` only
   * when enabled + within caps + platform-permitted (approved on ext/desktop,
   * allowlisted on server). Otherwise `{ paid: false, reason }` — the caller
   * must surface the original 402 unchanged.
   */
  tryPay(requirement: PaymentRequirement, ctx: PaymentContext): Promise<PaymentResult>;
}

/**
 * Signer abstraction. The real implementation wraps the `coinbase/x402` SDK
 * (the single crypto integration seam — see signer.ts). Tests mock this.
 * Claudy's hand-rolled EIP-712 is intentionally NOT ported (verified broken:
 * SHA3-256 used as Keccak-256; hardcoded recovery v).
 */
export interface Signer {
  /** Wallet address this signer pays from, or undefined if no key. */
  getAddress(): Promise<string | undefined>;
  /** Produce a signed x402 payment payload for a requirement. */
  signPayment(
    requirement: PaymentRequirement,
    fromAddress: string,
  ): Promise<PaymentPayload>;
}

/** USDC has 6 decimal places. */
export const USDC_DECIMALS = 6;

/** Convert a token smallest-unit amount string to USD (1 USDC ≈ 1 USD). */
export function tokenAmountToUSD(amount: string): number {
  if (!/^(0|[1-9]\d*)$/.test(amount)) return NaN;
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) return NaN;
  return Number.isFinite(n) ? n / 10 ** USDC_DECIMALS : NaN;
}
