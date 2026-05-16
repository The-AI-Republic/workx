# Track 044: Keyboard Shortcut System

**Date**: 2026-05-16
**Scope**: Browserx webfront, Chrome extension commands, and Tauri desktop hotkeys
**Reference**: `/home/rich/dev/study/claudy/src/keybindings`

## Summary

Both codebases support keyboard shortcuts today, but they do it at different maturity levels.

`claudy` has a first-class keybinding subsystem. It models shortcuts as configurable action mappings, resolves them through active UI contexts, supports multi-key chords, validates user config, and lets UI hints show the configured shortcut.

`browserx` supports shortcuts, but they are fragmented:

- Chrome extension commands are declared in `manifest.json` and handled by `chrome.commands`.
- Tauri desktop global hotkeys are registered in `src/desktop/hotkeys.ts`.
- In-app shortcuts are hardcoded in Svelte handlers such as message submit, slash-command navigation, modal escape handling, zoom, tab accessibility, and model picker dismissal.

The main improvement opportunity is not to copy `claudy` wholesale. Browserx is DOM, extension, and desktop based, not Ink/terminal based. The useful lesson is to centralize key-to-action resolution while keeping action handlers local to the owning UI.

## Current Browserx Support

Browserx currently supports three shortcut surfaces.

### Extension-level commands

Defined in both root `manifest.json` and `src/extension/manifest.json`:

- `Alt+Shift+C`: `toggle-sidepanel`
- `Alt+Shift+Q`: `quick-action`

The background service worker listens through `chrome.commands.onCommand` and dispatches `toggle-sidepanel` or `quick-action` in `src/extension/background/service-worker.ts`.

Strengths:

- Works when the extension is active enough for Chrome command dispatch.
- Uses the browser-native command surface.

Gaps:

- Chrome users can change extension shortcuts outside the app, so the app cannot reliably display the actual assigned key without querying Chrome APIs where available.
- These commands are not connected to any shared Browserx action registry.
- No collision analysis with in-app shortcuts.

### Desktop global hotkeys

`src/desktop/hotkeys.ts` uses `@tauri-apps/plugin-global-shortcut` and registers:

- `CommandOrControl+Shift+B`: toggle window
- `CommandOrControl+Shift+I`: focus input
- `CommandOrControl+Shift+K`: quick action

Strengths:

- Clear small module.
- Tracks registered shortcuts and unregisters them.
- Emits UI events (`applepi:focus-input`, `applepi:quick-action`) instead of reaching into components directly.

Gaps:

- Defaults are hardcoded and not backed by a shared definition.
- No user config, validation, or reserved-key policy.
- No display helper for settings/help UI.
- No parity mapping to Chrome extension commands.

### In-app Svelte shortcuts

Examples:

- `src/webfront/App.svelte`: `Ctrl/Cmd +/-/0` zoom.
- `src/webfront/components/MessageInput.svelte`: `Enter` submit, `Shift+Enter` newline, slash-command dropdown navigation with arrows, `Escape`, and `Enter`.
- Modal components use `Escape` through local `svelte:window` handlers.
- Buttons and tabs use `Enter`/`Space` for accessibility.

Strengths:

- Behavior is close to the owning component and easy to understand in isolation.
- Native form and accessibility handlers are mostly simple.

Gaps:

- No central list of shortcuts.
- No way to show a complete shortcut help screen.
- No user customization.
- Context precedence is implicit and can become fragile as overlays grow.
- Window-level `Escape` listeners can conflict when multiple modals or popups are mounted.

## Claudy Findings

`claudy` treats keybindings as a platform-level product surface.

### Default bindings are action mappings

`defaultBindings.ts` defines blocks by context, for example `Global`, `Chat`, `Autocomplete`, `Settings`, `Confirmation`, `Tabs`, and `Transcript`. Each block maps keystroke strings to action IDs like `chat:submit`, `settings:search`, or `app:toggleTranscript`.

Important idea for Browserx: action IDs are stable product contracts. Components register what action they can handle; shortcut definitions decide which keys trigger those actions.

### Handlers stay local

`useKeybinding.ts` registers a handler for an action and context. The handler remains in the owning component, while the binding comes from config. This avoids a giant global switch statement.

Important idea for Browserx: implement a Svelte action/hook equivalent, such as `useShortcut(action, handler, { context, active })`, where the component owns side effects.

### Contexts provide precedence

`KeybindingContext.tsx` tracks active contexts and resolves against those contexts before `Global`. This is what lets `Escape` mean "dismiss autocomplete", "close modal", or "cancel chat" depending on state.

Important idea for Browserx: overlays, command mode, settings, chat input, model picker, scheduler dialogs, and global app shortcuts need explicit context priority.

### Chords are supported, but should be staged

