# Track 38: Keyboard Shortcut System

**Date**: 2026-05-16
**Scope**: Browserx webfront, Chrome extension commands, Tauri desktop global hotkeys, settings, diagnostics
**Reference**: `/home/rich/dev/study/claudy/src/keybindings`

## Goal

Browserx already has keyboard shortcuts, but they are not a system yet. They are separate implementations that happen to use keys:

- Chrome extension commands are declared in `manifest.json` and `src/extension/manifest.json`, then handled by `chrome.commands` in `src/extension/background/service-worker.ts`.
- Tauri desktop global hotkeys are hardcoded in `src/desktop/hotkeys.ts`.
- In-app shortcuts are hardcoded in Svelte handlers such as `src/webfront/App.svelte`, `src/webfront/components/MessageInput.svelte`, modal components, settings search, model selectors, and scheduler dialogs.

This track turns those scattered handlers into a product-level shortcut system:

```text
keyboard event or platform command -> shortcut action id -> local handler
```

The end state is not a direct transplant from Claudy. Browserx is a DOM app that also runs as a Chrome extension and a Tauri desktop app. The right implementation is a shared shortcut catalog plus platform-specific adapters:

- Pure shortcut catalog, parser, resolver, display, validation, and config merge logic in `src/core/shortcuts`.
- Svelte runtime registration and DOM listener in `src/webfront/shortcuts`.
- Desktop global hotkey registration in `src/desktop/hotkeys.ts`, generated from the shared catalog.
- Chrome command mapping in `src/extension/background/service-worker.ts`, mapped to the same action ids.
- Settings and diagnostics that read the same effective shortcut data used at runtime.

After this track is implemented, Browserx should have:

- one typed inventory of shortcut actions and contexts,
- one source of defaults for webfront, desktop, and extension shortcuts,
- explicit context priority for overlapping keys such as `Enter`, `Escape`, `ArrowUp`, and `ArrowDown`,
- dynamic shortcut display for help/settings UI,
- validation for user overrides and platform limitations,
- desktop and extension command parity checks,
- focused tests for parser, resolver, validation, Svelte integration, desktop adapters, and extension command mapping.

## Current Browserx Behavior

### Extension Commands

Files:

- `manifest.json`
- `src/extension/manifest.json`
- `src/extension/background/service-worker.ts`

Current defaults:

- `Alt+Shift+C`: `toggle-sidepanel`
- `Alt+Shift+Q`: `quick-action`

Current service worker behavior:

- `toggle-sidepanel` calls `chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })`.
- `quick-action` queries the active tab and calls `executeQuickAction(tabId)`.

Problems:

- The command names are not connected to the rest of Browserx shortcut behavior.
- The defaults are duplicated in two manifests.
- There is no testable command-name-to-product-action mapping.
- Chrome users can change extension shortcuts outside Browserx, so UI display must use `chrome.commands.getAll()` where available instead of trusting the manifest default.

### Desktop Global Hotkeys

File:

- `src/desktop/hotkeys.ts`

Current defaults:

- `CommandOrControl+Shift+B`: toggle window
- `CommandOrControl+Shift+I`: focus input
- `CommandOrControl+Shift+K`: quick action

Current behavior:

- `toggleWindow` calls `toggleWindow()` from `src/desktop/tray.ts`.
- `focusInput` shows/focuses the Tauri window and dispatches `applepi:focus-input`.
- `quickAction` shows/focuses the Tauri window and dispatches `applepi:quick-action`.

Problems:

- Defaults are hardcoded in the desktop module.
- There is no shared action id, display helper, validation, or settings integration.
- Registration failure is logged but not surfaced to diagnostics/settings.
- There is no relationship between desktop `quickAction` and extension `quick-action`.

### In-App DOM Shortcuts

Important files:

