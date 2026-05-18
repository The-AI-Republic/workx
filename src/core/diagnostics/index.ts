/**
 * Operational Diagnostics (Track 17) — public barrel.
 *
 * @module core/diagnostics
 */

import { registerDiagnosticCheck } from './DiagnosticRegistry';
import { configValidCheck } from './checks/config-valid';
import { credentialsPresentCheck } from './checks/credentials-present';
import { channelsReachableCheck } from './checks/channels-reachable';
import { mcpConnectedCheck } from './checks/mcp-connected';
import { skillsLoadedCheck } from './checks/skills-loaded';
import { schedulerHealthCheck } from './checks/scheduler-health';
import { policyOriginCheck } from './checks/policy-origin';
import { shortcutsValidCheck } from './checks/shortcuts-valid';

export type {
  DiagnosticStatus,
  DiagnosticPlatform,
  DiagnosticResult,
  DiagnosticContext,
  DiagnosticCheck,
  DoctorReport,
} from './types';

export {
  registerDiagnosticCheck,
  getDiagnosticChecks,
  clearDiagnosticChecks,
  buildDoctorReport,
} from './DiagnosticRegistry';

export { redactDoctorReport } from './redact';

let _registered = false;

/**
 * Register the built-in checks. Idempotent — safe to call from every
 * platform bootstrap.
 */
export function registerCoreDiagnosticChecks(): void {
  if (_registered) return;
  _registered = true;
  registerDiagnosticCheck(configValidCheck);
  registerDiagnosticCheck(credentialsPresentCheck);
  registerDiagnosticCheck(channelsReachableCheck);
  registerDiagnosticCheck(mcpConnectedCheck);
  registerDiagnosticCheck(skillsLoadedCheck);
  registerDiagnosticCheck(schedulerHealthCheck);
  registerDiagnosticCheck(policyOriginCheck);
  registerDiagnosticCheck(shortcutsValidCheck);
}
