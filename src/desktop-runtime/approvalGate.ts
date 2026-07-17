/**
 * Desktop-runtime approval gate wiring.
 *
 * Mirrors the extension wiring (service-worker configureExtensionPlatform /
 * AgentRegistry extension branch): a risk-scored ApprovalGate over
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

/**
 * Construct the desktop approval gate for a freshly initialized agent and
 * attach it to the agent's ToolRegistry. Persisted config (mode, trusted and
 * blocked domains) is loaded from the runtime's config storage.
 */
export async function configureDesktopApprovalGate(agent: RepublicAgent): Promise<ApprovalGate> {
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
    approvalGate.setMode(stored.mode);
    approvalGate.setTrustedDomains(stored.trustedDomains || []);
    approvalGate.setBlockedDomains(stored.blockedDomains || []);
  } catch (error) {
    console.warn('[DesktopRuntime] Failed to load approval config, using defaults:', error);
  }

  agent.getToolRegistry().setApprovalGate(approvalGate);
  return approvalGate;
}
