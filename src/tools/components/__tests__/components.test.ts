import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '@/core/approval/ApprovalGate';
import { PolicyRulesEngine } from '@/core/approval/PolicyRulesEngine';
import type { ComponentManager, ComponentView } from '@/core/components';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { ComponentInstallRiskAssessor } from '../ComponentInstallRiskAssessor';
import { registerComponentTools } from '../register';

const installed: ComponentView = {
  id: 'duckdb',
  displayName: 'DuckDB',
  description: 'Local analytics',
  version: '1.5.4',
  platform: 'linux-x64',
  capabilities: ['local-sql'],
  state: 'installed',
  license: { name: 'MIT', url: 'https://example.test/license' },
  homepage: 'https://duckdb.org',
};

function manager(): ComponentManager {
  return {
    initialize: vi.fn(),
    status: vi.fn(),
    list: vi.fn(async () => [installed]),
    get: vi.fn(async () => installed),
    install: vi.fn(async () => installed),
    verify: vi.fn(async () => installed),
    uninstall: vi.fn(),
    resolveEntrypoint: vi.fn(),
    acquireEntrypoint: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ComponentManager;
}

const localSnapshot = {
  origin: {
    channel: 'local' as const,
    channelId: 'desktop-runtime-main',
    channelType: 'tauri' as const,
  },
  attended: true,
  durableLearningEligible: true,
  currentUserText: 'install DuckDB',
};

describe('managed component agent tools', () => {
  it('marks install as explicit consent and hard-denies remote origins', () => {
    const assessor = new ComponentInstallRiskAssessor();
    expect(
      assessor.assess(
        'component_install',
        { component_id: 'duckdb' },
        {
          toolName: 'component_install',
          parameters: {},
          dataTurnSnapshot: localSnapshot,
        }
      )
    ).toMatchObject({ action: 'ask_user', requiresExplicitUserApproval: true });
    expect(
      assessor.assess(
        'component_install',
        { component_id: 'duckdb' },
        {
          toolName: 'component_install',
          parameters: {},
        }
      )
    ).toMatchObject({ action: 'deny', hardDeny: true });
  });

  it('propagates the trusted desktop turn snapshot and waits for approval before installing', async () => {
    const runtime = manager();
    const registry = new ToolRegistry();
    const approvalManager = {
      requestApproval: vi.fn(async () => ({ decision: 'approve' as const, id: 'approval' })),
    };
    const gate = new ApprovalGate(approvalManager as never, new PolicyRulesEngine([]));
    gate.setMode('yolo');
    registry.setApprovalGate(gate);
    await registerComponentTools(registry, runtime);

    const listResult = await registry.execute({
      toolName: 'component_list',
      parameters: {},
      sessionId: 'session-1',
      turnId: 'turn-1',
      metadata: { dataTurnSnapshot: localSnapshot },
    });
    expect(listResult.success).toBe(true);

    const installResult = await registry.execute({
      toolName: 'component_install',
      parameters: { component_id: 'duckdb', reason: 'Combine two data sources' },
      sessionId: 'session-1',
      turnId: 'turn-1',
      metadata: { dataTurnSnapshot: localSnapshot },
    });
    expect(installResult.success).toBe(true);
    expect(approvalManager.requestApproval).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenCalledWith(
      'duckdb',
      expect.objectContaining({ signal: undefined, onProgress: expect.any(Function) })
    );
  });

  it('denies a remote install before displaying an approval prompt', async () => {
    const runtime = manager();
    const registry = new ToolRegistry();
    const approvalManager = {
      requestApproval: vi.fn(async () => ({ decision: 'approve' as const, id: 'approval' })),
    };
    const gate = new ApprovalGate(approvalManager as never, new PolicyRulesEngine([]));
    gate.setMode('yolo');
    registry.setApprovalGate(gate);
    await registerComponentTools(registry, runtime);

    const result = await registry.execute({
      toolName: 'component_install',
      parameters: { component_id: 'duckdb', reason: 'remote request' },
      sessionId: 'remote-session',
      turnId: 'remote-turn',
      metadata: {
        dataTurnSnapshot: {
          ...localSnapshot,
          origin: { channel: 'remote', channelId: 'app-server', channelType: 'websocket' },
        },
      },
    });
    expect(result).toMatchObject({ success: false, error: { code: 'APPROVAL_DENIED' } });
    expect(approvalManager.requestApproval).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });
});