- `src/webfront/App.svelte`: `Ctrl/Cmd` plus `+`, `-`, and `0` for zoom.
- `src/webfront/components/MessageInput.svelte`: `Enter` submit, `Shift+Enter` newline, slash-command navigation with `ArrowDown`, `ArrowUp`, `Escape`, and `Enter`.
- `src/webfront/components/chat/ModelSelection.svelte`: window-level `Escape`.
- `src/webfront/components/scheduler/ScheduleJobModal.svelte`: window-level `Escape`.
- `src/webfront/components/scheduler/JobDetailModal.svelte`: window-level `Escape`.
- `src/webfront/pages/skills/Skills.svelte`: window-level `Escape`.
- `src/webfront/settings/components/SettingsSearch.svelte`: input-local search result navigation.
- `src/webfront/settings/components/ModelSelector.svelte`: input-local model dropdown navigation.
- Various buttons/tabs/switches use `Enter` and `Space` for accessibility.

What should stay local:

- Native button, switch, tab, and clickable-row accessibility handlers using `Enter` and `Space`.
- Component-specific text-entry behavior that is not product-configurable.

What should move into the shortcut system:

- App-level zoom.
- Chat submit and newline display/behavior.
- Slash command navigation and dismissal.
- Overlay dismissal when the overlay owns a modal/model-picker/scheduler context.
- Settings search and model-selector navigation only if we decide they should appear in keyboard help and be user-configurable. Otherwise they can stay local.

Problems:

- There is no complete shortcut inventory.
- There is no shortcut help/settings screen.
- Context precedence is implicit. Multiple mounted window listeners can all see `Escape`.
- Key labels in UI cannot reliably reflect user overrides.

## Claudy Findings To Reuse

Claudy has a mature keybinding subsystem under `/home/rich/dev/study/claudy/src/keybindings`.

Useful patterns:

- `defaultBindings.ts` maps key strings to stable action ids grouped by contexts.
- `parser.ts`, `match.ts`, and `resolver.ts` keep parsing and resolution pure and testable.
- `useKeybinding.ts` lets components own side effects while bindings stay configurable.
- `KeybindingContext.tsx` and `KeybindingProviderSetup.tsx` keep active contexts and handler registration centralized.
- `validate.ts`, `reservedShortcuts.ts`, and `loadUserBindings.ts` validate user overrides before runtime use.
- `shortcutFormat.ts` and `useShortcutDisplay.ts` let UI display the currently configured key instead of hardcoded text.
- Chord support is isolated behind resolver state and an early interceptor, so chord prefixes do not leak into the prompt input.

Things Browserx should not copy directly:

- Ink `Key` matching. Browserx must normalize DOM `KeyboardEvent`, Chrome command strings, and Tauri accelerators.
- Terminal-specific alt/meta/super behavior.
- User config file watching from `~/.claude/keybindings.json`. Browserx already has `AgentConfig` and `preferences.shortcuts`.
- React provider/hook mechanics. Browserx uses Svelte 5 runes and store-style modules.
- Chords in v1. Browser DOM text inputs, IME composition, and capture-phase handling make chords riskier than single-keystroke shortcuts.

## Design Decisions

1. Use action ids as product contracts.

   Components and platform services handle actions such as `app:zoomIn`, `chat:submit`, or `app:quickAction`. Key strings are configuration, not component API.

2. Keep handlers local.

   The shortcut runtime should find the action. The owning component or service should perform the side effect. Avoid a single global switch for all in-app behavior.

3. Put shared logic in `src/core/shortcuts`.

   Desktop, extension, diagnostics, settings, and webfront tests all need the same catalog and validation. `src/webfront/shortcuts` should only contain Svelte-specific runtime helpers.

4. Make contexts explicit and ordered.

   `SlashCommand` should beat `Chat`; modal contexts should beat `Global`; `Global` should be last. Context order must be testable.

5. Treat platform globals as privileged.

   Desktop global hotkeys and Chrome extension commands can conflict with OS/browser shortcuts or user-changed browser settings. They need validation, graceful failure, and diagnostics.

6. Do not migrate accessibility semantics.

   `Enter`/`Space` handlers for normal buttons, tabs, switches, and clickable rows should remain local/native. They are accessibility behavior, not shortcut customization.

7. Ship single-keystroke shortcuts end to end before chords.

   The resolver can leave room for chords, but Track 38 completion should not depend on chord support.

## Target File Layout

