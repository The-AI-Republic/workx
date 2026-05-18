/**
 * Check: keyboard shortcut configuration can be parsed and applied.
 */

import type { DiagnosticCheck, DiagnosticResult } from '../types';
import {
  detectShortcutPlatform,
  getEffectiveShortcutBindings,
  hasShortcutErrors,
  type ShortcutValidationIssue,
} from '@/core/shortcuts';

export const shortcutsValidCheck: DiagnosticCheck = {
  id: 'shortcuts-valid',
  title: 'Keyboard shortcuts valid',
  platforms: ['extension', 'desktop'],
  async run(ctx): Promise<DiagnosticResult> {
    const { AgentConfig } = await import('@/config/AgentConfig');
    const agentConfig = await AgentConfig.getInstance();
    const shortcuts = agentConfig.getConfig().preferences?.shortcuts;
    const result = getEffectiveShortcutBindings(shortcuts, { platform: detectShortcutPlatform() });
    const issues: ShortcutValidationIssue[] = [...result.warnings];

    if (ctx.platformId === 'desktop') {
      try {
        const hotkeys = await import('@/desktop/hotkeys');
        const diagnostics = hotkeys.getHotkeyDiagnostics();
        for (const failure of diagnostics.failures) {
          issues.push({
            severity: 'error',
            type: 'desktop_registration_failed',
            message: `Desktop hotkey "${failure.shortcut}" failed to register: ${failure.error}`,
            key: failure.shortcut,
            source: 'desktop',
          });
        }
      } catch {
        // Desktop diagnostics are best effort because the check is shared.
      }
    }

    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.length - errorCount;

    if (hasShortcutErrors(issues)) {
      return {
        id: 'shortcuts-valid',
        title: 'Keyboard shortcuts valid',
        status: 'fail',
        detail: `Shortcut configuration has ${errorCount} error${errorCount === 1 ? '' : 's'}.`,
        data: { errorCount, warningCount, issueTypes: issues.map((issue) => issue.type) },
      };
    }

    if (warningCount > 0) {
      return {
        id: 'shortcuts-valid',
        title: 'Keyboard shortcuts valid',
        status: 'warn',
        detail: `Shortcut configuration has ${warningCount} warning${warningCount === 1 ? '' : 's'}.`,
        data: { errorCount, warningCount, issueTypes: issues.map((issue) => issue.type) },
      };
    }

    return {
      id: 'shortcuts-valid',
      title: 'Keyboard shortcuts valid',
      status: 'pass',
      detail: 'Shortcut configuration is valid.',
    };
  },
};
