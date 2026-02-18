# Research: Settings Search (019)

**Date**: 2026-02-14

## Decision 1: Fuzzy Search Library

**Decision**: Use Fuse.js v7.x

**Rationale**: Fuse.js provides fuzzy matching out of the box with built-in TypeScript types, ~5KB gzipped, framework-agnostic, and has the simplest API for our use case (50-60 item dataset). It supports weighted multi-key search and configurable thresholds.

**Alternatives considered**:
- FlexSearch: More performant for large datasets, but overkill for 50-60 items. More complex API.
- MiniSearch: Full-text search focused. Good but fuzzy matching is secondary.
- uFuzzy: Smaller (~2KB) but less mature, fewer community resources.
- microfuzz: Tiny but limited feature set, no weighted key support.

## Decision 2: Import Strategy

**Decision**: Static import (`import Fuse from 'fuse.js'`)

**Rationale**: The project uses static imports for all standard dependencies (svelte-spa-router, tippy.js, marked, zod, etc.). Dynamic imports are only used for platform-conditional code (Tauri API, OpenAI SDK). Fuse.js is always needed when the settings page loads, so dynamic import adds unnecessary complexity.

**Evidence**: Settings.svelte lines 8-18 use static imports for all settings-related modules.

## Decision 3: i18n Reactive Rebuild

**Decision**: Use Svelte `$:` reactive statement with `$_t()` derived store to auto-rebuild the Fuse index when locale changes.

**Rationale**: The i18n system already uses a `currentLocale` writable store and `_t` derived store. Any `$:` reactive statement referencing `$_t` will automatically re-run when locale changes. This is the established pattern used in GeneralSettings.svelte (line 31) for `themeOptions`.

**Evidence**: `src/extension/sidepanel/lib/i18n/index.ts` — `_t` is `derived(currentLocale, ...)`.

## Decision 4: Scroll-to-Item Mechanism

**Decision**: Use native `element.scrollIntoView({ behavior: 'smooth', block: 'center' })` with a CSS animation for highlighting.

**Rationale**: The codebase already uses `scrollIntoView` with smooth behavior in DomService.ts. Native API is well-supported, requires no additional dependencies. Using `block: 'center'` ensures the target item is centered in the viewport for best visibility.

**Alternatives considered**:
- Custom scroll calculation: Unnecessary complexity when native API works.
- Third-party scroll library: No benefit for this simple use case.

## Decision 5: Element Targeting for Scroll-to

**Decision**: Use existing HTML `id` attributes on form elements, and add `data-setting-id` attributes on settings card wrapper divs where no suitable ID exists.

**Rationale**: Many settings elements already have `id` attributes (e.g., `tool-timeout`, `cache-ttl`, `language`, `execution-mode`). For checkbox-based settings that lack IDs, we add `data-setting-id` on the parent `.form-group` or `.settings-card` div. This avoids modifying existing IDs while providing a consistent targeting mechanism.

**Existing IDs found**:
- ModelSettings: `api-key`, `service-tier`
- GeneralSettings: `language`, `maxSessions`
- ToolsSettings: `tool-timeout`, `sandbox-mode`, `execution-mode`, `workspace-access`, `network-mode`
- StorageSettings: `cache-ttl`, `cache-maxsize`, `rollout-ttl-unit`, `rollout-ttl-value`
- ExtensionSettings: `update-channel`, `storage-quota`, `allowed-origins`
- MCPSettings: `server-name`, `server-url`, `server-apikey`, `server-timeout`

## Decision 6: Search Results Display

**Decision**: Replace category cards grid with inline results list while query is active.

**Rationale**: Confirmed in clarification session. Side panel has constrained width making overlay dropdowns awkward. Replacing the grid is cleaner, follows VS Code and macOS System Settings pattern.

## Decision 7: Navigation Event Extension

**Decision**: Extend the `categorySelected` event payload to include an optional `scrollToId` field, and add a `highlightSettingId` prop to all settings sub-pages.

**Rationale**: The current event only carries `{ categoryId: string }`. Adding `scrollToId` is backward-compatible (existing handlers ignore it). Settings sub-pages receive the ID as a prop, use `onMount` + `tick()` to scroll after the DOM renders.

**Evidence**: Settings.svelte line 92-94 (`handleCategorySelected`), SettingsMenu.svelte line 5-7 (event type).

## Decision 8: Highlight Animation

**Decision**: CSS `@keyframes` animation that briefly pulses the background color of the target element using the existing `--browserx-primary` CSS variable.

**Rationale**: No existing highlight animation pattern exists in the codebase. A simple background pulse (2 cycles over 1.5s) is non-intrusive, theme-aware via CSS variables, and requires no JS animation library.

## Decision 9: Debounce Strategy

**Decision**: 150ms debounce on search input, implemented with a simple `setTimeout`/`clearTimeout` pattern.

**Rationale**: With a 50-60 item Fuse.js index, search is effectively instant (<1ms), so debouncing is mainly to avoid unnecessary reactive rerenders. 150ms is the sweet spot between responsiveness and efficiency. No need for a debounce utility library.

## Decision 10: Settings Registry Architecture

**Decision**: Create a centralized `settingsSearchRegistry.ts` file that defines all searchable settings items as a typed array. Each entry maps a setting to its label i18n key, description i18n key, section, navigation target, and element ID for scroll-to.

**Rationale**: A static registry is simpler and more maintainable than scraping the DOM or extracting settings dynamically from components. New settings added to sub-pages must also be added to the registry — this is an acceptable tradeoff for a dataset that changes infrequently. The registry also serves as documentation of all settings.

**Alternatives considered**:
- Dynamic DOM scraping: Brittle, would require all sub-pages to render simultaneously.
- Decorator/annotation pattern: Over-engineered for Svelte components.
- Extract from config types: Config types don't contain UI labels/descriptions.
