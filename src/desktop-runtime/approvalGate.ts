/**
 * Desktop-runtime approval gate wiring.
 *
 * Mirrors the extension wiring (service-worker configureExtensionPlatform /
 * SessionManager extension branch): a risk-scored ApprovalGate over
 * ToolRegistry.execute, using the desktop rule set and desktop-relevant
 * enhancers. The desktop webview already renders ApprovalRequested events
 * through the shared EventProcessor and returns ExecApproval ops over the
 * stdio channel — constructing the gate is what starts that round-trip.
 *
 * SemanticElementEnhancer is deliberately omitted: it is extension-only
 * (operates on DOM element labels from the in-browser snapshot pipeline).
 */

import { ApprovalGate } from '@/core/approval/ApprovalGate';
import { PolicyRulesEngine } from '@/core/approval/PolicyRulesEngine';
import { getDefaultRules } from '@/core/approval/defaultRules';
import { SensitivePathEnhancer } from '@/core/approval/enhancers/SensitivePathEnhancer';
import { DomainSensitivityEnhancer } from '@/core/approval/enhancers/DomainSensitivityEnhancer';
import { ApprovalConfigStorage } from '@/core/approval/ApprovalConfigStorage';
import { getConfigStorage } from '@/core/storage/ConfigStorageProvider';
import type { RepublicAgent } from '@/core/RepublicAgent';
import type { ApprovalMode, IApprovalConfig } from '@/core/approval/types';

const APPROVAL_MODES = new Set<ApprovalMode>(['balanced', 'high_speed', 'yolo']);

/** Apply a validated effective config to a live desktop approval gate. */
export function applyDesktopApprovalConfig(
  approvalGate: ApprovalGate,
  config: Partial<IApprovalConfig> | null | undefined,
): void {
  if (config?.mode && APPROVAL_MODES.has(config.mode)) {
    approvalGate.setMode(config.mode);
  }
  approvalGate.setTrustedDomains(
    Array.isArray(config?.trustedDomains)
      ? config.trustedDomains.filter((domain): domain is string => typeof domain === 'string')
      : [],
  );
  approvalGate.setBlockedDomains(
    Array.isArray(config?.blockedDomains)
      ? config.blockedDomains.filter((domain): domain is string => typeof domain === 'string')
      : [],
  );
}

/**
 * Construct the desktop approval gate for a freshly initialized agent and
 * attach it to the agent's ToolRegistry. Persisted config (mode, trusted and
 * blocked domains) is loaded from the runtime's config storage.
 */
export async function configureDesktopApprovalGate(
  agent: RepublicAgent,
  effectiveConfig?: Partial<IApprovalConfig>,
): Promise<ApprovalGate> {
  const approvalGate = new ApprovalGate(
    agent.getApprovalManager(),
    new PolicyRulesEngine(getDefaultRules('desktop')),
  );
  approvalGate.addEnhancer(new SensitivePathEnhancer());
  approvalGate.addEnhancer(new DomainSensitivityEnhancer());
  approvalGate.setHookDispatcher(agent.getHookDispatcher());

  const approvalConfigStorage = new ApprovalConfigStorage(() => getConfigStorage());
  approvalGate.setConfigStorage(approvalConfigStorage);
  try {
    const stored = await approvalConfigStorage.loadConfig();
    // The AgentConfig value has managed policy overlaid and must win over raw
    // persisted preferences. This prevents an old local yolo/trusted-domain
    // value from defeating a newly-applied organization policy.
    applyDesktopApprovalConfig(approvalGate, effectiveConfig ?? stored);
  } catch (error) {
    console.warn('[DesktopRuntime] Failed to load approval config, using defaults:', error);
  }

  agent.getToolRegistry().setApprovalGate(approvalGate);
  return approvalGate;
}
