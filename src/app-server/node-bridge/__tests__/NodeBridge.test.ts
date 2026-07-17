import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeBridge, NodeInvokeFailure } from '../NodeBridge';

function makeNode(bridge: NodeBridge, connectionId = 'conn_1') {
  const events: Array<{ event: string; payload: any }> = [];
  bridge.onNodeConnected({
    connectionId,
    clientId: 'workx-extension',
    sendEvent: (event, payload) => events.push({ event, payload: payload as any }),
  });
  return { events };
}

const CATALOG = {
  node: { kind: 'browser-extension', displayName: 'WorkX', version: '1.0.0' },
  tools: [
    { name: 'dom_tool', description: 'DOM ops', parameters: { type: 'object', properties: {} } },
    { name: 'browser_tabs', description: 'Tab ops' },
  ],
};

describe('NodeBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks nodes only as active once they advertise tools', () => {
    const bridge = new NodeBridge();
    makeNode(bridge);
    expect(bridge.getActiveNodes()).toHaveLength(0);
    expect(bridge.getPrimaryNode()).toBeNull();

    bridge.handleAdvertise('conn_1', CATALOG);
    expect(bridge.getActiveNodes()).toHaveLength(1);
    expect(bridge.getPrimaryNode()?.tools.map((t) => t.name)).toEqual(['dom_tool', 'browser_tabs']);
  });

  it('notifies listeners on advertise and disconnect', () => {
    const bridge = new NodeBridge();
    const seen: number[] = [];
    bridge.onNodesChanged((nodes) => seen.push(nodes.length));

    makeNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    bridge.onNodeDisconnected('conn_1');

    expect(seen).toEqual([1, 0]);
  });

  it('prefers the most recently connected advertised node', () => {
    const bridge = new NodeBridge();
    makeNode(bridge, 'conn_a');
    makeNode(bridge, 'conn_b');
    bridge.handleAdvertise('conn_a', CATALOG);
    bridge.handleAdvertise('conn_b', CATALOG);
    expect(bridge.getPrimaryNode()?.connectionId).toBe('conn_b');
  });

  it('correlates invoke → result', async () => {
    const bridge = new NodeBridge();
    const { events } = makeNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);

    const pending = bridge.invoke('conn_1', 'dom_tool', { action: 'snapshot' });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('node.invoke');
    expect(events[0].payload.toolName).toBe('dom_tool');

    bridge.handleResult('conn_1', {
      invokeId: events[0].payload.invokeId,
      ok: true,
      result: { nodes: 3 },
    });
    await expect(pending).resolves.toEqual({ nodes: 3 });
  });

  it('rejects the invoke when the node reports failure', async () => {
    const bridge = new NodeBridge();
    const { events } = makeNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);

    const pending = bridge.invoke('conn_1', 'dom_tool', {});
    bridge.handleResult('conn_1', {
      invokeId: events[0].payload.invokeId,
      ok: false,
      error: { code: 'TAB_LEASED', message: 'tab busy' },
    });
    await expect(pending).rejects.toMatchObject({
      error: { code: 'TAB_LEASED', message: 'tab busy' },
    });
  });

  it('times out an unanswered invoke', async () => {
    const bridge = new NodeBridge();
    makeNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);

    const pending = bridge.invoke('conn_1', 'dom_tool', {}, { timeoutMs: 10_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(NodeInvokeFailure);
    vi.advanceTimersByTime(10_001);
    await assertion;
  });

  it('fails in-flight invokes when the node disconnects', async () => {
    const bridge = new NodeBridge();
    makeNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);

    const pending = bridge.invoke('conn_1', 'dom_tool', {});
    const assertion = expect(pending).rejects.toMatchObject({ error: { code: 'DISCONNECTED' } });
    bridge.onNodeDisconnected('conn_1');
    await assertion;
  });

  it('ignores results for unknown or foreign invoke ids', () => {
    const bridge = new NodeBridge();
    makeNode(bridge, 'conn_a');
    makeNode(bridge, 'conn_b');
    bridge.handleAdvertise('conn_a', CATALOG);

    expect(bridge.handleResult('conn_a', { invokeId: 'nope', ok: true })).toEqual({ accepted: false });
    // Result arriving from a different connection than the invoke target is dropped.
    const p = bridge.invoke('conn_a', 'dom_tool', {});
    p.catch(() => undefined); // silence unhandled rejection on clear()
    expect(bridge.handleResult('conn_b', { invokeId: 'nope', ok: true })).toEqual({ accepted: false });
    bridge.clear();
  });

  it('rejects invokes to unconnected nodes', async () => {
    const bridge = new NodeBridge();
    await expect(bridge.invoke('ghost', 'dom_tool', {})).rejects.toMatchObject({
      error: { code: 'DISCONNECTED' },
    });
  });

  it('cleans up immediately when sending an invoke throws', async () => {
    const bridge = new NodeBridge();
    bridge.onNodeConnected({
      connectionId: 'conn_1',
      clientId: 'workx-extension',
      sendEvent: () => {
        throw new Error('socket closed during send');
      },
    });
    bridge.handleAdvertise('conn_1', CATALOG);

    await expect(bridge.invoke('conn_1', 'dom_tool', {})).rejects.toMatchObject({
      error: { code: 'SEND_ERROR', message: 'socket closed during send' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
