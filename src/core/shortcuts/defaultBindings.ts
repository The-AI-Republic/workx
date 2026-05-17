import type { ShortcutBindingBlock, ShortcutContext } from './types';

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      'mod+=': 'app:zoomIn',
      'mod++': 'app:zoomIn',
      'mod+-': 'app:zoomOut',
      'mod+0': 'app:zoomReset',
    },
  },
  {
    context: 'Chat',
    bindings: {
      enter: 'chat:submit',
      'shift+enter': 'chat:newline',
    },
  },
  {
    context: 'SlashCommand',
    bindings: {
      down: 'slash:next',
      up: 'slash:previous',
      enter: 'slash:accept',
      escape: 'slash:dismiss',
    },
  },
  {
    context: 'ModelPicker',
    bindings: {
      escape: 'modelPicker:dismiss',
    },
  },
  {
    context: 'SchedulerModal',
    bindings: {
      escape: 'scheduler:dismiss',
    },
  },
  {
    context: 'Skills',
    bindings: {
      escape: 'skills:dismiss',
    },
  },
  {
    context: 'SettingsSearch',
    bindings: {
      down: 'settingsSearch:next',
      up: 'settingsSearch:previous',
      enter: 'settingsSearch:accept',
      escape: 'settingsSearch:dismiss',
    },
  },
  {
    context: 'SettingsModelSelector',
    bindings: {
      down: 'settingsModelSelector:next',
      up: 'settingsModelSelector:previous',
      enter: 'settingsModelSelector:accept',
      space: 'settingsModelSelector:accept',
      escape: 'settingsModelSelector:dismiss',
      home: 'settingsModelSelector:first',
      end: 'settingsModelSelector:last',
    },
  },
  {
    context: 'DesktopGlobal',
    bindings: {
      'mod+shift+b': 'app:toggleWindow',
      'mod+shift+i': 'app:focusInput',
      'mod+shift+k': 'app:quickAction',
    },
  },
  {
    context: 'ExtensionCommand',
    bindings: {
      'alt+shift+c': 'app:toggleWindow',
      'alt+shift+q': 'app:quickAction',
    },
  },
];

export function getDefaultBindingsForContext(context: ShortcutContext): ShortcutBindingBlock | undefined {
  return DEFAULT_SHORTCUT_BINDINGS.find((block) => block.context === context);
}