```text
src/core/shortcuts/
|-- types.ts                    # shared types
|-- catalog.ts                  # contexts, actions, descriptions, ownership metadata
|-- defaultBindings.ts          # default binding blocks for all scopes
|-- parser.ts                   # parse shortcut strings into normalized keys
|-- domEvent.ts                 # DOM KeyboardEvent -> normalized keystroke
|-- resolver.ts                 # pure context + key + bindings -> action
|-- display.ts                  # platform-aware display strings
|-- validate.ts                 # config, duplicate, reserved, unsupported checks
|-- merge.ts                    # defaults + user overrides -> effective bindings
|-- platformAdapters.ts         # DOM/Tauri/Chrome string conversions
|-- extensionCommands.ts        # Chrome command name <-> action id mapping
`-- inventory.ts                # generated/current shortcut inventory helpers

src/webfront/shortcuts/
|-- shortcutStore.ts            # Svelte-readable effective bindings + warnings
|-- ShortcutProvider.svelte     # root DOM keydown listener and registry owner
|-- useShortcut.ts              # registerShortcut/registerShortcutContext helpers
|-- ShortcutHelp.svelte         # read-only help/settings list
`-- diagnostics.ts              # UI formatting for shortcut warnings
```

Do not import Svelte modules from `src/core/shortcuts`. `src/core/shortcuts` must be usable by Vitest, desktop modules, and extension service worker code without pulling webfront runtime code.

## Core Types

```ts
export type ShortcutScope = 'inApp' | 'desktopGlobal' | 'extensionCommand';

export type ShortcutContext =
  | 'Global'
  | 'Chat'
  | 'SlashCommand'
  | 'Modal'
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
  | 'modal:dismiss'
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
}

export interface ShortcutUserConfig {
  version: 1;
  bindings: ShortcutBindingBlock[];
}
```

Notes:

- `null` means "explicitly unbound", matching Claudy's useful override semantics.
- `mod` is accepted in config and normalizes to `Meta` on macOS and `Ctrl` on Windows/Linux for DOM display/resolution. For Tauri registration it converts to `CommandOrControl`.
- Chrome extension manifests cannot use runtime `mod`; catalog helpers must emit concrete suggested keys.
- Chord arrays are represented in the parsed shape to avoid future rewrites, but v1 validation should reject multi-keystroke chords for user config unless `allowChords` is explicitly enabled in tests or a future phase.

`catalog.ts` should also define metadata for settings/help/diagnostics:

```ts
export interface ShortcutActionMeta {
  action: ShortcutAction;
  defaultContext: ShortcutContext;
  scopes: ShortcutScope[];
  label: string;
  description: string;
  owner:
    | 'webfront'
    | 'desktop'
    | 'extension'
    | 'settings'
    | 'scheduler';
  configurable: boolean;
}

export const SHORTCUT_ACTION_META: Record<ShortcutAction, ShortcutActionMeta> = {
  'app:zoomIn': {
    action: 'app:zoomIn',
    defaultContext: 'Global',
    scopes: ['inApp'],
    label: 'Zoom in',
    description: 'Increase the Browserx UI zoom level.',
    owner: 'webfront',
    configurable: true,
  },
  // ...
};
```

The metadata is what settings should render. Do not derive user-facing labels from action id strings.

## Default Bindings

The v1 defaults should model current Browserx behavior:

```ts
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
    context: 'Modal',
    bindings: {
      escape: 'modal:dismiss',
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
```

Settings search and settings model selector can be added to the catalog in Track 38C only if the implementation migrates those components. If not migrated, keep their action ids out of the default help list to avoid promising configurable behavior that is still local.

## User Config

Browserx already has `preferences.shortcuts?: Record<string, string>` in `src/config/types.ts` and defaults it to `{}` in `src/config/defaults.ts`. This track should replace the flat shape with a versioned shortcut config while preserving backward compatibility:

```ts
export type ShortcutPreferences = ShortcutUserConfig | Record<string, string>;

export interface IUserPreferences {
  // ...
  shortcuts?: ShortcutPreferences;
}
```

`src/core/shortcuts/merge.ts` should expose:

