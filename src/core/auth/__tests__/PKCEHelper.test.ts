import { describe, it, expect } from 'vitest';
import { generatePKCEChallenge, randomUrlToken, base64UrlEncode } from '../PKCEHelper';

describe('PKCEHelper', () => {
  describe('generatePKCEChallenge', () => {
    it('returns a base64url verifier and S256 challenge', async () => {
      const { codeVerifier, codeChallenge } = await generatePKCEChallenge();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 random bytes, base64url-encoded without padding => 43 chars
      expect(codeVerifier).toHaveLength(43);
      // SHA-256 digest (32 bytes), base64url-encoded without padding => 43 chars
      expect(codeChallenge).toHaveLength(43);
    });

    it('produces a fresh pair on each call', async () => {
      const a = await generatePKCEChallenge();
      const b = await generatePKCEChallenge();
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });

    it('derives the challenge as the S256 hash of the verifier', async () => {
      const { codeVerifier, codeChallenge } = await generatePKCEChallenge();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
      expect(base64UrlEncode(new Uint8Array(digest))).toBe(codeChallenge);
    });
  });

  describe('randomUrlToken', () => {
    it('is url-safe, unpadded, and unique per call', () => {
      const a = randomUrlToken();
      const b = randomUrlToken();
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(a).not.toContain('=');
      expect(a).not.toBe(b);
    });

    it('respects byteLength (16 bytes => 22 unpadded base64url chars)', () => {
      expect(randomUrlToken(16)).toHaveLength(22);
    });
  });

  describe('base64UrlEncode', () => {
    it('uses the url-safe alphabet without padding', () => {
      // bytes 0xFB 0xFF -> standard base64 "+/8=" -> url-safe unpadded "-_8"
      expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    });
  });
});
