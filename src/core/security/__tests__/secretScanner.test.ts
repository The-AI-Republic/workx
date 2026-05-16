/**
 * Fail-closed secret scanner unit tests (Track 24.5).
 */

import { describe, it, expect } from 'vitest';
import {
  scanForSecrets,
  BLOCKED_OUTBOUND_MESSAGE,
  MAX_SCAN_BYTES,
} from '../secretScanner';

describe('scanForSecrets — high-confidence secrets block + redact', () => {
  const cases: Array<[string, string]> = [
    ['openai-sk', 'here is the key sk-abcdef0123456789ABCDEF and more'],
    ['xai', 'token xai-abcdef0123456789ABCD done'],
    ['google-aiza', 'g AIzaSyA1234567890abcdefABCDEF_keyhere x'],
    ['aws-akia', 'aws AKIAIOSFODNN7EXAMPLE creds'],
    ['github-pat', 'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok'],
    ['slack-token', 'slack xoxb-1234567890-abcdefABCDEF token'],
    ['bearer', 'Authorization: Bearer abc.def-ghi_jkl done'],
    [
      'jwt',
      'jwt eyJhbGciOi.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4 here',
    ],
    ['kv-secret', 'config api_key="supersecretvalue123" rest'],
    ['url-userinfo', 'db at postgres://user:hunter2@localhost:5432/db now'],
  ];

  it.each(cases)('blocks and redacts a %s secret', (_id, input) => {
    const r = scanForSecrets(input);
    expect(r.block).toBe(true);
    expect(r.spans.length).toBeGreaterThan(0);
    expect(r.redacted).toContain('***');
    expect(r.redacted).not.toEqual(input);
  });

  it('redacts a PEM private key block and blocks', () => {
    const input =
      'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\ntail';
    const r = scanForSecrets(input);
    expect(r.block).toBe(true);
    expect(r.redacted).not.toContain('MIIEowIBAAKCAQEA');
    expect(r.redacted).toContain('***');
  });
});

describe('scanForSecrets — clean text is not blocked', () => {
  it('passes ordinary prose unchanged', () => {
    const input = 'Please open the second table and export it as a CSV file.';
    const r = scanForSecrets(input);
    expect(r.block).toBe(false);
    expect(r.spans).toHaveLength(0);
    expect(r.redacted).toEqual(input);
  });

  it('handles empty / non-string input safely', () => {
    expect(scanForSecrets('').block).toBe(false);
    // @ts-expect-error — defensive: callers should pass strings
    expect(scanForSecrets(undefined).block).toBe(false);
  });
});

describe('scanForSecrets — fail-closed on uncertainty', () => {
  it('blocks oversized input (uncertain) while still computing redacted', () => {
    const big = 'a'.repeat(MAX_SCAN_BYTES + 1);
    const r = scanForSecrets(big);
    expect(r.block).toBe(true);
    expect(typeof r.redacted).toBe('string');
  });

  it('generic high-entropy blob redacts but does NOT hard-block', () => {
    const blob = 'x ' + 'A1b2C3d4'.repeat(6) + ' y'; // 48 chars, no key prefix
    const r = scanForSecrets(blob);
    expect(r.redacted).toContain('***');
    expect(r.block).toBe(false);
  });
});

describe('BLOCKED_OUTBOUND_MESSAGE', () => {
  it('is a fixed non-empty safe string', () => {
    expect(BLOCKED_OUTBOUND_MESSAGE).toMatch(/blocked/i);
    expect(BLOCKED_OUTBOUND_MESSAGE.length).toBeGreaterThan(0);
  });
});
