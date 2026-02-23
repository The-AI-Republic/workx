# Implementation Plan: Settings Search

**Branch**: `019-settings-search` | **Date**: 2026-02-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/019-settings-search/spec.md`

## Summary

Add a Fuse.js-powered search bar to the Settings menu page that lets users fuzzy-search across all ~55 settings items in 6 sections and navigate directly to the matched setting with auto-scroll and highlight. The search results replace the category cards grid while a query is active. Implementation involves 1 new dependency (fuse.js), 2 new files (search registry + search component), and modifications to 8 existing files (Settings.svelte, SettingsMenu.svelte, and all 6 settings sub-pages).

## Technical Context

**Language/Version**: TypeScript 5.9.2 (strict mode, ES2020 target) + Svelte 4.2.20
**Primary Dependencies**: Svelte 4, fuse.js ^7.0.0 (new), existing i18n system (`_t` derived store)
**Storage**: N/A (in-memory search index, no persistence)
**Testing**: Manual testing + `npm run build` + `npx tsc --noEmit` + `npm run lint`
**Target Platform**: Chrome extension side panel (browser) + Tauri desktop app
**Project Type**: Browser extension with Tauri desktop wrapper
**Performance Goals**: Search results within 100ms of typing (trivially met with 50-60 item dataset)
**Constraints**: Side panel constrained width (~350-400px), must work in both terminal and chat themes
**Scale/Scope**: ~55 searchable settings items across 6 sections

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution file is an unconfigured template — no project-specific gates defined. Gate passes by default.

**Post-Phase 1 re-check**: No violations. Feature adds 1 small dependency (fuse.js ~5KB), 2 new files, modifies 8 existing files. No new patterns or architectural changes introduced — follows existing Svelte component, event dispatch, and CSS variable patterns.

## Project Structure

### Documentation (this feature)

```text
specs/019-settings-search/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research decisions
├── data-model.md        # Phase 1 data model
├── quickstart.md        # Phase 1 quickstart guide
├── contracts/
│   └── component-api.md # Component interface contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/extension/sidepanel/
├── Settings.svelte                              # MODIFY: add highlightSettingId state + prop passing
├── settings/
│   ├── settingsSearchRegistry.ts                # NEW: centralized registry of all searchable items
│   ├── components/
│   │   ├── SettingsMenu.svelte                  # MODIFY: integrate SettingsSearch, extend event
│   │   └── SettingsSearch.svelte                # NEW: search bar + results list component
│   ├── ModelSettings.svelte                     # MODIFY: add highlightSettingId prop + scroll/highlight
│   ├── GeneralSettings.svelte                   # MODIFY: add highlightSettingId prop + scroll/highlight
│   ├── StorageSettings.svelte                   # MODIFY: add highlightSettingId prop + scroll/highlight
│   ├── ToolsSettings.svelte                     # MODIFY: add highlightSettingId prop + scroll/highlight
│   ├── MCPSettings.svelte                       # MODIFY: add highlightSettingId prop + scroll/highlight
│   └── ExtensionSettings.svelte                 # MODIFY: add highlightSettingId prop + scroll/highlight
```

**Structure Decision**: This feature follows the existing project structure. All new files go in the existing `src/extension/sidepanel/settings/` directory hierarchy. No new directories needed beyond what already exists.

## Complexity Tracking

No constitution violations to justify. Feature is straightforward:
- 1 new npm dependency (fuse.js)
- 2 new files (registry + component)
- 8 modified files (all within existing settings module)
- No new architectural patterns — uses existing Svelte stores, event dispatch, CSS variables
