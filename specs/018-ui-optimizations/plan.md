# Implementation Plan: UI Optimizations

**Branch**: `018-ui-optimizations` | **Date**: 2026-02-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-ui-optimizations/spec.md`

## Summary

Two targeted CSS/styling fixes: (1) widen the main conversation content container from 900px to 1200px, and (2) fix the Terminal Sandbox dropdown in Tools Settings so native `<option>` elements render correctly in the terminal (dark) theme by applying `color-scheme: dark` on the settings modal container.

## Technical Context

**Language/Version**: TypeScript (strict mode), Svelte 4, CSS
**Primary Dependencies**: Svelte 4, TailwindCSS 4
**Storage**: N/A (no data changes)
**Testing**: Vitest with jsdom
**Target Platform**: Chrome Extension (BrowserX) and Desktop (Pi) — both use the same sidepanel UI
**Project Type**: Web application (browser extension + desktop)
**Performance Goals**: N/A (CSS-only changes, no runtime impact)
**Constraints**: Must not regress ChatGPT (light) theme; must work in both extension and desktop modes
**Scale/Scope**: 2 files modified, ~3 lines of CSS changed

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Privacy-First Architecture | PASS | No data processing or network changes. Pure CSS. |
| II. Cross-Platform Parity | PASS | Both changes are in shared sidepanel code (`src/extension/sidepanel/`) used by both Extension and Desktop. No platform-specific code needed. |
| III. Secure Agent Execution | PASS | No tool execution or permission changes. |
| IV. Test-Verified Quality | PASS | Visual CSS changes. Existing tests should continue to pass. A visual regression test for the dropdown contrast can be added. |
| V. Modular Tool Design | PASS | No tool changes. |

All gates pass. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/018-ui-optimizations/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── spec.md              # Feature specification
└── checklists/
    └── requirements.md  # Quality checklist
```

### Source Code (files to modify)

```text
src/extension/sidepanel/
├── pages/chat/
│   └── Main.svelte           # Change 1: .content-container max-width 900px → 1200px
└── settings/
    └── ToolsSettings.svelte   # Change 2: Add color-scheme: dark to .form-select
```

**Structure Decision**: No new files or directories. Both changes are single-property CSS modifications in existing Svelte component `<style>` blocks.

## Complexity Tracking

No violations. No complexity justifications needed.
