# Implementation Plan: Agent Skills System

**Branch**: `028-agent-skills` | **Date**: 2026-02-18 | **Updated**: 2026-02-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/028-agent-skills/spec.md`

## Summary

Implement a cross-platform Agent Skills system following the Agent Skills open standard (agentskills.io). Users can create, manage, import, and export reusable skill instruction sets (SKILL.md format) that extend the agent's capabilities. Skills are invoked via `/skill-name` in the chat input (integrating with the existing CommandRegistry from 021-slash-commands) and optionally by LLM auto-invocation. Each skill has a configurable invocation mode (manual, auto, hybrid) with manual as the default. Desktop stores skills on filesystem; Chrome extension uses IndexedDB.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Svelte 4.2.20 (UI), Tailwind CSS 4.1.13, zod 3.23.8 (validation), `yaml` package (new — YAML parsing for SKILL.md frontmatter), @tauri-apps/api 2.10.1 (desktop filesystem)
**Storage**: IndexedDB via existing StorageProvider (extension), filesystem via Tauri `invoke()` (desktop)
**Testing**: Vitest 3.2.4, @testing-library/svelte 5.2.8
**Target Platform**: Chrome Extension (Manifest V3) + Tauri Desktop (Windows/Mac/Linux)
**Project Type**: Dual-mode (extension + desktop sharing core codebase)
**Performance Goals**: Skill discovery < 500ms for 50 skills; Level 1 metadata < 100 tokens per skill
**Constraints**: No project-scope concept (global skills only); skills < 50KB; imported skills untrusted by default; invocation mode defaults to manual
**Scale/Scope**: Up to 50 skills per user; single new settings page; 3 new core modules (SkillParser, SkillProvider, SkillRegistry)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is unconfigured (template placeholders only). No gates to enforce. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/028-agent-skills/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── internal-api.md  # Internal TypeScript interfaces
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── skills/                    # New — core skills system
│       ├── SkillParser.ts         # YAML frontmatter + markdown parsing
│       ├── SkillRegistry.ts       # Discovery, lookup, invocation, substitution, CommandRegistry integration
│       ├── SkillProvider.ts       # Abstract interface
│       └── types.ts               # Skill, SkillMeta, InvocationMode types + Zod schemas
├── extension/
│   ├── storage/
│   │   └── IndexedDBSkillProvider.ts   # New — extension skill storage
│   └── sidepanel/
│       ├── commands/
│       │   └── builtinCommands.ts      # Reference — existing built-in commands; skills appear alongside via shared CommandRegistry
│       └── settings/
│           └── SkillsSettings.svelte   # New — skill management UI with invocation mode toggle
├── desktop/
│   └── storage/
│       └── FilesystemSkillProvider.ts  # New — desktop skill storage
```

**Structure Decision**: Follows existing codebase patterns. Skills register with CommandRegistry (from 021-slash-commands) so they appear in the `/` dropdown alongside built-in commands. No separate UI for skill invocation — it uses the existing MessageInput command mode.

## Implementation Approach

### Phase 1: Foundation (Types, Parser, Provider Interface)

Core types and parser — blocking prerequisite for all user stories.
- Define `Skill`, `SkillMeta`, `InvocationMode` types with Zod validation
- Implement `SkillParser` (parse SKILL.md, validate, substitute variables, serialize)
- Define `ISkillProvider` interface

### Phase 2: User Story 1 — Create and Use Skills (P1 MVP)

Core value: create skills, discover them, invoke via `/skill-name`.
- Implement `IndexedDBSkillProvider` and `FilesystemSkillProvider`
- Implement `SkillRegistry` with `discover()`, `invoke()`, `registerCommands()`, `buildSkillsSystemPrompt()`
- **Key integration**: `SkillRegistry.registerCommands()` registers skills in CommandRegistry:
  - Skills in "manual" or "hybrid" mode → `commandRegistry.register({ name: skill.name, description: skill.description, action: (args) => skillRegistry.invoke(skill.name, args) })`
  - Skills in "auto" mode → NOT registered in CommandRegistry (hidden from `/` dropdown)
- **System prompt**: `buildSkillsSystemPrompt()` includes only skills in "auto" or "hybrid" mode that are trusted
- Integrate into `BrowserxAgent` at session start
- Basic `SkillsSettings.svelte` with create form
- Message types for UI ↔ background communication

### Phase 3: User Story 2 — Manage Skills (P2)

Extend settings UI with list, edit, delete, and invocation mode toggle.
- Skill list view with name, description, mode, trust status
- Skill detail/edit view
- **Invocation mode toggle**: Dropdown or radio buttons (manual / auto / hybrid) per skill
  - On mode change: re-register/unregister command in CommandRegistry, update system prompt
- Delete with confirmation

### Phase 4: User Story 3 — Import Skills (P3)

URL import with trust model.
- `importFromUrl()` — fetch, parse, validate, save with `source='imported'`, `trusted=false`, `invocationMode='manual'`
- Trust approval UI — untrusted skills can be `/`-invoked but not auto-invoked
- `trustSkill()` — enables auto-invocation if mode is auto/hybrid

### Phase 5: User Story 4 — Export Skills (P4)

Export as standard SKILL.md.
- Generate SKILL.md from skill data (standard-compliant, no non-standard fields)
- Download via Blob (extension) or Tauri save dialog (desktop)

### Phase 6: Polish

Edge cases, error handling, cross-cutting concerns.

## Key Design Decisions

### CommandRegistry Integration (R7)

Skills register as commands in the existing `CommandRegistry` — the same system that handles `/new`, `/help`, `/settings`. This means:
- **Zero UI changes** for the dropdown — skills automatically appear
- **Consistent UX** — users see skills alongside built-in commands when typing `/`
- **Clean separation** — `SkillRegistry` owns skill lifecycle; `CommandRegistry` owns the `/` UX
- When invocation mode changes, skills are registered/unregistered from CommandRegistry dynamically

### Invocation Mode (R8)

Stored on the Skill entity as `invocationMode: "manual" | "auto" | "hybrid"`:
- **manual** (default): Registered in CommandRegistry, NOT in system prompt
- **auto**: NOT in CommandRegistry, registered in system prompt (if trusted)
- **hybrid**: Both CommandRegistry AND system prompt

On desktop, `invocationMode` is stored in `.skill-meta.json` (not in SKILL.md) to keep the portable format standard-compliant.

## Complexity Tracking

No constitution violations to justify.