```ts
export function normalizeShortcutPreferences(
  value: unknown,
): { config: ShortcutUserConfig | null; warnings: ShortcutValidationIssue[] };

export function getEffectiveShortcutBindings(
  userValue: unknown,
  options: { platform: 'macos' | 'windows' | 'linux'; includeUser?: boolean },
): { bindings: ParsedShortcutBinding[]; warnings: ShortcutValidationIssue[] };
```

Rules:

- Missing `preferences.shortcuts` means defaults only.
- `{}` means defaults only.
- Versioned `{ version: 1, bindings: [...] }` is the supported shape.
- Legacy flat records are accepted during migration as global overrides when possible, but settings should save back in the versioned shape.
- User bindings are parsed after defaults, so later entries win.
- `null` user bindings unbind a default.
- Validation warnings must not prevent app startup. Invalid user blocks are ignored and reported.

## Resolver Behavior

`src/core/shortcuts/resolver.ts` should be pure.

```ts
export type ShortcutResolveResult =
  | { type: 'match'; action: ShortcutAction; binding: ParsedShortcutBinding }
  | { type: 'unbound'; binding: ParsedShortcutBinding }
  | { type: 'none' };

export function resolveShortcut(
  key: ParsedKeystroke,
  activeContexts: ShortcutContext[],
  bindings: ParsedShortcutBinding[],
): ShortcutResolveResult;
```

Resolution rules:

1. `activeContexts` is already ordered from highest priority to lowest.
2. `Global` is appended by the webfront provider if not already present.
3. Only bindings whose context is in `activeContexts` are considered.
4. Higher-priority context wins over lower-priority context.
5. Within the same context and key, the last parsed binding wins. This supports user overrides.
6. `null` returns `unbound` and should consume the event only when the runtime is inside shortcut handling for that context.
7. v1 ignores multi-keystroke chords. Parser can represent them, validation rejects them for user config.

The resolver should not know about DOM focus, Svelte components, Tauri, Chrome, config storage, or event propagation.

## DOM Event Normalization

`src/core/shortcuts/domEvent.ts` should convert `KeyboardEvent` to `ParsedKeystroke | null`.

Normalization requirements:

- Ignore `event.isComposing`.
- Normalize `Escape` to `escape`.
- Normalize `Enter` to `enter`.
- Normalize `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` to `up`, `down`, `left`, `right`.
- Normalize `PageUp`, `PageDown`, `Home`, `End`, `Backspace`, `Delete`, `Tab`, and space.
- Lowercase printable single-character keys.
- Preserve `ctrlKey`, `altKey`, `shiftKey`, and `metaKey`.
- Treat `=` and `+` as distinct key values so current zoom behavior can support both `mod+=` and `mod++`.
- Return `null` for modifier-only keydown events.

Editable-target guard:

```ts
export function shouldResolveInAppShortcut(
  event: KeyboardEvent,
  activeContexts: ShortcutContext[],
): boolean;
```

Rules:

- Never resolve if `event.defaultPrevented` is already true.
- Never resolve during IME composition.
- In editable elements, resolve only:
  - active context shortcuts owned by that editable area, such as `Chat` and `SlashCommand`,
  - modified `Global` shortcuts such as zoom,
  - pending chord handling in a future phase.
- Outside editable elements, resolve active contexts plus `Global`.

This guard is important because Browserx has real textareas and inputs. Claudy's terminal prompt problem maps to Browserx as "do not steal normal typing from focused inputs".

## Webfront Runtime

`src/webfront/shortcuts/ShortcutProvider.svelte` should wrap the app inside `src/webfront/App.svelte`:

```svelte
<ShortcutProvider>
  <AppShell>
    ...
  </AppShell>
</ShortcutProvider>
```

Provider responsibilities:

- Load effective bindings from `AgentConfig.getInstance().getConfig().preferences?.shortcuts`.
- Subscribe to `AgentConfig` config change events if available, or expose a `reloadShortcutStore()` function called by settings after save.
- Own a handler registry keyed by action id.
- Own an active context registry with explicit priority.
- Install one root `window.addEventListener('keydown', handler, { capture: true })`.
- Resolve shortcuts through `resolveShortcut`.
- Invoke the first active handler for the resolved action.
- If the handler returns anything except `false`, call `event.preventDefault()` and `event.stopImmediatePropagation()`.
- Expose warnings to settings/help UI and diagnostics formatting.