`resolver.ts` supports chord sequences such as `ctrl+x ctrl+k`. `KeybindingProviderSetup.tsx` adds a global chord interceptor with a 1 second timeout so the second key does not leak into the input field.

Important idea for Browserx: design the resolver to support chords, but do not expose chords in Browserx v1 unless there is a clear use case. Browser DOM input has different pitfalls from terminal input.

### User config is merged and validated

`loadUserBindings.ts` loads defaults first, then user bindings. Later entries win. It validates shape, duplicate keys, invalid contexts, invalid actions, reserved shortcuts, and config parse failures.

Important idea for Browserx: a user-editable shortcut settings surface should be backed by validation before it is wired to global desktop registration.

### Shortcut display is dynamic

`shortcutFormat.ts` and `useShortcutDisplay.ts` let UI hints show the configured binding with fallback logging.

Important idea for Browserx: every visible shortcut hint should render from the same registry that handles the shortcut.

## Key Differences

| Area | Claudy | Browserx today |
| --- | --- | --- |
| Runtime | Terminal/Ink React | Svelte DOM, Chrome extension, Tauri desktop |
| Model | Key -> action -> local handler | Mostly key -> local handler |
| Contexts | Explicit and centralized | Implicit in component mount/focus |
| Chords | Supported with timeout/interceptor | Not supported |
| User config | `~/.claude/keybindings.json`, gated, hot reload | No shortcut config |
| Validation | Duplicate, reserved, invalid context/action | None beyond platform registration failure |
| Display hints | Config-aware | Hardcoded or absent |
| Global shortcuts | Terminal app-level | Chrome commands plus Tauri global shortcuts |

## Design Principles For Browserx

1. Keep platform shortcuts and in-app shortcuts separate, but driven by one catalog.
2. Use action IDs as the stable API, not DOM key strings.
3. Keep handlers in components/services, not in a global switch.
4. Make context priority explicit.
5. Preserve native accessibility handlers for buttons, tabs, and controls.
6. Treat global OS/browser shortcuts as privileged: validate, reserve, and fail gracefully.
7. Add user customization only after defaults, resolver, and diagnostics are stable.

## Proposed Architecture

### New module

```text
src/webfront/shortcuts/
|-- actions.ts              # action IDs, contexts, metadata
|-- defaultBindings.ts      # platform-aware defaults
|-- parser.ts               # DOM/Tauri/Chrome shortcut normalization
|-- resolver.ts             # pure key event + context -> action
|-- registry.ts             # active handlers, contexts, lookup
|-- shortcutStore.ts        # Svelte store for bindings and warnings
|-- useShortcut.ts          # Svelte helper/action for components
|-- display.ts              # shortcut display formatting
`-- validate.ts             # conflicts, reserved shortcuts, unknown actions
```

The module should be framework-light. `parser.ts`, `resolver.ts`, `display.ts`, and `validate.ts` should be pure TypeScript and unit tested. Svelte-specific logic belongs only in `shortcutStore.ts` and `useShortcut.ts`.

### Shortcut catalog

Start with a curated v1 catalog:

```ts
type ShortcutContext =
  | 'Global'
  | 'Chat'
  | 'CommandPalette'
  | 'SlashCommand'
  | 'Modal'
  | 'Settings'
  | 'ModelPicker'
  | 'Scheduler'
  | 'DesktopGlobal'
  | 'ExtensionCommand';

type ShortcutAction =
  | 'app:zoomIn'
  | 'app:zoomOut'
  | 'app:zoomReset'
  | 'app:focusInput'
  | 'app:quickAction'
  | 'app:toggleWindow'
  | 'chat:submit'
  | 'chat:newline'
  | 'slash:next'
  | 'slash:previous'
  | 'slash:accept'
  | 'slash:dismiss'
  | 'modal:dismiss'
  | 'modelPicker:dismiss'
  | 'scheduler:dismiss';
