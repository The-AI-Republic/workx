import { describe, it, expect } from 'vitest';
import { AppServerChannel } from '../AppServerChannel';
import { AppServerConnectionRegistry } from '../AppServerConnectionRegistry';
import type { EventMsg } from '@/core/protocol/events';

function fakeSocket() {
  const sent: string[] = [];
  return {
    sent,
    socket: { send: (d: string) => sent.push(d), close: () => {}, bufferedAmount: () => 0 },
  };
}

function addAuthedConn(
  reg: AppServerConnectionRegistry,
  id: string,
  sessionKey: string,
  scopes: string[],
) {
  const f = fakeSocket();
  const conn = reg.add({ connectionId: id, socket: f.socket, now: 0 });
  conn.authenticated = true;
  conn.sessionKey = sessionKey;
  conn.subscriptions.add(sessionKey);
  conn.scopes = scopes;
  return f;
}

describe('AppServerChannel.sendEvent', () => {
  it('delivers a session event only to the owning connection (multi-client isolation)', async () => {
    const reg = new AppServerConnectionRegistry();
    const a = addAuthedConn(reg, 'connA', 'sessA', ['chat']);
    const b = addAuthedConn(reg, 'connB', 'sessB', ['chat']);
    const channel = new AppServerChannel(reg);

    await channel.sendEvent({
      msg: { type: 'AgentMessageDelta', data: { delta: 'hi' } } as unknown as EventMsg,
      sessionId: 'sessA',
    });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
    const frame = JSON.parse(a.sent[0]);
    expect(frame.type).toBe('event');
    expect(frame.event).toBe('chat');
    expect(frame.payload.sessionId).toBe('sessA');
  });

  it('does not deliver scoped events to connections lacking the scope', async () => {
    const reg = new AppServerConnectionRegistry();
    const a = addAuthedConn(reg, 'connA', 'sessA', ['sessions.read']); // no 'chat'
    const channel = new AppServerChannel(reg);
    await channel.sendEvent({
      msg: { type: 'AgentMessageDelta', data: {} } as unknown as EventMsg,
      sessionId: 'sessA',
    });
    expect(a.sent).toHaveLength(0);
  });

  it('skips unauthenticated connections', async () => {
    const reg = new AppServerConnectionRegistry();
    const f = fakeSocket();
    reg.add({ connectionId: 'c', socket: f.socket, now: 0 }); // not authenticated
    const channel = new AppServerChannel(reg);
    await channel.sendEvent({ msg: { type: 'AgentMessageDelta', data: {} } as unknown as EventMsg, sessionId: 'x' });
    expect(f.sent).toHaveLength(0);
  });

  it('includes runId derived from the event payload', async () => {
    const reg = new AppServerConnectionRegistry();
    const a = addAuthedConn(reg, 'connA', 'sessA', ['chat', 'admin']);
    const channel = new AppServerChannel(reg);
    await channel.sendEvent({
      msg: { type: 'TaskStarted', data: { submission_id: 'sub_42' } } as unknown as EventMsg,
      sessionId: 'sessA',
    });
    const frame = JSON.parse(a.sent[0]);
    expect(frame.payload.runId).toBe('sub_42');
    expect(frame.seq).toBe(1);
  });

  it('reports websocket channel type and default id', () => {
    const channel = new AppServerChannel(new AppServerConnectionRegistry());
    expect(channel.channelType).toBe('websocket');
    expect(channel.channelId).toBe('desktop-app-server');
  });
});
