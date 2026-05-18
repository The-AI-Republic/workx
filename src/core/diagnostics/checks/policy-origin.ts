/**
 * Check: which managed-policy source (if any) is in effect, and how many
 * keys it locks. Informational — a managed policy is healthy, not a fault.
 *
 * Reads the shared {@link getActivePolicySummary} (never the values, so the
 * result is redaction-safe by construction).
 *
 * @module core/diagnostics/checks/policy-origin
 */

import type { DiagnosticCheck, DiagnosticResult } from '../types';
import { getActivePolicySummary } from '@/core/config/policy';

export const policyOriginCheck: DiagnosticCheck = {
  id: 'policy-origin',
  title: 'Managed policy',
  platforms: ['extension', 'desktop', 'server'],
  async run(): Promise<DiagnosticResult> {
    const { origin, lockedKeys, valueCount } = getActivePolicySummary();

    if (!origin) {
      return {
        id: 'policy-origin',
        title: 'Managed policy',
        status: 'pass',
        detail: 'No managed policy in effect (unmanaged install).',
      };
    }

    return {
      id: 'policy-origin',
      title: 'Managed policy',
      status: 'pass',
      detail: `Managed policy active (source: ${origin}; ${lockedKeys.length} locked key(s), ${valueCount} managed value(s)).`,
      data: { origin, lockedKeyCount: lockedKeys.length, valueCount },
    };
  },
};