`src/webfront/shortcuts/useShortcut.ts` should provide framework-light helpers:

```ts
export type ShortcutHandler = (event: KeyboardEvent) => void | false | Promise<void | false>;

export function registerShortcut(
  action: ShortcutAction,
  context: ShortcutContext,
  handler: ShortcutHandler,
): () => void;

export function registerShortcutContext(
  context: ShortcutContext,
  options?: { active?: () => boolean; priority?: number },
): () => void;

export function getShortcutDisplay(
  action: ShortcutAction,
  context: ShortcutContext,
  fallback?: string,
): string;
```

Svelte components can call these inside `$effect` or `onMount`, returning unregister functions in cleanup. This is closer to Browserx's existing style than introducing React-like hooks.

Context priority:

```ts
const CONTEXT_PRIORITY: Record<ShortcutContext, number> = {
  SlashCommand: 100,
  Modal: 90,
  SchedulerModal: 90,
  ModelPicker: 80,
  Skills: 80,
  SettingsSearch: 70,
  SettingsModelSelector: 70,
  Chat: 50,
  Global: 0,
  DesktopGlobal: 0,
  ExtensionCommand: 0,
};
```

If two registrations use the same context and priority, newer active registration wins. This fixes multiple mounted `Escape` listeners by making ownership explicit.

## In-App Migration Plan

### Zoom

Current owner: `src/webfront/App.svelte`

Replace the dedicated `handleZoom` window listener with three registered handlers:

- `app:zoomIn`
- `app:zoomOut`
- `app:zoomReset`

Keep `applyZoom`, `setZoom`, `MIN_ZOOM`, `MAX_ZOOM`, and persistence behavior in `App.svelte`. The shortcut system should not know how zoom is stored.

### Chat Submit And Newline

Current owner: `src/webfront/components/MessageInput.svelte`

Register `Chat` context only while the textarea is focused. Register:

- `chat:submit`: calls the existing submit logic if `value.trim()` or `pendingAttachments.length`; consumes the event.
- `chat:newline`: returns `false` so the textarea default newline behavior still occurs. This action exists mainly so display/help and conflict validation understand `Shift+Enter`.

Keep clipboard image handling, command execution, long press scheduling, and submit-with-attachments logic local.

### Slash Command Dropdown

Current owner: `src/webfront/components/MessageInput.svelte`

Register `SlashCommand` context while `isCommandMode && showDropdown` is true. Register:

- `slash:next`: current `ArrowDown` behavior.
- `slash:previous`: current `ArrowUp` behavior.
- `slash:dismiss`: current `Escape` behavior.
- `slash:accept`: current `Enter` behavior for selected command or direct parse.

Tests must prove `SlashCommand` beats `Chat` for `Enter`, `Escape`, `ArrowUp`, and `ArrowDown`.

### Modal Escape

Migrate one overlay family at a time:

- Scheduler modals: `ScheduleJobModal.svelte`, `JobDetailModal.svelte`.
- Model picker: `ModelSelection.svelte`.
- Skills overlay: `Skills.svelte`.
- Settings unsaved changes dialog can either use `Modal` or remain local until settings migration.

Each overlay should register context only while visible/open. Remove its `svelte:window onkeydown` after migration.

### Settings Search And Settings Model Selector

These can be migrated after the core Chat/Slash/Modal path is stable. They currently use element-local `onkeydown`, which is acceptable. Migrate them only if shortcut help/settings should expose them.

If migrated:

- `SettingsSearch.svelte` registers `SettingsSearch` while the search input is focused and results are visible.
- `ModelSelector.svelte` registers `SettingsModelSelector` while the dropdown is focused/open.
- Keep `Enter` and `Space` accessibility activation for ordinary clickable rows local unless the selector context owns them.

## Desktop Integration

`src/desktop/hotkeys.ts` should stop defining `DEFAULT_HOTKEYS` by hand. Instead:

```ts
import {
  getDefaultBindingsForContext,
  getActionForDesktopHotkey,
  toTauriAccelerator,
} from '@/core/shortcuts';
```

Runtime flow:

