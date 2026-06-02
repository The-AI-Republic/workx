import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { registerMethodHandler } from '@applepi/ws-server';
import { AppServerRequestProcessor } from '../AppServerRequestProcessor';
import { AppServerConnectionRegistry } from '../AppServerConnectionRegistry';
import { AppServerAuth, InMemoryTokenStore } from '../connection/AppServerAuth';
import { RequestScheduler } from '../scheduling/RequestScheduler';
import { AppServerRateLimiter } from '../connection/rateLimiter';
import { ConnectionWatchdog } from '../connection/ConnectionWatchdog';
import { AppServerStatusController } from '../status/AppServerStatus';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

let blockHealthList: ReturnType<typeof deferred> | null = null;

beforeAll(() => {
  registerMethodHandler('health', async () => ({ status: 'ok' }));
  registerMethodHandler('sessions.list', async () => {
    if (blockHealthList) await blockHealthList.promise;
    return { sessions: [] };
  });
});

interface Harness {
  processor: AppServerRequestProcessor;
  auth: AppServerAuth;
  token: string;
  sockets: Map<string, { sent: unknown[]; close: ReturnType<typeof vi.fn> }>;
  open: (id: string) => void;
  send: (id: string, frame: unknown) => Promise<void>;
  frames: (id: string) => any[];
  last: (id: string) => any;
}

async function makeHarness(opts?: { capacity?: number; requireAuth?: boolean }): Promise<Harness> {
  const registry = new AppServerConnectionRegistry();
  const store = new InMemoryTokenStore();
  const auth = new AppServerAuth({ requireAuth: opts?.requireAuth ?? true, store });
  const token = await auth.ensureToken();
  const status = new AppServerStatusController();
  let sessionCounter = 0;

  const sockets = new Map<string, { sent: unknown[]; close: ReturnType<typeof vi.fn> }>();

  const processor = new AppServerRequestProcessor({
    channelId: 'desktop-app-server',
    channelType: 'websocket',
    registry,
    auth,
    scheduler: new RequestScheduler({ capacity: opts?.capacity ?? 128 }),
    rateLimiter: new AppServerRateLimiter({ windowMs: 1000, max: 1000 }),
    watchdog: new ConnectionWatchdog({ handshakeTimeoutMs: 10_000 }),
    status,
    sessionFactory: async () => `sess_${++sessionCounter}`,
  });

  return {
    processor,
    auth,
    token,
    sockets,
    open: (id: string) => {
      const sent: unknown[] = [];
      const close = vi.fn();
      sockets.set(id, { sent, close });
      processor.onOpen(id, { send: (d) => sent.push(d), close, bufferedAmount: () => 0 }, true);
    },
    send: (id, frame) => processor.onMessage(id, JSON.stringify(frame)),
    frames: (id) => (sockets.get(id)!.sent as string[]).map((s) => JSON.parse(s)),
    last: (id) => {
      const arr = sockets.get(id)!.sent as string[];
      return JSON.parse(arr[arr.length - 1]);
    },
  };
}

function connectFrame(token?: string) {
  return {
    type: 'req',
    id: randomUUID(),
    method: 'connect',
    params: {
      protocolVersion: 1,
      clientId: 'test-client',
      clientMode: 'operator',
      auth: token ? { token } : undefined,
    },
  };
}

describe('AppServerRequestProcessor', () => {
  it('sends a connect.challenge on open', async () => {
    const h = await makeHarness();
    h.open('c1');
    const f = h.frames('c1');
    expect(f[0].type).toBe('event');
    expect(f[0].event).toBe('connect.challenge');
    expect(f[0].payload.authModes).toEqual(['capability-token']);
  });

  it('rejects a method request before connect', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', { type: 'req', id: randomUUID(), method: 'health' });
    const last = h.last('c1');
    expect(last.ok).toBe(false);
    expect(last.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an invalid capability token and closes', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame('bogus-token'));
    const last = h.last('c1');
    expect(last.ok).toBe(false);
    expect(last.error.code).toBe('UNAUTHORIZED');
    expect(h.sockets.get('c1')!.close).toHaveBeenCalled();
  });

  it('completes the handshake with a valid token and assigns a session', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token));
    const last = h.last('c1');
    expect(last.ok).toBe(true);
    expect(last.payload.type).toBe('hello-ok');
    expect(last.payload.sessionKey).toBe('sess_1');
    // Narrow default scopes: no credential/config write.
    expect(last.payload.auth.scopes).not.toContain('credentials.write');
    expect(last.payload.auth.scopes).not.toContain('config.write');
    expect(last.payload.auth.scopes).toContain('chat');
  });

  it('gives each connection its own session (isolation)', async () => {
    const h = await makeHarness();
    h.open('a');
    h.open('b');
    await h.send('a', connectFrame(h.token));
    await h.send('b', connectFrame(h.token));
    expect(h.last('a').payload.sessionKey).toBe('sess_1');
    expect(h.last('b').payload.sessionKey).toBe('sess_2');
  });

  it('dispatches an authorized method and returns its result', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token));
    const reqId = randomUUID();
    await h.send('c1', { type: 'req', id: reqId, method: 'health' });
    const res = h.frames('c1').find((f) => f.id === reqId);
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe('ok');
  });

  it('rejects a duplicate request id while the first is in flight', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token));
    const id = randomUUID();
    blockHealthList = deferred();
    try {
      // First in-flight (blocked) request occupies the id.
      void h.send('c1', { type: 'req', id, method: 'sessions.list' });
      // Second with the same id while the first is still running.
      await h.send('c1', { type: 'req', id, method: 'sessions.list' });
      const dup = h.frames('c1').filter((f) => f.id === id && f.ok === false);
      expect(dup.some((f) => f.error.message === 'Duplicate request')).toBe(true);
    } finally {
      blockHealthList.resolve();
      blockHealthList = null;
    }
  });

  it('returns OVERLOADED when the scheduler is saturated', async () => {
    const h = await makeHarness({ capacity: 1 });
    h.open('c1');
    await h.send('c1', connectFrame(h.token));
    blockHealthList = deferred();
    try {
      await h.send('c1', { type: 'req', id: randomUUID(), method: 'sessions.list' }); // occupies capacity
      const overflowId = randomUUID();
      await h.send('c1', { type: 'req', id: overflowId, method: 'sessions.list' });
      const res = h.frames('c1').find((f) => f.id === overflowId);
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe('OVERLOADED');
    } finally {
      blockHealthList.resolve();
      blockHealthList = null;
    }
  });

  it('drops connection state on close', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token));
    h.processor.onClose('c1');
    // A subsequent message for the closed connection is a no-op (no throw).
    await expect(h.send('c1', { type: 'req', id: randomUUID(), method: 'health' })).resolves.toBeUndefined();
  });
});
