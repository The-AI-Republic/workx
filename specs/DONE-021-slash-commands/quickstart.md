# Quickstart: Slash Command System

**Feature**: 021-slash-commands

## Overview

Add an extensible slash command system to the side panel input. Users type "/" into an empty input field to see available commands, filter by typing, and execute via keyboard or mouse.

## Files to Create

1. **`src/extension/sidepanel/commands/CommandRegistry.ts`** — Singleton registry with Map-based command storage, registration, lookup, and filtering.

2. **`src/extension/sidepanel/commands/builtinCommands.ts`** — Registration of `/new`, `/help`, `/settings` built-in commands.

3. **`src/extension/sidepanel/commands/index.ts`** — Public API: exports registry instance and initializes built-in commands.

4. **`src/extension/sidepanel/components/CommandDropdown.svelte`** — Dropdown UI showing filtered commands with keyboard/mouse navigation. Positioned above or below input adaptively.

5. **`src/extension/sidepanel/components/CommandError.svelte`** — Inline error message above input with 60s auto-dismiss.

## Files to Modify

1. **`src/extension/sidepanel/components/MessageInput.svelte`** — Add command detection on "/" in empty field, input parsing, command execution, dropdown/error rendering, keyboard interception for arrows/escape in command mode.

2. **`src/extension/sidepanel/pages/chat/Main.svelte`** — Handle new `commandOutput` and `openSettings` events from MessageInput. Create ProcessedEvent for /help output. Wire /settings to existing `toggleSettings()`.

## Key Integration Points

- **MessageInput.handleKeyDown**: Enhanced to detect "/" and intercept arrow keys/Escape when in command mode.
- **MessageInput.onSubmit flow**: Input starting with "/" is routed to command execution instead of sendMessage.
- **Main.svelte event listeners**: New `on:commandOutput` and `on:openSettings` handlers on the MessageInput component.
- **CommandRegistry**: Initialized once in the module. Imported by MessageInput for lookup and filtering.

## Testing

- **Unit tests**: `tests/unit/commands/CommandRegistry.test.ts` — registry CRUD, filtering, dedup, case-insensitivity.
- **Component tests**: `tests/sidepanel/CommandDropdown.test.ts` — rendering, keyboard nav, mouse interaction.
- **Component tests**: `tests/sidepanel/CommandError.test.ts` — display, auto-dismiss, dismiss-on-input.
- **Integration tests**: `tests/sidepanel/SlashCommand.integration.test.ts` — full flow from "/" keystroke to command execution.

## Build & Run

```bash
# Run tests
npm test

# Type check
npm run type-check

# Lint
npm run lint

# Build extension
npm run build:extension

# Build desktop
npm run build:desktop
```

## Architecture Diagram

```
User types "/" in empty input
       │
       ▼
MessageInput.svelte (command detection)
       │
       ├─► CommandRegistry.filter(query)
       │          │
       │          ▼
       │   CommandDropdown.svelte (renders filtered list)
       │          │
       │          ├─ Arrow keys: navigate
       │          ├─ Enter/Click: select
       │          └─ Escape: dismiss
       │
       ▼
CommandRegistry.get(name)
       │
       ├─ Found: command.action(args)
       │     ├─ /new  → onNewConversation()
       │     ├─ /help → dispatch('commandOutput', {...})
       │     └─ /settings → dispatch('openSettings')
       │
       └─ Not found: CommandError.svelte (60s auto-dismiss)
```