1. Read effective bindings for `DesktopGlobal`.
2. Convert each supported binding to Tauri accelerator syntax:
   - `mod+shift+b` -> `CommandOrControl+Shift+B`
   - `mod+shift+i` -> `CommandOrControl+Shift+I`
   - `mod+shift+k` -> `CommandOrControl+Shift+K`
3. Register each accelerator with Tauri.
4. Store registration results in module-level state for diagnostics:
   - registered shortcuts,
   - skipped invalid shortcuts,
   - registration failures.
5. Dispatch action-local behavior through a desktop action handler map:

```ts
const DESKTOP_SHORTCUT_HANDLERS: Record<ShortcutAction, () => Promise<void> | void> = {
  'app:toggleWindow': async () => toggleWindow(),
  'app:focusInput': async () => {
    await showAndFocusWindow();
    window.dispatchEvent(new CustomEvent('applepi:focus-input'));
  },
  'app:quickAction': async () => {
    await showAndFocusWindow();
    window.dispatchEvent(new CustomEvent('applepi:quick-action'));
  },
};
```

Keep `registerHotkey`, `unregisterHotkey`, `unregisterAllHotkeys`, `getRegisteredHotkeys`, and `isHotkeyRegistered` exported because they are already the desktop module API.

Add:

```ts
export function getHotkeyDiagnostics(): DesktopHotkeyDiagnostics;
```

Diagnostics should include registration failures so `/doctor` can report them.

## Extension Integration

Chrome manifests must stay static:

- `manifest.json`
- `src/extension/manifest.json`

Add `src/core/shortcuts/extensionCommands.ts`:

```ts
export const EXTENSION_COMMAND_ACTIONS: Record<string, ShortcutAction> = {
  'toggle-sidepanel': 'app:toggleWindow',
  'quick-action': 'app:quickAction',
};

export const EXTENSION_COMMAND_DEFAULTS: Record<string, string> = {
  'toggle-sidepanel': 'Alt+Shift+C',
  'quick-action': 'Alt+Shift+Q',
};
```

Change `src/extension/background/service-worker.ts`:

```ts
function handleCommand(commandName: string): void {
  const action = EXTENSION_COMMAND_ACTIONS[commandName];
  if (!action) {
    console.warn('[ServiceWorker] Unknown command:', commandName);
    return;
  }
  handleShortcutAction(action);
}
```

Then keep extension side effects local:

```ts
function handleShortcutAction(action: ShortcutAction): void {
  switch (action) {
    case 'app:toggleWindow':
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      return;
    case 'app:quickAction':
      chrome.tabs.query({ active: true, currentWindow: true }, ...);
      return;
  }
}
```

Add a unit test that exercises command-name mapping without Chrome runtime.

Add a manifest parity test:

- Parse both manifest files.
- Assert every command in `EXTENSION_COMMAND_ACTIONS` exists in both manifests.
- Assert manifest `suggested_key.default` matches `EXTENSION_COMMAND_DEFAULTS`.

For display in settings/help:

- In extension UI, call `chrome.commands.getAll()` when available.
- If Chrome returns a user-assigned shortcut, display that.
- Otherwise display the catalog default.

## Settings And Help UI

Add a keyboard shortcuts settings/help view after the runtime is stable.

Recommended integration:

- Add `keyboard-shortcuts` to `NavigationView` in `src/webfront/pages/settings/Settings.svelte`.
- Add a category card in `src/webfront/settings/components/SettingsMenu.svelte`.
- Add entries to `src/webfront/settings/settingsSearchRegistry.ts`.
- Create `src/webfront/settings/KeyboardShortcutsSettings.svelte` or reuse `ShortcutHelp.svelte` inside settings.

Ship in two steps:

1. Read-only help view:
   - grouped by context,
   - shows action label, description, current binding, source, and warning status,
   - uses `display.ts` and Chrome command lookup where possible.
2. Editable overrides:
   - edit one action binding at a time,
   - validate before saving,
   - save versioned config to `preferences.shortcuts`,
   - reset action to default,
   - reset all to defaults.

Do not add editable global desktop shortcuts until validation and failure display are in place. A bad desktop global can fail because the OS or another app owns it.

