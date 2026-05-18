import { isShortcutAction, isShortcutContext, SHORTCUT_ACTION_META } from './catalog';
import { parseShortcut, shortcutToCanonicalString } from './parser';
import type {
  ParsedShortcutBinding,
  ShortcutBindingBlock,
  ShortcutContext,
  ShortcutPlatform,
  ShortcutValidationIssue,
} from './types';

const RESERVED_IN_APP = new Set([
  'ctrl+l',
  'meta+l',
  'ctrl+r',
  'meta+r',
  'ctrl+w',
  'meta+w',
  'ctrl+t',
  'meta+t',
  'ctrl+tab',
  'meta+tab',
  'ctrl+shift+tab',
  'meta+shift+tab',
  'f12',
  'ctrl+shift+i',
  'meta+shift+i',
]);

function issue(
  type: ShortcutValidationIssue['type'],
  severity: ShortcutValidationIssue['severity'],
  message: string,
  extra: Partial<ShortcutValidationIssue> = {},
): ShortcutValidationIssue {
  return { type, severity, message, ...extra };
}

export function validateShortcutBlocks(
  blocks: unknown,
  options: { platform?: ShortcutPlatform; source?: 'default' | 'user' } = {},
): ShortcutValidationIssue[] {
  const source = options.source ?? 'user';
  const platform = options.platform ?? 'linux';
  const issues: ShortcutValidationIssue[] = [];

  if (!Array.isArray(blocks)) {
    return [issue('parse_error', 'error', 'Shortcut bindings must be an array.', { source })];
  }

  const seenByContext = new Map<string, Map<string, string | null>>();
  const actionSeenByContext = new Map<string, Set<string>>();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      issues.push(issue('parse_error', 'error', 'Shortcut binding block must be an object.', { source }));
      continue;
    }
    const raw = block as Partial<ShortcutBindingBlock>;
    const context = raw.context;
    if (!context || !isShortcutContext(context)) {
      issues.push(issue('unknown_context', 'error', `Unknown shortcut context "${String(context)}".`, {
        context: String(context),
        source,
      }));
      continue;
    }
    if (!raw.bindings || typeof raw.bindings !== 'object') {
      issues.push(issue('parse_error', 'error', `Shortcut context "${context}" must have a bindings object.`, {
        context,
        source,
      }));
      continue;
    }

    const contextSeen = seenByContext.get(context) ?? new Map<string, string | null>();
    seenByContext.set(context, contextSeen);
    const contextActions = actionSeenByContext.get(context) ?? new Set<string>();
    actionSeenByContext.set(context, contextActions);

    for (const [key, action] of Object.entries(raw.bindings)) {
      let canonical = key;
      try {
        const shortcut = parseShortcut(key, platform);
        canonical = shortcutToCanonicalString(shortcut);
        if (shortcut.length > 1) {
          issues.push(issue('unsupported_chord', 'warning', `Shortcut "${key}" is a chord; chords are not enabled yet.`, {
            key,
            context,
            source,
          }));
        }
      } catch (error) {
        issues.push(issue('parse_error', 'error', error instanceof Error ? error.message : `Invalid shortcut "${key}".`, {
          key,
          context,
          source,
        }));
        continue;
      }

      if (action !== null && (typeof action !== 'string' || !isShortcutAction(action))) {
        issues.push(issue('unknown_action', 'error', `Unknown shortcut action "${String(action)}".`, {
          key,
          context,
          action: String(action),
          source,
        }));
        continue;
      }

      const previous = contextSeen.get(canonical);
      if (previous !== undefined && previous !== action) {
        issues.push(issue('duplicate_key', 'warning', `Shortcut "${key}" is defined more than once in ${context}.`, {
          key,
          context,
          action: action ?? undefined,
          source,
        }));
      }
      contextSeen.set(canonical, action);

      if (action) {
        if (source === 'user' && contextActions.has(action)) {
          issues.push(issue('duplicate_action', 'warning', `Action "${action}" has multiple shortcuts in ${context}.`, {
            key,
            context,
            action,
            source,
          }));
        }
        contextActions.add(action);
      }

      if (context !== 'DesktopGlobal' && context !== 'ExtensionCommand' && RESERVED_IN_APP.has(canonical)) {
        issues.push(issue('reserved_shortcut', 'warning', `Shortcut "${key}" may conflict with browser or OS behavior.`, {
          key,
          context,
          action: action ?? undefined,
          source,
        }));
      }
    }
  }

  return issues;
}

export function validateParsedBindings(bindings: ParsedShortcutBinding[]): ShortcutValidationIssue[] {
  const issues: ShortcutValidationIssue[] = [];
  for (const binding of bindings) {
    if (binding.action && !SHORTCUT_ACTION_META[binding.action]) {
      issues.push(issue('unknown_action', 'error', `Unknown shortcut action "${binding.action}".`, {
        action: binding.action,
        context: binding.context,
        key: binding.original,
        source: binding.source,
      }));
    }
  }
  return issues;
}

export function hasShortcutErrors(issues: ShortcutValidationIssue[]): boolean {
  return issues.some((item) => item.severity === 'error');
}
