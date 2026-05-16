/**
 * redactDoctorReport unit tests (Track 17).
 */

import { describe, it, expect } from 'vitest';
import { redactDoctorReport } from '../redact';
import type { DoctorReport } from '../types';

const base: DoctorReport = {
  overall: 'warn',
  platformId: 'server',
  generatedAt: 1,
  durationMs: 2,
  checks: [],
};

describe('redactDoctorReport', () => {
  it('redacts secrets in detail and nested data; preserves [SECURED]', () => {
    const report: DoctorReport = {
      ...base,
      checks: [
        {
          id: 'x',
          title: 'X',
          status: 'fail',
          detail:
            'key sk-abcdEFGH1234567890 and Bearer abc.def-ghi failed; marker [SECURED] ok',
          data: {
            url: 'https://user:p4ssw0rd@host.example/path',
            apiKey: 'sk-zzzzzzzzzzzzzzzzzz',
            jwt: 'eyJhbGc.eyJzdWI.sig_part',
            nested: { token: 'deadbeefdeadbeef', safe: 'plain text' },
            marker: '[SECURED]',
          },
        },
      ],
    };

    const out = redactDoctorReport(report);
    const c = out.checks[0];

    expect(c.detail).not.toMatch(/sk-abcdEFGH1234567890/);
    expect(c.detail).toMatch(/\*\*\*/);
    expect(c.detail).toContain('[SECURED]');
    expect(c.detail).toMatch(/Bearer \*\*\*/);

    const d = c.data as Record<string, unknown>;
    expect(d.url).toBe('https://user:***@host.example/path');
    expect(d.apiKey).toBe('***');
    expect(d.jwt).toBe('***');
    expect((d.nested as Record<string, unknown>).token).toMatch(/\*\*\*/);
    expect((d.nested as Record<string, unknown>).safe).toBe('plain text');
    expect(d.marker).toBe('[SECURED]');
  });

  it('does not mutate the input report', () => {
    const report: DoctorReport = {
      ...base,
      checks: [
        {
          id: 'y',
          title: 'Y',
          status: 'fail',
          detail: 'sk-shouldNotChangeInput123',
          data: { k: 'sk-shouldNotChangeInput123' },
        },
      ],
    };
    const snapshot = JSON.stringify(report);
    redactDoctorReport(report);
    expect(JSON.stringify(report)).toBe(snapshot);
  });

  it('propagates a sensitive parent key into nested objects (no shape escape)', () => {
    const report: DoctorReport = {
      ...base,
      checks: [
        {
          id: 'n',
          title: 'N',
          status: 'fail',
          detail: '',
          data: {
            // Parent key is sensitive but the inner key names are NOT —
            // the inner values must still be scrubbed (regression: objects
            // used to escape because the flag was not inherited; arrays
            // already did).
            token: { plain: 'notapatternjustplaintext', count: 7 },
            credentials: { accountId: 'acct-123', endpoint: 'host.example' },
            authorization: ['raw-a', 'raw-b'],
            normal: { ok: 'visible', n: 1 },
          },
        },
      ],
    };

    const d = redactDoctorReport(report).checks[0].data as Record<
      string,
      unknown
    >;
    const token = d.token as Record<string, unknown>;
    const credentials = d.credentials as Record<string, unknown>;
    const normal = d.normal as Record<string, unknown>;

    expect(token.plain).toBe('***');
    expect(token.count).toBe('***');
    expect(credentials.accountId).toBe('***');
    expect(credentials.endpoint).toBe('***');
    expect(d.authorization).toEqual(['***', '***']);
    // A non-sensitive subtree is untouched.
    expect(normal.ok).toBe('visible');
    expect(normal.n).toBe(1);
  });

  it('scrubs credential/auth-named keys + key=value pairs; spares lookalikes', () => {
    const report: DoctorReport = {
      ...base,
      checks: [
        {
          id: 'c',
          title: 'C',
          status: 'fail',
          detail: 'credential=supersecretval and auth: sessionTok123 here',
          data: {
            credential: 'rawCredentialValue',
            credentials: 'rawCredentialsValue',
            auth: 'rawAuthValue',
            service_auth: 'rawScopedAuth',
            // Lookalikes that must NOT be over-redacted (anchored regex).
            author: 'Jane Doe',
            oauthFlow: 'pkce',
          },
        },
      ],
    };

    const c = redactDoctorReport(report).checks[0];
    expect(c.detail).not.toMatch(/supersecretval/);
    expect(c.detail).not.toMatch(/sessionTok123/);
    expect(c.detail).toMatch(/credential[:=]?\s*\*\*\*/);

    const d = c.data as Record<string, unknown>;
    expect(d.credential).toBe('***');
    expect(d.credentials).toBe('***');
    expect(d.auth).toBe('***');
    expect(d.service_auth).toBe('***');
    expect(d.author).toBe('Jane Doe');
    expect(d.oauthFlow).toBe('pkce');
  });
});
