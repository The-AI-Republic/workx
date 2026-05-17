import { describe, expect, it } from 'vitest';
import {
  EXTENSION_COMMAND_ACTIONS,
  EXTENSION_COMMAND_DEFAULTS,
  getEffectiveBindingsForContext,
  getEffectiveShortcutBindings,
  getShortcutDisplay,
  keyboardEventToKeystroke,
  parseKeystroke,
  resolveShortcut,
  toTauriAccelerator,
  validateShortcutBlocks,
} from '..';
import manifest from '../../../../manifest.json';
import extensionManifest from '../../../extension/manifest.json';

describe('shortcut parser', () => {
  it('parses modifiers, aliases, and symbols', () => {
    expect(parseKeystroke('mod+=', 'linux')).toMatchObject({ key: '=', ctrl: true });
    expect(parseKeystroke('mod+=', 'macos')).toMatchObject({ key: '=', meta: true });
    expect(parseKeystroke('mod++', 'linux')).toMatchObject({ key: '+', ctrl: true });
    expect(parseKeystroke('shift+enter')).toMatchObject({ key: 'enter', shift: true });
    expect(parseKeystroke('esc')).toMatchObject({ key: 'escape' });
    expect(parseKeystroke('ArrowDown')).toMatchObject({ key: 'down' });
  });
});

describe('DOM keyboard normalization', () => {
  it('normalizes keyboard events used by Browserx', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
    expect(keyboardEventToKeystroke(event)).toEqual({
      key: 'enter',
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    });
  });

  it('normalizes shifted plus as a plus key shortcut', () => {
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true });
    expect(keyboardEventToKeystroke(event)).toEqual({
      key: '+',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
  });

  it('ignores composition and modifier-only events', () => {
    expect(keyboardEventToKeystroke(new KeyboardEvent('keydown', { key: 'Shift' }))).toBeNull();
  });
});

describe('shortcut resolver', () => {
  it('uses active context priority before global bindings', () => {
    const { bindings } = getEffectiveShortcutBindings(undefined, { platform: 'linux' });
    const result = resolveShortcut(
      { key: 'enter', ctrl: false, alt: false, shift: false, meta: false },
      ['SlashCommand', 'Chat', 'Global'],
      bindings,
    );
    expect(result).toMatchObject({ type: 'match', action: 'slash:accept' });
  });

  it('lets user bindings override defaults in the same context', () => {
    const { bindings } = getEffectiveShortcutBindings({
      version: 1,
      bindings: [{ context: 'Chat', bindings: { enter: null, 'mod+enter': 'chat:submit' } }],
    }, { platform: 'linux' });

    expect(resolveShortcut(
      { key: 'enter', ctrl: false, alt: false, shift: false, meta: false },
      ['Chat', 'Global'],
      bindings,
    )).toMatchObject({ type: 'unbound' });
    expect(resolveShortcut(
      { key: 'enter', ctrl: true, alt: false, shift: false, meta: false },
      ['Chat', 'Global'],
      bindings,
    )).toMatchObject({ type: 'match', action: 'chat:submit' });
  });

  it('computes effective context bindings with null unbinds', () => {
    const { bindings } = getEffectiveShortcutBindings({
      version: 1,
      bindings: [{
        context: 'DesktopGlobal',
        bindings: {
          'mod+shift+b': null,
          'mod+shift+n': 'app:toggleWindow',
        },
      }],
    }, { platform: 'linux' });

    const desktop = getEffectiveBindingsForContext('DesktopGlobal', bindings);
    expect(desktop.find((binding) => binding.original === 'mod+shift+b')?.action).toBeNull();
    expect(desktop.find((binding) => binding.original === 'mod+shift+n')?.action).toBe('app:toggleWindow');
  });
});

describe('shortcut display and platform adapters', () => {
  it('formats configured shortcuts', () => {
    const { bindings } = getEffectiveShortcutBindings(undefined, { platform: 'macos' });
    expect(getShortcutDisplay('app:zoomIn', 'Global', bindings, 'macos')).toBe('Command++');
  });

  it('converts desktop bindings to Tauri accelerators', () => {
    const { bindings } = getEffectiveShortcutBindings(undefined, { platform: 'linux' });
    const binding = bindings.find((item) => item.action === 'app:quickAction' && item.context === 'DesktopGlobal');
    expect(binding && toTauriAccelerator(binding)).toBe('CommandOrControl+Shift+K');
  });
});

describe('shortcut validation', () => {
  it('reports invalid context, invalid action, duplicate keys, and chords', () => {
    const issues = validateShortcutBlocks([
      { context: 'Nope', bindings: { enter: 'chat:submit' } },
      { context: 'Chat', bindings: { 'ctrl+x ctrl+k': 'chat:submit', enter: 'missing:action' } },
    ]);
    expect(issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['unknown_context', 'unsupported_chord', 'unknown_action']),
    );
  });

  it('keeps defaults when stored versioned preferences are malformed', () => {
    expect(() => getEffectiveShortcutBindings({
      version: 1,
      bindings: [{ context: 'Chat' }],
    })).not.toThrow();

    const result = getEffectiveShortcutBindings({
      version: 1,
      bindings: [{ context: 'Chat' }],
    });
    expect(result.warnings.map((issue) => issue.type)).toContain('parse_error');
    expect(result.bindings.some((binding) => binding.context === 'Chat' && binding.action === 'chat:submit')).toBe(true);
  });
});

describe('extension command mapping', () => {
  it('maps command names to shared actions', () => {
    expect(EXTENSION_COMMAND_ACTIONS['toggle-sidepanel']).toBe('app:toggleWindow');
    expect(EXTENSION_COMMAND_ACTIONS['quick-action']).toBe('app:quickAction');
  });

  it('keeps both manifests in sync with command defaults', () => {
    for (const [command, shortcut] of Object.entries(EXTENSION_COMMAND_DEFAULTS)) {
      expect((manifest.commands as Record<string, { suggested_key: { default: string } }>)[command].suggested_key.default).toBe(shortcut);
      expect((extensionManifest.commands as Record<string, { suggested_key: { default: string } }>)[command].suggested_key.default).toBe(shortcut);
    }
  });
});