## Validation

`src/core/shortcuts/validate.ts` should report structured issues:

```ts
export type ShortcutValidationIssue = {
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
  context?: ShortcutContext;
  action?: ShortcutAction;
  key?: string;
  source?: 'default' | 'user' | 'manifest' | 'desktop';
};
```

Validation rules:

- Unknown context is an error.
- Unknown action is an error.
- Invalid key syntax is an error.
- Duplicate key in the same context is a warning if last-one-wins is clear.
- Duplicate action in the same context is a warning because display can become ambiguous.
- Reserved browser shortcuts are warnings for in-app shortcuts and errors for global platform bindings where appropriate.
- Chords are warnings/errors in v1 user config depending on whether they would be ignored.
- Tauri unsupported accelerators are errors for `DesktopGlobal`.
- Chrome manifest mismatches are warnings in local tests and diagnostics.

Reserved shortcut examples:

- Browser navigation/editing shortcuts: `mod+l`, `mod+r`, `mod+w`, `mod+t`, `mod+tab`, `mod+shift+tab`.
- Browser developer tools: `f12`, `mod+shift+i`.
- Common OS shortcuts: `mod+space`, `alt+tab`, `mod+q`.

Important: `mod+shift+i` is currently a desktop global default for focus input. Validation must treat desktop global defaults separately from in-app browser shortcuts. It may be acceptable for Tauri but should not be introduced as a webfront DOM shortcut.

## Diagnostics

Add `src/core/diagnostics/checks/shortcuts-valid.ts` and register it in `src/core/diagnostics/index.ts`.

The check should:

- load `AgentConfig`,
- validate `preferences.shortcuts`,
- validate effective defaults for the current platform,
- include desktop hotkey registration failures when running in desktop mode and diagnostics are available,
- include manifest parity problems when running in extension mode or in tests that can read manifests.

Doctor output should be compact:

- pass: "Shortcut configuration is valid."
- warn: "Shortcut configuration has N warning(s)."
- fail: "Shortcut configuration has N error(s)."

Structured data can include counts and issue types. It must not include user-specific secrets, though shortcut keys themselves are safe.

## Implementation Phases

### Track 38A: Core Catalog, Parser, Resolver

Files to add:

- `src/core/shortcuts/types.ts`
- `src/core/shortcuts/catalog.ts`
- `src/core/shortcuts/defaultBindings.ts`
- `src/core/shortcuts/parser.ts`
- `src/core/shortcuts/domEvent.ts`
- `src/core/shortcuts/resolver.ts`
- `src/core/shortcuts/display.ts`
- `src/core/shortcuts/merge.ts`
- `src/core/shortcuts/validate.ts`
- `src/core/shortcuts/index.ts`
- `src/core/shortcuts/__tests__/*`

No behavior changes.

Acceptance criteria:

- Parser tests cover `mod`, `ctrl`, `cmd/meta`, `alt`, `shift`, arrows, escape, enter, space, tab, plus, minus, zero.
- DOM normalization tests cover `KeyboardEvent.key` values used by Browserx.
- Resolver tests prove context priority and last-one-wins user overrides.
- Display tests cover macOS, Windows, Linux, Tauri, and Chrome formats.
- Validation tests cover unknown context/action, duplicates, reserved shortcuts, unsupported chords, and malformed config.

### Track 38B: Webfront Runtime And Zoom Migration

Files to add:

- `src/webfront/shortcuts/shortcutStore.ts`
- `src/webfront/shortcuts/ShortcutProvider.svelte`
- `src/webfront/shortcuts/useShortcut.ts`

Files to change:

- `src/webfront/App.svelte`

Acceptance criteria:

- `ShortcutProvider` wraps the existing app.
- Zoom behavior remains identical.
- Existing zoom persistence through `preferences.zoomLevel` remains unchanged.
- No text input behavior changes.
- Tests cover root DOM listener resolution and zoom action invocation.

### Track 38C: Chat, Slash Command, And Overlay Migration

Files to change:

