# Implementation Plan: Tab Select Menu UX Improvements

**Branch**: `020-tab-select-ux` | **Date**: 2026-02-14 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/020-tab-select-ux/spec.md`

## Summary

Enhance the tab selection dropdown in the `TabContext` component with two UX improvements: (1) tooltips on dropdown items showing full tab titles on hover, and (2) a reactive "(current)" prefix marker on the browser's active tab. Both features use existing patterns — the `Tooltip` component and Chrome extension event listeners already in the component.

## Technical Context

**Language/Version**: TypeScript (existing project tsconfig.json), Svelte 4
**Primary Dependencies**: Tippy.js (via existing Tooltip component), Chrome Extension APIs (`chrome.tabs`)
**Storage**: N/A
**Testing**: Vitest + @testing-library/svelte (existing test setup)
**Target Platform**: Chrome Extension (side panel)
**Project Type**: Chrome extension with Svelte frontend
**Performance Goals**: "(current)" marker updates within 1 second of tab switch
**Constraints**: Must work in both terminal and chatgpt themes
**Scale/Scope**: Single component modification (`TabContext.svelte`) + i18n entries + test updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is not configured (template placeholders only). No gates to evaluate. Proceeding.

**Post-Phase 1 re-check**: No violations. Feature is a minimal UI enhancement touching one component.

## Project Structure

### Documentation (this feature)

```text
specs/020-tab-select-ux/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output - research decisions
├── data-model.md        # Phase 1 output - state model
├── quickstart.md        # Phase 1 output - implementation guide
├── contracts/
│   └── component-api.md # Phase 1 output - component API contract
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /rr.tasks)
```

### Source Code (repository root)

```text
src/extension/sidepanel/components/common/
├── TabContext.svelte     # PRIMARY: Add tooltip wrapping + activeTabId tracking + (current) prefix
└── Tooltip.svelte        # EXISTING: Reused as-is (no changes needed)

_locales/
├── en/messages.json      # Add "(current)" translation
├── en_GB/messages.json   # Add "(current)" translation
└── key_map.json          # Add key mapping

tests/unit/
└── TabContext.test.ts    # Add tooltip + (current) marker tests
```

**Structure Decision**: Single component modification within existing Chrome extension structure. No new files or directories in `src/`.

## Research Summary

All technical decisions resolved in [research.md](research.md):

| ID    | Decision                                        | Rationale                                     |
| ----- | ----------------------------------------------- | --------------------------------------------- |
| R-001 | Reuse existing Tooltip component (Tippy.js)     | Already imported, theme-aware, overflow-safe   |
| R-002 | Use `chrome.tabs.onActivated` for active tracking | Reactive, follows existing `onUpdated` pattern |
| R-003 | Use `$_t("(current)")` for i18n                 | Consistent with project i18n patterns          |
| R-004 | Tooltip `placement="right"` for dropdown items  | Avoids obscuring other list items              |
| R-005 | Local `activeTabId` variable (no store needed)  | Component-local state, no upstream changes     |

## Implementation Approach

### Change 1: Tooltip on Dropdown Items (FR-001, FR-002)

Wrap each dropdown item's content with the existing `<Tooltip>` component:
- Pass `content={tab.title || tab.url || 'Untitled'}` for full title display
- Use `placement="right"` to avoid list item overlap
- Apply to both regular tab items and "Create New Tab" option (for consistency)

### Change 2: Active Tab "(current)" Marker (FR-003 through FR-006)

Add active tab tracking to `TabContext.svelte`:
1. Add `activeTabId: number = -1` local state variable
2. On mount: query `chrome.tabs.query({ active: true, currentWindow: true })` to get initial active tab
3. Add `chrome.tabs.onActivated` listener to track changes reactively
4. In dropdown template: conditionally render `$_t("(current)")` prefix when `tab.id === activeTabId`
5. On destroy: remove `onActivated` listener (matching existing `onUpdated` cleanup pattern)

### Change 3: i18n Entries (FR-007)

Add "(current)" to locale files following existing key generation pattern.

### Change 4: Test Updates

Extend `TabContext.test.ts` with:
- Mock for `chrome.tabs.onActivated` (add/remove listener pattern)
- Tests for tooltip content on dropdown items
- Tests for "(current)" prefix rendering on active tab
- Test for reactivity when active tab changes
