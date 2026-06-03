import { describe, it, expect, vi } from 'vitest';
import { ConnectionRpcGate } from '../connection/ConnectionRpcGate';
import { resolveSerialization, serializationKeyString } from '../queue/requestSerialization';
import { AppServerRateLimiter } from '../connection/rateLimiter';
import { handleHealthRequest, buildHealthBody } from '../transport/httpHealth';
import { AppServerConnectionRegistry } from '../AppServerConnectionRegistry';
import { ConnectionWatchdog } from '../connection/ConnectionWatchdog';
import { AppServerStatusController } from '../status/AppServerStatus';
import {
  isScopeEligible,
  isSessionEligible,
  extractRunId,
  eventMsgToName,
} from '../AppServerChannel';
import type { EventMsg } from '@/core/protocol/events';
import type { AppServerStatusSnapshot } from '../status/AppServerStatus';

describe('ConnectionRpcGate', () => {
  it('allows entry until closed', () => {
    const g = new ConnectionRpcGate();
    expect(g.tryEnter()).toBe(true);
    expect(g.activeRequests).toBe(1);
    g.release();
    expect(g.activeRequests).toBe(0);
    g.close();
    expect(g.tryEnter()).toBe(false);
    expect(g.isClosed).toBe(true);
  });
});

describe('requestSerialization', () => {
  it('maps writes and reads to keys/modes', () => {
    expect(resolveSerialization('health', { connectionId: 'c' })).toEqual({ key: 'none', mode: 'read' });
    expect(resolveSerialization('config.set', { connectionId: 'c' }).mode).toBe('write');
    expect(resolveSerialization('config.get', { connectionId: 'c' }).mode).toBe('read');
    expect(resolveSerialization('credentials.set', { connectionId: 'c' }).key).toBe('global:credentials');
    expect(resolveSerialization('chat.send', { connectionId: 'c', sessionKey: 's1' })).toEqual({
      key: 'session:s1',
      mode: 'write',
    });
    expect(resolveSerialization('logs.tail', { connectionId: 'c9' }).key).toBe('conn:c9');
  });

  it('stringifies the connection-local key kind', () => {
    expect(serializationKeyString({ kind: 'connection-local', connectionId: 'x' })).toBe('conn:x');
  });
});

describe('AppServerRateLimiter', () => {
  it('limits requests within a window', () => {
    const rl = new AppServerRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.check('c', 0)).toBeNull();
    expect(rl.check('c', 1)).toBeNull();
    const err = rl.check('c', 2);
    expect(err?.code).toBe('RATE_LIMITED');
  });

  it('resets after the window passes', () => {
    const rl = new AppServerRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.check('c', 0)).toBeNull();
    expect(rl.check('c', 500)?.code).toBe('RATE_LIMITED');
    expect(rl.check('c', 1500)).toBeNull();
  });
});

