# Implementation Plan: LLM Settings Tool

**Branch**: `031-llm-settings-tool` | **Date**: 2026-02-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/031-llm-settings-tool/spec.md`

## Summary

Add a new `setting_tool` to the agent's registered tools that exposes allowlisted user settings (approval mode, tool toggles, trusted/blocked domains, theme, language, model selection) for reading and writing via LLM conversation. Access is gated by a hardcoded allowlist (security boundary) and write operations are blocked when operating in YOLO mode. The tool follows the existing BaseTool pattern and integrates with the ApprovalGate risk assessment pipeline.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Svelte 4, Vite 5, openai SDK, zod 3.23.8
**Storage**: chrome.storage.local (extension) / Tauri storage (desktop) via STORAGE_KEYS
**Testing**: Vitest 3.2.4 with @testing-library/svelte
**Target Platform**: Chrome Extension + Tauri Desktop (dual-mode)
**Project Type**: Single project with extension/desktop build targets
**Performance Goals**: Settings read < 2s, write + UI sync < 3s (per SC-001/SC-002)
**Constraints**: Must work in service worker context (extension) and main thread (desktop)
**Scale/Scope**: ~30 allowlisted settings, 5 new files, 2 modified files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is unconfigured (template placeholders only). No project-specific gates to enforce. Proceeding with standard best practices.

**Post-design re-check**: Design follows existing patterns (BaseTool, ToolRegistry, risk assessors). No violations.

## Project Structure

### Documentation (this feature)

```text
specs/031-llm-settings-tool/
├── plan.md              # This file
├── research.md          # Phase 0: Research decisions
├── data-model.md        # Phase 1: Entities and allowlist schema
├── quickstart.md        # Phase 1: Implementation guide
├── contracts/           # Phase 1: TypeScript interfaces
│   └── setting-tool-api.ts
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── tools/
│   ├── SettingTool.ts              # NEW: Main tool (extends BaseTool)
│   ├── settingsAllowlist.ts        # NEW: Allowlist constant + helpers
│   ├── index.ts                    # MODIFIED: Register SettingTool
│   └── __tests__/
│       ├── SettingTool.test.ts     # NEW: Tool unit tests
│       └── settingsAllowlist.test.ts # NEW: Allowlist validation tests
├── core/
│   └── approval/
│       └── assessors/
│           └── SettingToolRiskAssessor.ts  # NEW: Risk scorer
└── config/
    └── types.ts                    # MODIFIED: Add setting_tool to IToolsConfig (optional)
```

**Structure Decision**: Follows existing project structure. New tool files live alongside existing tools in `src/tools/`. Risk assessor follows the existing pattern in `src/core/approval/assessors/`. No new directories needed.

## Complexity Tracking

No constitution violations to justify. Design uses existing patterns without added complexity.
