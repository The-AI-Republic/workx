/**
 * x402 signer — the single crypto integration seam.
 *
 * Claudy's hand-rolled EIP-712/secp256k1 is intentionally NOT ported: it was
 * verified broken (uses SHA3-256 where Ethereum needs Keccak-256; hardcodes
 * recovery v=27) and would emit signatures the USDC contract rejects. Real
 * signing must go through the vetted `coinbase/x402` SDK.
 *
 * That SDK is a runtime dependency that is not yet installed (and cannot be
 * verified offline). Per the design, real signing is Phase-4 gated ("no real
 * funds before Phase 4"), so `CoinbaseX402Signer` dynamically imports the SDK
 * and fails loudly with an actionable message if it is absent. Every layer
 * around the signer (detection, caps, per-platform routing, approval, server
 * policy, tracking, the command) is fully implemented and tested via the
 * mockable `Signer` interface — only this one method is integration-pending.
 *
 * @module core/payments/x402/signer
 */

import type { PaymentPayload, PaymentRequirement, Signer } from './types';

/**
 * Extension signer: never holds a hot key, never signs. The extension detects
 * and surfaces a 402 for human approval (or delegates to a paired host) — it
 * is never an autonomous payer (design decision: worst custody environment).
 */
export class NoopSigner implements Signer {
  async getAddress(): Promise<string | undefined> {
    return undefined;
  }

  async signPayment(): Promise<PaymentPayload> {
    throw new Error(
      'NoopSigner cannot sign: this platform (extension) never custodies a signing key. ' +
        'Pay from desktop/server or delegate signing to a paired trusted host.',
    );
  }
}

/**
 * Real signer backed by the `coinbase/x402` SDK + a private key resolver.
 * The SDK import is dynamic so the bundle/tests do not require the package;
 * absence yields a clear, actionable error rather than a silent failure.
 */
export class CoinbaseX402Signer implements Signer {
  constructor(
    private readonly getPrivateKey: () => Promise<string | undefined>,
    private readonly deriveAddress: (sdk: unknown, privateKey: string) => Promise<string>,
  ) {}

  private async loadSdk(): Promise<unknown> {
    try {
      // Non-literal specifier so TS does not try to resolve the (not yet
      // installed) optional package at build time; absence is handled below.
      const pkg = 'x402';
      return await import(/* @vite-ignore */ pkg);
    } catch (err) {
      throw new Error(
        'x402 signing requires the `coinbase/x402` SDK (npm: "x402"), which is not installed. ' +
          'Install it and complete the Phase-4 key-custody + legal review before enabling real payments. ' +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getAddress(): Promise<string | undefined> {
    const pk = await this.getPrivateKey();
    if (!pk) return undefined;
    const sdk = await this.loadSdk();
    return this.deriveAddress(sdk, pk);
  }

  async signPayment(
    requirement: PaymentRequirement,
    fromAddress: string,
  ): Promise<PaymentPayload> {
    const pk = await this.getPrivateKey();
    if (!pk) {
      throw new Error('x402 signing failed: no private key available for this platform');
    }
    const sdk = await this.loadSdk();

    // Integration seam: the coinbase/x402 SDK constructs + signs the EIP-3009
    // transferWithAuthorization payload. The exact SDK surface is pinned at
    // install time (Phase 4). We fail closed until then rather than emit
    // unverified crypto.
    void sdk;
    void requirement;
    void fromAddress;
    throw new Error(
      'x402 real signing is Phase-4 gated. The coinbase/x402 SDK integration is the single ' +
        'remaining seam; complete the key-custody + regulatory review (design.md Phase 4) before ' +
        'wiring SDK signing. No real funds may move before then.',
    );
  }
}