describe('httpHealth', () => {
  const status: AppServerStatusSnapshot = { enabled: true, status: 'ready', connections: 2 };
  const ctx = { status, profile: 'desktop-runtime', startedAtMs: 0, now: 1000 };

  it('returns 200 for /readyz when ready', () => {
    expect(handleHealthRequest('GET', '/readyz', ctx)?.statusCode).toBe(200);
  });

  it('returns 503 for /readyz when not ready', () => {
    const r = handleHealthRequest('GET', '/readyz', { ...ctx, status: { ...status, status: 'starting' } });
    expect(r?.statusCode).toBe(503);
  });

  it('serves /healthz and /health JSON', () => {
    const hz = handleHealthRequest('GET', '/healthz', ctx);
    expect(hz?.statusCode).toBe(200);
    expect(JSON.parse(hz!.body).connections).toBe(2);
    expect(handleHealthRequest('GET', '/health', ctx)?.statusCode).toBe(200);
  });

  it('ignores non-health paths and non-GET', () => {
    expect(handleHealthRequest('GET', '/other', ctx)).toBeNull();
    expect(handleHealthRequest('POST', '/healthz', ctx)).toBeNull();
  });

  it('never leaks secrets in the health body', () => {
    const body = buildHealthBody(ctx);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
});

describe('AppServerConnectionRegistry', () => {
  const socket = { send: () => {}, close: () => {}, bufferedAmount: () => 0 };

  it('adds, gets, counts, and removes connections', () => {
    const reg = new AppServerConnectionRegistry();
    reg.add({ connectionId: 'c1', socket, isLoopback: true, now: 1 });
    expect(reg.count()).toBe(1);
    expect(reg.get('c1')?.connectionId).toBe('c1');
    const removed = reg.remove('c1');
    expect(removed?.gate.isClosed).toBe(true);
    expect(reg.count()).toBe(0);
  });
});

describe('ConnectionWatchdog', () => {
  it('fires the handshake timeout when not cleared', () => {
    vi.useFakeTimers();
    const wd = new ConnectionWatchdog({ handshakeTimeoutMs: 100 });
    const onTimeout = vi.fn();
    wd.armHandshakeTimeout('c', onTimeout);
    vi.advanceTimersByTime(150);
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not fire when cleared in time', () => {
    vi.useFakeTimers();
    const wd = new ConnectionWatchdog({ handshakeTimeoutMs: 100 });
    const onTimeout = vi.fn();
    wd.armHandshakeTimeout('c', onTimeout);
    wd.clearHandshakeTimeout('c');
    vi.advanceTimersByTime(150);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('AppServerStatusController', () => {
  it('merges updates and notifies listeners', () => {
    const ctrl = new AppServerStatusController();
    const seen: string[] = [];
    ctrl.onChange((s) => seen.push(s.status));
    ctrl.set({ status: 'starting' });
    ctrl.set({ status: 'ready', url: 'ws://127.0.0.1:1' });
    expect(ctrl.getSnapshot().status).toBe('ready');
    expect(ctrl.getSnapshot().url).toBe('ws://127.0.0.1:1');
    expect(seen).toEqual(['starting', 'ready']);
  });

  it('only emits on connection change', () => {
    const ctrl = new AppServerStatusController();
    const cb = vi.fn();
    ctrl.onChange(cb);
    ctrl.setConnections(0); // no change from default 0
    expect(cb).not.toHaveBeenCalled();
    ctrl.setConnections(1);
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe('AppServerChannel filtering helpers', () => {
  it('isScopeEligible respects EVENT_SCOPE_MAP and broadcasts', () => {
    expect(isScopeEligible('tick', [])).toBe(true); // broadcast
    expect(isScopeEligible('chat', ['chat'])).toBe(true);
    expect(isScopeEligible('chat', ['sessions.read'])).toBe(false);
    expect(isScopeEligible('unknown.event', [])).toBe(true); // unscoped
  });

  it('isSessionEligible matches owner session or subscriptions', () => {
    const conn = { sessionKey: 's1', subscriptions: new Set(['s2']) };
    expect(isSessionEligible(undefined, conn)).toBe(true); // global event
    expect(isSessionEligible('s1', conn)).toBe(true);
    expect(isSessionEligible('s2', conn)).toBe(true);
    expect(isSessionEligible('s3', conn)).toBe(false);
  });

  it('extractRunId pulls submission_id/turn_id from event data', () => {
    expect(extractRunId({ type: 'TaskStarted', data: { submission_id: 'sub_1' } } as unknown as EventMsg)).toBe('sub_1');
    expect(extractRunId({ type: 'TurnStarted', data: { turn_id: 't9' } } as unknown as EventMsg)).toBe('t9');
    expect(extractRunId({ type: 'AgentMessage', data: {} } as unknown as EventMsg)).toBeUndefined();
  });

  it('eventMsgToName maps event types to wire names', () => {
    expect(eventMsgToName({ type: 'AgentMessageDelta' } as unknown as EventMsg)).toBe('chat');
    expect(eventMsgToName({ type: 'TaskStarted' } as unknown as EventMsg)).toBe('agent');
    expect(eventMsgToName({ type: 'ExecApprovalRequest' } as unknown as EventMsg)).toBe('exec.approval.requested');
    expect(eventMsgToName({ type: 'Error' } as unknown as EventMsg)).toBe('health');
  });
});
