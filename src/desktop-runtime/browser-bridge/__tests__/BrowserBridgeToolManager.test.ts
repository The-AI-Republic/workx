import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { NodeBridge } from '@/app-server/node-bridge/NodeBridge';
import {
  BROWSER_CONTEXT_TIMEOUT_MS,
  BROWSER_RELEASE_TIMEOUT_MS,
  BrowserBridgeToolManager,
} from '../BrowserBridgeToolManager';

const CATALOG = {
  node: { kind: 'browser-extension', displayName: 'WorkX', version: '1.0.0' },
  tools: [
    {
      name: 'dom_tool',
      description: 'DOM ops',
      parameters: { type: 'object', properties: { action: { type: 'string' } } },
    },
    { name: 'browser_tabs', description: 'Tab ops', parameters: { type: 'object', properties: {} } },
  ],
};

function makeFakeAgentRegistry(sessions: Array<{ sessionId: string; registry: ToolRegistry }>) {
  return {
    listSessions: () => sessions.map((s) => ({ sessionId: s.sessionId, state: 'active' })),
    getSession: (id: string) => {
      const found = sessions.find((s) => s.sessionId === id);
      return found ? { agent: { getToolRegistry: () => found.registry } } : undefined;
    },
  } as any;
}

function connectNode(bridge: NodeBridge, connectionId = 'conn_1') {
  const events: Array<{ event: string; payload: any }> = [];
  bridge.onNodeConnected({
    connectionId,
    clientId: 'workx-extension',
    sendEvent: (event, payload) => events.push({ event, payload: payload as any }),
  });
  return events;
}

async function flush() {
  // The manager serializes syncs on a promise chain; yield until it settles.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('BrowserBridgeToolManager', () => {
  it('registers advertised tools on all live sessions and unregisters on disconnect', async () => {
    const bridge = new NodeBridge();
    const regA = new ToolRegistry();
    const regB = new ToolRegistry();
    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([
        { sessionId: 's1', registry: regA },
        { sessionId: 's2', registry: regB },
      ]),
    });
    manager.attach();

    connectNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    await flush();

    expect(regA.getTool('dom_tool')).toBeTruthy();
    expect(regA.getTool('browser_tabs')).toBeTruthy();
    expect(regB.getTool('dom_tool')).toBeTruthy();
    expect(manager.hasActiveNode()).toBe(true);

    bridge.onNodeDisconnected('conn_1');
    await flush();

    expect(regA.getTool('dom_tool')).toBeNull();
    expect(regB.getTool('browser_tabs')).toBeNull();
    expect(manager.hasActiveNode()).toBe(false);
  });

  it('never clobbers a natively registered tool of the same name', async () => {
    const bridge = new NodeBridge();
    const reg = new ToolRegistry();
    const nativeHandler = vi.fn(async () => 'native');
    await reg.register(
      {
        type: 'function',
        function: { name: 'dom_tool', description: 'native', strict: false, parameters: { type: 'object', properties: {} } },
      } as any,
      nativeHandler,
    );

    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([{ sessionId: 's1', registry: reg }]),
    });
    manager.attach();

    connectNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    await flush();

    // Native survives; bridge-only tool is added; disconnect leaves native alone.
    expect(reg.getTool('browser_tabs')).toBeTruthy();
    bridge.onNodeDisconnected('conn_1');
    await flush();
    expect(reg.getTool('dom_tool')).toBeTruthy();
    expect(reg.getTool('browser_tabs')).toBeNull();
  });

  it('proxies tool calls over the bridge and maps failures to readable errors', async () => {
    const bridge = new NodeBridge();
    const reg = new ToolRegistry();
    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([{ sessionId: 's1', registry: reg }]),
    });
    manager.attach();

    const events = connectNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    await flush();

    // Successful round-trip.
    const exec = reg.execute({
      toolName: 'dom_tool',
      parameters: { action: 'snapshot' },
      sessionId: 'sess',
      turnId: 'turn',
    });
    await flush();
    const invoke = events.find((e) => e.event === 'node.invoke');
    expect(invoke).toBeDefined();
    bridge.handleResult('conn_1', { invokeId: invoke!.payload.invokeId, ok: true, result: { nodes: 1 } });
    const response = await exec;
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ nodes: 1 });

    // Node failure surfaces as a readable tool error.
    const exec2 = reg.execute({
      toolName: 'dom_tool',
      parameters: { action: 'click' },
      sessionId: 'sess',
      turnId: 'turn',
    });
    await flush();
    const invoke2 = events.filter((e) => e.event === 'node.invoke')[1];
    bridge.handleResult('conn_1', {
      invokeId: invoke2.payload.invokeId,
      ok: false,
      error: { code: 'TAB_LEASED', message: 'tab 7 is leased to session x' },
    });
    const response2 = await exec2;
    expect(response2.success).toBe(false);
    expect(response2.error?.message).toContain('tab 7 is leased');
  });

  it('applyToRegistry is a no-op when no node is connected', async () => {
    const bridge = new NodeBridge();
    const reg = new ToolRegistry();
    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([]),
    });
    await manager.applyToRegistry('s1', reg);
    expect(reg.listTools()).toHaveLength(0);
  });

  it('uses short operation-specific budgets for context and cleanup RPCs', async () => {
    const bridge = new NodeBridge();
    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([]),
    });
    connectNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    const invoke = vi.spyOn(bridge, 'invoke')
      .mockResolvedValueOnce({ tabId: 3, url: 'https://example.com', hostname: 'example.com' })
      .mockResolvedValueOnce({ released: true });

    await expect(manager.getSessionBrowserContext('s1')).resolves.toMatchObject({ tabId: 3 });
    await expect(manager.releaseSession('s1')).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'conn_1',
      '',
      {},
      expect.objectContaining({
        operation: 'browser-context',
        sessionId: 's1',
        timeoutMs: BROWSER_CONTEXT_TIMEOUT_MS,
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'conn_1',
      '',
      {},
      expect.objectContaining({
        operation: 'release-session',
        sessionId: 's1',
        timeoutMs: BROWSER_RELEASE_TIMEOUT_MS,
      }),
    );
  });

  it('unregisters proxy tools when detached so app-server restart cannot leave stale handlers', async () => {
    const bridge = new NodeBridge();
    const reg = new ToolRegistry();
    const manager = new BrowserBridgeToolManager({
      nodeBridge: bridge,
      getRegistry: () => makeFakeAgentRegistry([{ sessionId: 's1', registry: reg }]),
    });
    manager.attach();

    connectNode(bridge);
    bridge.handleAdvertise('conn_1', CATALOG);
    await flush();
    expect(reg.getTool('dom_tool')).toBeTruthy();

    await manager.detach();

    expect(reg.getTool('dom_tool')).toBeNull();
    expect(reg.getTool('browser_tabs')).toBeNull();
  });
});
