// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get as httpGet } from 'node:http';
import { WebSocket } from 'ws';
import { registerMethodHandler } from '@workx/ws-server';
import { AppServerManager } from '../AppServerManager';
import { AppServerAuth, InMemoryTokenStore } from '../connection/AppServerAuth';

let manager: AppServerManager;
let auth: AppServerAuth;
let token: string;
let port: number;

beforeAll(async () => {
  registerMethodHandler('health', async () => ({ status: 'ok' }));

  auth = new AppServerAuth({ requireAuth: true, store: new InMemoryTokenStore() });
  let n = 0;
  manager = new AppServerManager({
    config: { enabled: true, bindHost: '127.0.0.1', port: 0 },
    auth,
    sessionFactory: async () => `sess_${++n}`,
    profile: 'test',
  });
  await manager.start();
  token = (await auth.revealToken())!;
  port = manager.getStatus().port!;
});

afterAll(async () => {
  await manager.stop('test');
});

function httpStatus(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/** Connect, perform the handshake, return the hello-ok payload + socket. */
function connect(opts: { token?: string; origin?: string } = {}): Promise<{ ws: WebSocket; hello: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts.origin ? { origin: opts.origin } : undefined);
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 4000);

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        ws.send(
          JSON.stringify({
            type: 'req',
            id: crypto.randomUUID(),
            method: 'connect',
            params: {
              protocolVersion: 1,
              clientId: 'itest',
              clientMode: 'operator',
              auth: opts.token ? { token: opts.token } : undefined,
            },
          }),
        );
        return;
      }
      if (frame.type === 'res') {
        clearTimeout(timer);
        if (frame.ok) resolve({ ws, hello: frame.payload });
        else {
          ws.close();
          reject(new Error(frame.error?.code ?? 'connect failed'));
        }
      }
    });
  });
}

describe('AppServerWebSocketTransport (integration)', () => {
  it('serves /readyz with 200 when ready', async () => {
    const r = await httpStatus('/readyz');
    expect(r.status).toBe(200);
  });

  it('serves /healthz JSON with connection count and no secrets', async () => {
    const r = await httpStatus('/healthz');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.status).toBe('ready');
    expect(typeof body.connections).toBe('number');
    expect(r.body).not.toMatch(/token/i);
  });

  it('keeps the /health compatibility alias', async () => {
    const r = await httpStatus('/health');
    expect(r.status).toBe(200);
  });

  it('rejects a WebSocket upgrade carrying an Origin header', async () => {
    await expect(connect({ token, origin: 'http://evil.example' })).rejects.toThrow(/403|unexpected-response/);
  });

  it('rejects an invalid capability token', async () => {
    await expect(connect({ token: 'wrong-token' })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('completes the handshake with a valid token and runs a method', async () => {
    const { ws, hello } = await connect({ token });
    expect(hello.type).toBe('hello-ok');
    expect(hello.sessionKey).toMatch(/^sess_/);

    const reqId = crypto.randomUUID();
    const result = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const f = JSON.parse(data.toString());
        if (f.type === 'res' && f.id === reqId) resolve(f);
      });
      ws.send(JSON.stringify({ type: 'req', id: reqId, method: 'health' }));
    });
    expect(result.ok).toBe(true);
    expect(result.payload.status).toBe('ok');
    ws.close();
  });
});
