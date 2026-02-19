# Data Model: Slash Command System

**Feature**: 021-slash-commands
**Date**: 2026-02-16

## Entities

### Command

Represents a registered slash command available to the user.

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| name | string | Yes | Unique identifier, stored lowercase (e.g., "new", "help"). Used for lookup and display. |
| description | string | Yes | Human-readable explanation shown in dropdown (e.g., "Reset the current conversation"). |
| argumentHint | string | No | Describes expected argument input (e.g., "[query]", "[issue-number]"). Shown in dropdown. |
| action | (args?: string) => void \| Promise\<void\> | Yes | Function executed when command is invoked. Receives optional raw argument string. |

**Identity**: Commands are uniquely identified by `name` (case-insensitive, stored as lowercase).

**Validation rules**:
- `name` must be non-empty, contain only alphanumeric characters and hyphens
- `name` is normalized to lowercase on registration
- `description` must be non-empty
- `action` must be a callable function
- Duplicate names are rejected at registration time

### CommandRegistry (Singleton)

Centralized collection of all registered commands.

| Field | Type | Description |
| ----- | ---- | ----------- |
| commands | Map\<string, Command\> | Lowercase name → Command mapping for O(1) lookup |

**Operations**:
- `register(command: Command)`: Add a command. Throws if name already exists.
- `get(name: string)`: Lookup by name (case-insensitive). Returns Command or undefined.
- `getAll()`: Returns all registered commands as an array.
- `filter(query: string)`: Returns commands matching query by name prefix or description substring (case-insensitive). Name-prefix matches sorted before description-substring matches.

**Lifecycle**: Created once at application initialization. Commands registered during module load. No runtime unregistration needed for v1.

### CommandInput State (Component-local)

Transient state managed within MessageInput.svelte during command interaction.

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| isCommandMode | boolean | false | True when input starts with "/" and field was empty before typing |
| filterText | string | "" | Text after "/" used for filtering (e.g., "he" from "/he") |
| showDropdown | boolean | false | Controls dropdown visibility |
| selectedIndex | number | 0 | Currently highlighted command in dropdown (0-based) |
| filteredCommands | Command[] | [] | Commands matching current filterText |
| errorMessage | string \| null | null | Current error message to display, null if none |
| errorTimeout | number \| null | null | Timer ID for auto-dismiss of error message |
| lastExecuted | Map\<string, number\> | new Map() | Command name → timestamp for debounce tracking |

**State transitions**:
1. **Idle → Command Mode**: User types "/" into empty field. `isCommandMode=true`, `showDropdown=true`, `filterText=""`, `filteredCommands=getAll()`.
2. **Command Mode → Filtering**: User types after "/". `filterText` updated, `filteredCommands` recalculated, `selectedIndex` reset to 0.
3. **Command Mode → Execute**: User presses Enter or clicks command. Command action invoked. All state reset to idle.
4. **Command Mode → Cancel**: User presses Escape or deletes "/". All state reset to idle.
5. **Command Mode → Error**: User submits unrecognized command. `errorMessage` set, `errorTimeout` started. Input state reset to idle.
6. **Error → Idle**: Error auto-dismisses (60s timeout) or user starts typing.

## Relationships

```
CommandRegistry (singleton)
  └── contains 1..* Command
        └── has 1 action function

MessageInput (component)
  └── reads from CommandRegistry
  └── manages CommandInput State (local)
  └── renders CommandDropdown (child)
  └── renders CommandError (child)
```

## No Persistent Storage

All data is in-memory. The command registry is populated at module initialization and lives for the application session. No IndexedDB, localStorage, or Chrome storage is used by this feature.