```

Do not include button accessibility actions like `Enter`/`Space` for ordinary clickable controls. Those should remain native/local because they are accessibility semantics, not user-configurable app shortcuts.

### Binding shape

Use a JSON-compatible shape similar to `claudy`, with Browserx-specific platform scopes:

```json
{
  "bindings": [
    {
      "context": "Global",
      "bindings": {
        "mod+=": "app:zoomIn",
        "mod+-": "app:zoomOut",
        "mod+0": "app:zoomReset"
      }
    },
    {
      "context": "Chat",
      "bindings": {
        "enter": "chat:submit",
        "shift+enter": "chat:newline"
      }
    },
    {
      "context": "SlashCommand",
      "bindings": {
        "down": "slash:next",
        "up": "slash:previous",
        "enter": "slash:accept",
        "escape": "slash:dismiss"
      }
    },
    {
      "context": "DesktopGlobal",
      "bindings": {
        "mod+shift+b": "app:toggleWindow",
        "mod+shift+i": "app:focusInput",
        "mod+shift+k": "app:quickAction"
      }
    },
    {
      "context": "ExtensionCommand",
      "bindings": {
        "alt+shift+c": "app:toggleWindow",
        "alt+shift+q": "app:quickAction"
      }
    }
  ]
}
```

`mod` should normalize to `Meta` on macOS and `Ctrl` on Windows/Linux for in-app and desktop bindings. Chrome extension manifests still need concrete suggested keys.

### Runtime flow

1. Load default bindings into a Svelte shortcut store.
2. Components register active contexts when mounted/open/focused.
3. Components register handlers for action IDs.
4. A root-level DOM `keydown` listener resolves global and active-context shortcuts first.
5. Component-level input handlers can either move to `useShortcut` or call `resolveShortcut(event, contexts)`.
6. When a shortcut matches, call the first active handler and stop propagation if consumed.
7. For Tauri desktop global shortcuts, generate registrations from `DesktopGlobal` bindings and keep the current event bridge to the UI.
8. For Chrome extension commands, keep manifest declarations but map command names to the same action IDs in the service worker.

## Implementation Tracks

### Track 044A: Inventory and defaults

Create the shortcut catalog, default binding blocks, parser, display formatter, and resolver tests. No behavior changes yet.

Acceptance criteria:

- Unit tests cover parsing `mod`, arrows, escape, enter, shift+enter, plus/minus/zero.
- Resolver can pick the highest-priority active context.
- A generated inventory lists current Browserx shortcuts and their owner file.

### Track 044B: In-app registry and Svelte integration

Add `shortcutStore`, a root provider/listener in `App.svelte`, and a Svelte helper for registering handlers and contexts. Migrate only low-risk shortcuts first:

- Zoom shortcuts from `App.svelte`.
- Slash-command dropdown navigation in `MessageInput.svelte`.
- Model picker and modal `Escape` handling where a single overlay owns the context.

Acceptance criteria:

- Existing keyboard tests still pass.
- New tests prove `SlashCommand` context wins over `Chat` for `ArrowUp`, `ArrowDown`, `Enter`, and `Escape`.
- `Shift+Enter` still inserts a newline in chat.

### Track 044C: Platform globals

Connect desktop and extension global shortcuts to the shared action catalog.

Desktop:

- Replace hardcoded `DEFAULT_HOTKEYS` with generated `DesktopGlobal` defaults.
- Keep `registerHotkey`, `unregisterHotkey`, and failure logging.
- Add conflict reporting when Tauri says a global shortcut is already registered.

Extension:

- Keep manifest `commands`, but introduce a command-name to action-ID map in the service worker.
- Add a small diagnostic that compares manifest defaults to the shortcut catalog.

Acceptance criteria:

- Desktop global shortcuts still register and dispatch `app:toggleWindow`, `app:focusInput`, and `app:quickAction`.
- Extension commands still open side panel and quick action.
- Tests cover command-name to action-ID mapping without Chrome runtime.

### Track 044D: Settings, validation, and help UI

Add a read-only keyboard shortcuts settings/help view first. Then add editable user overrides if product wants customization.

Validation should cover:

- Unknown context.
- Unknown action.
- Duplicate key in same context.
- Duplicate action with ambiguous display.
- Reserved browser/OS shortcuts.
- Platform unsupported shortcuts.
- Global shortcut registration failure.

Acceptance criteria:

- `/doctor` or diagnostics can report shortcut config issues.
- UI shortcut hints read from the same display helper as the resolver.
- User overrides can be reset to defaults.

### Track 044E: Optional chords

Only add chords after the single-keystroke system is stable.

Browserx should initially avoid text-producing chord prefixes inside focused textareas unless there is an interceptor that prevents leakage into input. `claudy` solved this with an early chord interceptor; Browserx would need equivalent DOM capture-phase handling plus careful IME/composition handling.

Acceptance criteria:

- Chord prefixes do not type into the message input.
- Chords timeout and cancel predictably.
- IME composition events are ignored by the shortcut resolver.

## Risks And Mitigations

- **Risk: Breaking text input.** Mitigate by skipping global in-app shortcut resolution during `event.isComposing`, and by requiring context ownership for textarea shortcuts.
- **Risk: Fighting browser defaults.** Mitigate with a reserved shortcut list and avoid intercepting common browser navigation/editing shortcuts unless the user is inside a known app context.
- **Risk: Extension and desktop drift.** Mitigate by deriving both from the same action catalog and adding tests that compare manifest command names to catalog metadata.
- **Risk: Too much migration at once.** Mitigate by migrating zoom and slash-command navigation first, leaving accessibility key handlers local.

## Recommended Next Step

Implement Track 044A first. It is pure TypeScript plus tests and gives Browserx a shortcut vocabulary without changing behavior. After that, Track 044B can migrate the highest-value in-app shortcuts while preserving current UX.
