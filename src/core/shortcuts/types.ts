export type ShortcutScope = 'inApp' | 'desktopGlobal' | 'extensionCommand';

export type ShortcutContext =
  | 'Global'
  | 'Chat'
  | 'SlashCommand'
  | 'SettingsSearch'
  | 'SettingsModelSelector'
  | 'ModelPicker'
  | 'SchedulerModal'
  | 'Skills'
  | 'DesktopGlobal'
  | 'ExtensionCommand';

export type ShortcutAction =
  | 'app:zoomIn'
  | 'app:zoomOut'
  | 'app:zoomReset'
  | 'app:toggleWindow'
  | 'app:focusInput'
  | 'app:quickAction'
  | 'chat:submit'
  | 'chat:newline'
  | 'slash:next'
  | 'slash:previous'
  | 'slash:accept'
  | 'slash:dismiss'
  | 'modelPicker:dismiss'
  | 'scheduler:dismiss'
  | 'skills:dismiss'
  | 'settingsSearch:next'
  | 'settingsSearch:previous'
  | 'settingsSearch:accept'
  | 'settingsSearch:dismiss'
  | 'settingsModelSelector:next'
  | 'settingsModelSelector:previous'
  | 'settingsModelSelector:accept'
  | 'settingsModelSelector:dismiss'
  | 'settingsModelSelector:first'
  | 'settingsModelSelector:last';

export type ShortcutPlatform = 'macos' | 'windows' | 'linux';

export interface ShortcutBindingBlock {
  context: ShortcutContext;
  bindings: Record<string, ShortcutAction | null>;
}

export interface ParsedKeystroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedShortcutBinding {
  context: ShortcutContext;
  action: ShortcutAction | null;
  keystrokes: ParsedKeystroke[];
  source: 'default' | 'user';
  original: string;
}

export interface ShortcutUserConfig {
  version: 1;
  bindings: ShortcutBindingBlock[];
}

export interface ShortcutValidationIssue {
  severity: 'error' | 'warning';
  type:
    | 'parse_error'
    | 'unknown_context'
    | 'unknown_action'
    | 'duplicate_key'
    | 'duplicate_action'
    | 'reserved_shortcut'
    | 'unsupported_platform'
    | 'unsupported_chord'
    | 'manifest_mismatch'
    | 'desktop_registration_failed';
  message: string;
  context?: ShortcutContext | string;
  action?: ShortcutAction | string;
  key?: string;
  source?: 'default' | 'user' | 'manifest' | 'desktop';
}

export interface ShortcutActionMeta {
  action: ShortcutAction;
  defaultContext: ShortcutContext;
  scopes: ShortcutScope[];
  label: string;
  description: string;
  owner: 'webfront' | 'desktop' | 'extension' | 'settings' | 'scheduler';
  configurable: boolean;
}
