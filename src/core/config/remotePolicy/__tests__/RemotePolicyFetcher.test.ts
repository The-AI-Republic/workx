import { describe, it, expect } from 'vitest';
import {
  fetchRemotePolicy,
  computePolicyChecksum,
} from '../RemotePolicyFetcher';

function res(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const policyBody = {
  values: { 'agent.approval.mode': 'yolo' },
  lockedKeys: ['agent.approval.mode'],
};

describe('RemotePolicyFetcher', () => {
  it('200 → updated with a remote-origin policy', async () => {
    const r = await fetchRemotePolicy({
      endpoint: 'https://x/policy',
      fetchImpl: async () => res(200, policyBody),
    });
    expect(r.status).toBe('updated');
    expect(r.policy).toEqual({ ...policyBody, origin: 'remote' });
  });

  it('304 → unchanged', async () => {
    const r = await fetchRemotePolicy({
      endpoint: 'https://x',
      cachedChecksum: 'sha256:abc',
      fetchImpl: async (_u, init) => {
        expect((init?.headers as Record<string, string>)['If-None-Match']).toBe(
          '"sha256:abc"'
        );
        return res(304);
      },
    });
    expect(r.status).toBe('unchanged');
  });

  it('204 and 404 → cleared (managed policy removed)', async () => {
    expect(
      (await fetchRemotePolicy({ endpoint: 'x', fetchImpl: async () => res(204) }))
        .status
    ).toBe('cleared');
    expect(
      (await fetchRemotePolicy({ endpoint: 'x', fetchImpl: async () => res(404) }))
        .status
    ).toBe('cleared');
  });

  it('empty-but-valid body → cleared', async () => {
    const r = await fetchRemotePolicy({
      endpoint: 'x',
      fetchImpl: async () => res(200, { values: {}, lockedKeys: [] }),
    });
    expect(r.status).toBe('cleared');
  });

  it('401/403 → error skipRetry; 500 → error; throw → error', async () => {
    expect(
      await fetchRemotePolicy({ endpoint: 'x', fetchImpl: async () => res(401) })
    ).toEqual({ status: 'error', skipRetry: true });
    expect(
      (await fetchRemotePolicy({ endpoint: 'x', fetchImpl: async () => res(500) }))
        .status
    ).toBe('error');
    expect(
      (
        await fetchRemotePolicy({
          endpoint: 'x',
          fetchImpl: async () => {
            throw new Error('network');
          },
        })
      ).status
    ).toBe('error');
  });

  it('no endpoint / no fetch → error (never throws)', async () => {
    expect((await fetchRemotePolicy({ endpoint: '' })).status).toBe('error');
  });

  it('checksum is stable under key reordering', async () => {
    const a = await computePolicyChecksum({ a: 1, b: { c: 2, d: 3 } });
    const b = await computePolicyChecksum({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });
});
