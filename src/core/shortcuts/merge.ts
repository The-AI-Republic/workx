import { isShortcutAction, SHORTCUT_ACTION_META } from './catalog';
import { DEFAULT_SHORTCUT_BINDINGS } from './defaultBindings';
import { parseBindingBlocks } from './parser';
import { validateShortcutBlocks } from './validate';
import type {
  ParsedShortcutBinding,
  ShortcutBindingBlock,
  ShortcutPlatform,
  ShortcutUserConfig,
  ShortcutValidationIssue,
} from './types';

export function normalizeShortcutPreferences(
  value: unknown,
): { config: ShortcutUserConfig | null; warnings: ShortcutValidationIssue[] } {
  if (!value || (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)) {
    return { config: null, warnings: [] };
  }

  if (typeof value !== 'object') {
    return {
      config: null,
      warnings: [{
        severity: 'error',
        type: 'parse_error',
        message: 'Shortcut preferences must be an object.',
        source: 'user',
      }],
    };
  }

  const raw = value as Record<string, unknown>;
  if (raw.version === 1 && Array.isArray(raw.bindings)) {
    return { config: raw as unknown as ShortcutUserConfig, warnings: [] };
  }

  const legacyBlocks: ShortcutBindingBlock[] = [];
  const byContext = new Map<ShortcutBindingBlock['context'], Record<string, ShortcutBindingBlock['bindings'][string]>>();
  for (const [key, rawActionOrShortcut] of Object.entries(raw)) {
    if (typeof rawActionOrShortcut !== 'string') continue;

    if (isShortcutAction(key)) {
      const meta = SHORTCUT_ACTION_META[key];
      const bindings = byContext.get(meta.defaultContext) ?? {};
      bindings[rawActionOrShortcut] = key;
      byContext.set(meta.defaultContext, bindings);
    } else if (isShortcutAction(rawActionOrShortcut)) {
      const meta = SHORTCUT_ACTION_META[rawActionOrShortcut];
      const bindings = byContext.get(meta.defaultContext) ?? {};
      bindings[key] = rawActionOrShortcut;
      byContext.set(meta.defaultContext, bindings);
    }
  }

  for (const [context, bindings] of byContext.entries()) {
    legacyBlocks.push({ context, bindings });
  }

  return {
    config: legacyBlocks.length > 0 ? { version: 1, bindings: legacyBlocks } : null,
    warnings: legacyBlocks.length > 0
      ? [{
          severity: 'warning',
          type: 'parse_error',
          message: 'Legacy shortcut preferences were converted to the versioned shortcut format.',
          source: 'user',
        }]
      : [],
  };
}

export function getEffectiveShortcutBindings(
  userValue: unknown,
  options: { platform?: ShortcutPlatform; includeUser?: boolean } = {},
): { bindings: ParsedShortcutBinding[]; warnings: ShortcutValidationIssue[] } {
  const platform = options.platform ?? 'linux';
  const includeUser = options.includeUser ?? true;
  const warnings: ShortcutValidationIssue[] = [
    ...validateShortcutBlocks(DEFAULT_SHORTCUT_BINDINGS, { platform, source: 'default' }),
  ];

  const bindings: ParsedShortcutBinding[] = [
    ...parseBindingBlocks(DEFAULT_SHORTCUT_BINDINGS, { platform, source: 'default', skipInvalid: true }),
  ];

  if (!includeUser) {
    return { bindings, warnings };
  }

  const normalized = normalizeShortcutPreferences(userValue);
  warnings.push(...normalized.warnings);
  if (!normalized.config) {
    return { bindings, warnings };
  }

  warnings.push(...validateShortcutBlocks(normalized.config.bindings, { platform, source: 'user' }));
  bindings.push(...parseBindingBlocks(normalized.config.bindings, {
    platform,
    source: 'user',
    skipInvalid: true,
  }));

  return { bindings, warnings };
}
