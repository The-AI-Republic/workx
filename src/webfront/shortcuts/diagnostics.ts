import type { ShortcutValidationIssue } from '@/core/shortcuts';

export function summarizeShortcutWarnings(warnings: ShortcutValidationIssue[]): string {
  const errors = warnings.filter((warning) => warning.severity === 'error').length;
  const warnCount = warnings.length - errors;
  if (errors > 0) return `${errors} shortcut error${errors === 1 ? '' : 's'}`;
  if (warnCount > 0) return `${warnCount} shortcut warning${warnCount === 1 ? '' : 's'}`;
  return 'Shortcut configuration is valid';
}
