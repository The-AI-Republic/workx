# Implementation Plan: Agent Skills System

**Branch**: `028-agent-skills` | **Date**: 2026-02-18 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/028-agent-skills/spec.md`

## Summary

Implement a cross-platform Agent Skills system following the Agent Skills open standard (agentskills.io). Users can create, manage, import, and export reusable skill instruction sets (SKILL.md format) that extend the agent's capabilities. Desktop stores skills on the filesystem (`~/.airepublic-pi/skills/`); Chrome extension stores skills in IndexedDB. A unified SkillProvider interface abstracts platform differences, and a SkillRegistry manages discovery, progressive loading, invocation (auto + manual), and variable substitution.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Svelte 4.2.20 (UI), Tailwind CSS 4.1.13, zod 3.23.8 (validation), `yaml` package (new — YAML parsing for SKILL.md frontmatter), @tauri-apps/api 2.10.1 (desktop filesystem)
**Storage**: IndexedDB via existing StorageProvider (extension), filesystem via Tauri `invoke()` (desktop)
**Testing**: Vitest 3.2.4, @testing-library/svelte 5.2.8
**Target Platform**: Chrome Extension (Manifest V3) + Tauri Desktop (Windows/Mac/Linux)
**Project Type**: Dual-mode (extension + desktop sharing core codebase)
**Performance Goals**: Skill discovery < 500ms for 50 skills; Level 1 metadata < 100 tokens per skill
**Constraints**: No project-scope concept (global skills only); skills < 50KB; imported skills untrusted by default
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
│       ├── SkillRegistry.ts       # Discovery, lookup, invocation, substitution
│       ├── SkillProvider.ts       # Abstract interface
│       └── types.ts               # Skill, SkillMeta, SkillProviderInterface types
├── extension/
│   ├── storage/
│   │   └── IndexedDBSkillProvider.ts   # New — extension skill storage
│   └── sidepanel/
│       └── settings/
│           └── SkillsSettings.svelte   # New — skill management UI
├── desktop/
│   └── storage/
│       └── FilesystemSkillProvider.ts  # New — desktop skill storage
└── tests/
    ├── contracts/
    │   └── skill-registry.test.ts      # New — registry contract tests
    └── unit/
        ├── skill-parser.test.ts        # New — parser unit tests
        └── skill-provider.test.ts      # New — provider unit tests
```

**Structure Decision**: Follows existing codebase patterns — core logic in `src/core/`, platform-specific implementations in `src/extension/` and `src/desktop/`, settings UI as a new Svelte component alongside existing settings pages, tests alongside existing test structure.

## Complexity Tracking

No constitution violations to justify.