- `src/webfront/components/MessageInput.svelte`
- `src/webfront/components/chat/ModelSelection.svelte`
- `src/webfront/components/scheduler/ScheduleJobModal.svelte`
- `src/webfront/components/scheduler/JobDetailModal.svelte`
- optionally `src/webfront/pages/skills/Skills.svelte`

Acceptance criteria:

- `Enter` submits chat exactly as today.
- `Shift+Enter` still inserts a newline.
- Slash command `ArrowDown`, `ArrowUp`, `Escape`, and `Enter` behave exactly as today.
- `SlashCommand` beats `Chat` for overlapping keys.
- Visible overlays dismiss on `Escape` only when their context is active.
- Removed window-level `Escape` listeners do not regress modal close behavior.
- Existing `MessageInput` tests pass, with new tests for context precedence.

### Track 38D: Desktop And Extension Platform Globals

Files to change:

- `src/desktop/hotkeys.ts`
- `src/extension/background/service-worker.ts`
- `manifest.json`
- `src/extension/manifest.json`

Files to add:

- `src/core/shortcuts/platformAdapters.ts`
- `src/core/shortcuts/extensionCommands.ts`
- desktop and extension shortcut tests

Acceptance criteria:

- Desktop hotkeys are derived from `DesktopGlobal` effective bindings.
- Desktop registration still dispatches toggle window, focus input, and quick action.
- Desktop registration failures are stored for diagnostics.
- Extension `chrome.commands` maps command names to shared action ids.
- Extension commands still open the side panel and run quick action.
- Manifest parity test covers both manifest files.

### Track 38E: Settings, User Overrides, And Diagnostics

Files to change:

- `src/config/types.ts`
- `src/config/defaults.ts`
- `src/config/validators.ts`
- `src/webfront/pages/settings/Settings.svelte`
- `src/webfront/settings/components/SettingsMenu.svelte`
- `src/webfront/settings/settingsSearchRegistry.ts`
- `src/core/diagnostics/index.ts`

Files to add:

- `src/webfront/settings/KeyboardShortcutsSettings.svelte`
- `src/core/diagnostics/checks/shortcuts-valid.ts`

Acceptance criteria:

- Settings has a keyboard shortcuts page.
- Read-only list displays effective shortcuts from the same display helper used by runtime code.
- User can override an in-app shortcut, save, reload, and use the new shortcut.
- User can reset one shortcut and reset all shortcuts to defaults.
- Invalid overrides are rejected or saved with warnings according to validation severity.
- `/doctor` reports shortcut config warnings/errors.
- Existing config validation tests are updated for the versioned shortcuts shape.

### Future Track: Chords

Do not include chords in the Track 38 definition of done.

If added later:

- resolver state must support pending chord prefixes,
- DOM listener must run early enough to prevent prefix/second key leakage into textareas,
- chord timeout should be deterministic, likely 1000 ms,
- `event.isComposing` must cancel/skip chord handling,
- text-producing chord prefixes should be forbidden in editable contexts unless explicitly proven safe.

## End-To-End Definition Of Done

Track 38 is complete when:

- in-app, desktop, and extension shortcut defaults come from one shared catalog,
- migrated in-app shortcuts are resolved through explicit contexts,
- desktop and extension platform commands map to the same action ids used by the catalog,
- settings can show and edit effective shortcut bindings,
- diagnostics reports invalid shortcut config and platform registration failures,
- all migrated behavior is covered by focused tests,
- ordinary typing and accessibility activation are not regressed.

## Known Risks

- Breaking text input: mitigated by `event.isComposing`, editable-target guards, and keeping `Shift+Enter` default textarea behavior.
- Fighting browser defaults: mitigated by reserved shortcut validation and avoiding unmodified global printable shortcuts.
- Multiple overlays handling `Escape`: mitigated by explicit context priority and visible/open-only context registration.
- Extension/desktop drift: mitigated by shared catalog plus manifest parity and desktop adapter tests.
- Over-migration: mitigated by leaving ordinary accessibility handlers and non-product key handling local.

## Recommended First Implementation Step

Start with Track 38A. It gives Browserx a typed shortcut vocabulary, parser, resolver, display formatter, merge logic, and validation without changing runtime behavior. Then Track 38B can add the Svelte provider and migrate zoom as the first low-risk behavior change.
