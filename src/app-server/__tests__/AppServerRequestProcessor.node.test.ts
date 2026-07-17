/**
 * Node-mode (browser bridge) behavior of the request processor:
 * handshake, scope isolation, and node.* method routing to the NodeBridge.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppServerRequestProcessor } from '../AppServerRequestProcessor';
import { AppServerConnectionRegistry } from '../AppServerConnectionRegistry';
import { AppServerAuth, InMemoryTokenStore } from '../connection/AppServerAuth';
import { RequestQueue } from '../queue/RequestQueue';
import { AppServerRateLimiter } from '../connection/rateLimiter';
import { ConnectionWatchdog } from '../connection/ConnectionWatchdog';
import { AppServerStatusController } from '../status/AppServerStatus';
import { NodeBridge } from '../node-bridge/NodeBridge';

interface Harness {
  processor: AppServerRequestProcessor;
  token: string;
  bridge: NodeBridge;
  sessionsCreated: number[];
  open: (id: string) => void;
  send: (id: string, frame: unknown) => Promise<void>;
  frames: (id: string) => any[];
  responseFor: (id: string, reqId: string) => any;
}

async function makeHarness(): Promise<Harness> {
  const registry = new AppServerConnectionRegistry();
  const store = new InMemoryTokenStore();
  const auth = new AppServerAuth({ requireAuth: true, store });
  const token = await auth.ensureToken();
  const bridge = new NodeBridge();
  const sessionsCreated: number[] = [];
  let sessionCounter = 0;

  const sockets = new Map<string, { sent: string[] }>();
  const processor = new AppServerRequestProcessor({
    channelId: 'desktop-app-server',
    channelType: 'websocket',
    registry,
    auth,
    queue: new RequestQueue({ capacity: 128 }),
    rateLimiter: new AppServerRateLimiter({ windowMs: 1000, max: 1000 }),
    watchdog: new ConnectionWatchdog({ handshakeTimeoutMs: 10_000 }),
    status: new AppServerStatusController(),
    sessionFactory: async () => {
      sessionsCreated.push(++sessionCounter);
      return `sess_${sessionCounter}`;
    },
    nodeBridge: bridge,
  });

  return {
    processor,
    token,
    bridge,
    sessionsCreated,
    open: (id: string) => {
      const sent: string[] = [];
      sockets.set(id, { sent });
      processor.onOpen(id, { send: (d) => sent.push(d), close: vi.fn(), bufferedAmount: () => 0 });
    },
    send: (id, frame) => processor.onMessage(id, JSON.stringify(frame)),
    frames: (id) => sockets.get(id)!.sent.map((s) => JSON.parse(s)),
    responseFor: (id, reqId) =>
      sockets
        .get(id)!
        .sent.map((s) => JSON.parse(s))
        .find((f) => f.type === 'res' && f.id === reqId),
  };
}

function connectFrame(token: string, mode: 'node' | 'operator') {
  return {
    type: 'req',
    id: randomUUID(),
    method: 'connect',
    params: {
      client: {
        id: mode === 'node' ? 'workx-extension' : 'cli',
        displayName: '',
        version: '1.0.0',
        platform: 'test',
        mode,
      },
      auth: { token },
    },
  };
}

const ADVERTISE_PARAMS = {
  node: { kind: 'browser-extension', displayName: 'WorkX', version: '1.0.0' },
  tools: [{ name: 'dom_tool', description: 'DOM ops' }],
};

describe('AppServerRequestProcessor node mode', () => {
  it('accepts a node connect without creating an agent session and grants only node scopes', async () => {
    const h = await makeHarness();
    h.open('c1');
    const connect = connectFrame(h.token, 'node');
    await h.send('c1', connect);

    const res = h.responseFor('c1', connect.id);
    expect(res.ok).toBe(true);
    expect(res.payload.sessionKey).toBeUndefined();
    expect(res.payload.auth.scopes).toEqual(['node.invoke', 'node.event']);
    expect(h.sessionsCreated).toHaveLength(0);
  });

  it('routes node.advertise to the bridge and activates the node', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token, 'node'));

    const adv = { type: 'req', id: randomUUID(), method: 'node.advertise', params: ADVERTISE_PARAMS };
    await h.send('c1', adv);

    expect(h.responseFor('c1', adv.id).ok).toBe(true);
    expect(h.bridge.getPrimaryNode()?.tools.map((t) => t.name)).toEqual(['dom_tool']);
  });

  it('completes an invoke round-trip through the wire frames', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token, 'node'));
    await h.send('c1', { type: 'req', id: randomUUID(), method: 'node.advertise', params: ADVERTISE_PARAMS });

    const node = h.bridge.getPrimaryNode()!;
    const pending = h.bridge.invoke(node.connectionId, 'dom_tool', { action: 'snapshot' });

    // The invoke event must have been sent to the node connection.
    const invokeEvent = h.frames('c1').find((f) => f.type === 'event' && f.event === 'node.invoke');
    expect(invokeEvent).toBeDefined();

    const resultReq = {
      type: 'req',
      id: randomUUID(),
      method: 'node.result',
      params: { invokeId: invokeEvent.payload.invokeId, ok: true, result: { done: true } },
    };
    await h.send('c1', resultReq);
    expect(h.responseFor('c1', resultReq.id).ok).toBe(true);
    await expect(pending).resolves.toEqual({ done: true });
  });

  it('denies node.* methods to operator connections (missing scope)', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token, 'operator'));

    const adv = { type: 'req', id: randomUUID(), method: 'node.advertise', params: ADVERTISE_PARAMS };
    await h.send('c1', adv);
    const res = h.responseFor('c1', adv.id);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('UNAUTHORIZED');
  });

  it('drops the node from the bridge on disconnect', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token, 'node'));
    await h.send('c1', { type: 'req', id: randomUUID(), method: 'node.advertise', params: ADVERTISE_PARAMS });
    expect(h.bridge.getActiveNodes()).toHaveLength(1);

    h.processor.onClose('c1');
    expect(h.bridge.getActiveNodes()).toHaveLength(0);
  });

  it('answers node.heartbeat', async () => {
    const h = await makeHarness();
    h.open('c1');
    await h.send('c1', connectFrame(h.token, 'node'));
    const hb = { type: 'req', id: randomUUID(), method: 'node.heartbeat', params: {} };
    await h.send('c1', hb);
    expect(h.responseFor('c1', hb.id).ok).toBe(true);
  });
});
