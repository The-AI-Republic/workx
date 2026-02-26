# Implementation Plan: Unify CSS Styling with Tailwind

**Branch**: `001-unify-css-tailwind` | **Date**: 2026-02-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-unify-css-tailwind/spec.md`

## Summary

Migrate all native CSS in ~46 Svelte components to Tailwind CSS v4 utility classes, replace the CSS custom property theming system (44 variables in `sidepanel.css`) with Tailwind `dark:` prefix utilities using named color tokens, enforce a minimum font size of 14px (`text-sm`) across the entire UI, and consolidate the dual CSS entry points (`styles.css` + `sidepanel.css`) into a single Tailwind v4 `@theme`-based stylesheet.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (target: ES2020) + Svelte 4.2.20
**Primary Dependencies**: Tailwind CSS v4.1.13, @tailwindcss/postcss v4.1.13, PostCSS, Vite 5.4.20
**Storage**: N/A (no data persistence changes)
**Testing**: Vitest 3.2.4 (jsdom environment), 11 test files with CSS class assertions
**Target Platform**: Chrome Extension (Manifest V3) + Tauri Desktop
**Project Type**: Single project — Chrome extension with Svelte UI
**Performance Goals**: No rendering regressions; identical visual output post-migration
**Constraints**: Must preserve existing theme switching behavior (terminal/chatgpt store); terminal theme must not respond to OS dark/light preference
**Scale/Scope**: ~46 components with `<style>` blocks, ~44 CSS custom properties to replace, ~100+ font-size instances to update, 11 test files to update

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is a template with no project-specific principles defined. No gates to evaluate. Proceeding.

**Post-Phase 1 re-check**: No violations. Feature is a styling refactor with no architectural changes.

## Project Structure

### Documentation (this feature)

```text
specs/001-unify-css-tailwind/
├── plan.md              # This file
├── research.md          # Phase 0: Research findings (8 decisions)
├── data-model.md        # Phase 1: CSS token mapping (replaces traditional data model)
├── quickstart.md        # Phase 1: Developer migration guide
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── webfront/
│   ├── styles.css                    # MODIFY: Consolidate @theme tokens, remove sidepanel.css content
│   ├── sidepanel.css                 # DELETE: Merge into styles.css
│   ├── components/
│   │   ├── TerminalMessage.svelte    # MODIFY: Wave 2 (medium)
│   │   ├── TerminalContainer.svelte  # MODIFY: Wave 2 (medium)
│   │   ├── TerminalInput.svelte      # MODIFY: Wave 1 (simple)
│   │   ├── MessageInput.svelte       # MODIFY: Wave 3 (complex, 102 rules)
│   │   ├── MessageDisplay.svelte     # MODIFY: Wave 3 (complex, 65 rules, :global)
│   │   ├── CommandDropdown.svelte    # MODIFY: Wave 2 (medium, :global)
│   │   ├── CommandError.svelte       # MODIFY: Wave 2 (medium, animation)
│   │   ├── common/
│   │   │   ├── Tooltip.svelte        # MODIFY: Wave 3 (complex, :global, pseudo-elements)
│   │   │   ├── PopupCard.svelte      # MODIFY: Wave 3 (complex, animation)
│   │   │   ├── Switch.svelte         # MODIFY: Wave 2 (medium, :global(.dark))
│   │   │   ├── UserLoginStatus.svelte # MODIFY: Wave 3 (complex, 62 rules)
│   │   │   ├── ApprovalModeIndicator.svelte # MODIFY: Wave 2 (medium)
│   │   │   └── TabContext.svelte     # MODIFY: Wave 1 (simple)
│   │   ├── chat/
│   │   │   ├── ChatHistoryList.svelte  # MODIFY: Wave 3 (complex, 57 rules)
│   │   │   ├── ChatHistoryPopup.svelte # MODIFY: Wave 2 (medium)
│   │   │   └── ModelSelection.svelte   # MODIFY: Wave 3 (complex, 87 rules)
│   │   ├── event_display/
│   │   │   ├── EventDisplay.svelte   # MODIFY: Wave 3 (complex, 53 rules)
│   │   │   ├── MessageEvent.svelte   # MODIFY: Wave 3 (complex, 54 rules, :global)
│   │   │   └── TaskEvent.svelte      # MODIFY: Wave 2 (medium)
│   │   ├── layout/
│   │   │   ├── FooterBar.svelte      # MODIFY: Wave 2 (medium)
│   │   │   └── footbar/Credits.svelte # MODIFY: Wave 3 (complex, 67 rules)
│   │   └── scheduler/
│   │       ├── SchedulerPopup.svelte     # MODIFY: Wave 3 (complex, 317 rules — LARGEST)
│   │       ├── ScheduleTaskModal.svelte  # MODIFY: Wave 3 (complex, 128 rules)
│   │       ├── SchedulerTaskItem.svelte  # MODIFY: Wave 3 (complex, 80 rules)
│   │       ├── SchedulerButton.svelte    # MODIFY: Wave 3 (complex, 31 rules)
│   │       └── ArchivedTasksView.svelte  # MODIFY: Wave 3 (complex, 58 rules)
│   ├── pages/
│   │   ├── chat/Main.svelte          # MODIFY: Wave 3 (complex, uses many CSS vars)
│   │   ├── scheduler/Scheduler.svelte # MODIFY: Wave 2 (medium)
│   │   └── skills/Skills.svelte      # MODIFY: Wave 2 (medium)
│   ├── settings/
│   │   ├── GeneralSettings.svelte    # MODIFY: Wave 3 (complex, theme preview styling)
│   │   └── ToolsSettings.svelte      # MODIFY: Wave 2 (medium)
│   └── stores/
│       └── themeStore.ts             # NO CHANGE: Store logic stays as-is
├── desktop/
│   └── ui/desktop.css                # MODIFY: Migrate to Tailwind utilities
├── tests/
│   ├── theme-integration.test.ts     # MODIFY: Update CSS class assertions
│   ├── terminal-container.test.ts    # MODIFY: Update CSS class assertions
│   ├── terminal-message.test.ts      # MODIFY: Update CSS class assertions
│   ├── terminal-input.test.ts        # MODIFY: Update CSS class assertions
│   └── accessibility.test.ts         # MODIFY: Verify contrast ratios still pass
└── webfront/
    ├── __tests__/styles.test.ts              # MODIFY: Update @theme assertions
    ├── __tests__/userMessages.visual.test.ts # MODIFY: Update class assertions
    ├── __tests__/inputOutline.visual.test.ts # MODIFY: Update style assertions
    └── components/__tests__/
        ├── TerminalMessage.test.ts   # MODIFY: Update class assertions
        ├── TerminalInput.test.ts     # MODIFY: Update CSS variable assertions
        └── MessageInput.test.ts      # MODIFY: Update selector assertions

tailwind.config.mjs                   # DELETE: Consolidate into styles.css @theme
postcss.config.mjs                    # NO CHANGE
```

**Structure Decision**: Existing single-project structure. All changes are in-place modifications to existing files. Two files deleted (`sidepanel.css`, `tailwind.config.mjs`), no new source files created.

## Migration Strategy

### Phase 1: Foundation (CSS Infrastructure)

1. **Consolidate Tailwind config**: Merge `tailwind.config.mjs` color/font definitions into `styles.css` `@theme` block, then delete the config file.
2. **Define chatgpt theme tokens**: Add all 44 light/dark color pairs as named Tailwind tokens in `@theme` (e.g., `--color-chat-bg: #ffffff`, `--color-chat-bg-dark: #212121`).
3. **Merge sidepanel.css**: Move global styles (body, scrollbar, `#app`) into `styles.css`, remove all CSS custom property definitions, delete `sidepanel.css`.
4. **Update HTML entry points**: Ensure only `styles.css` is imported (remove `sidepanel.css` imports).

### Phase 2: Component Migration (3 Waves)

**Wave 1 — Simple components** (11 components):
Components with no `<style>` blocks or minimal rules. Primarily verify existing Tailwind usage and fix any font sizes below `text-sm`.

**Wave 2 — Medium components** (10 components):
Components with 6-15 CSS rules and theme-conditional styles. Convert scoped CSS to Tailwind utilities, replace `var(--chat-*)` references with named color tokens + `dark:` variants, replace hardcoded terminal hex colors with `term-*` token classes.

**Wave 3 — Complex components** (15 components):
Components with 16+ CSS rules, animations, `:global()` selectors, or pseudo-elements. Convert convertible properties to Tailwind, retain keyframes/animations/`:global()` in minimal `<style>` blocks, apply `dark:` variants for all chatgpt theme colors.

### Phase 3: Font Size Normalization

After utility migration is complete, sweep all components for any remaining font size below 14px:
- Replace `text-xs` → `text-sm`
- Replace `font-size: 10px/11px/12px/0.75rem/0.7rem` → `text-sm`
- Adjust container sizing where larger text causes overflow

### Phase 4: Test Updates

Update all 11 test files to align with new class names and removed CSS variables. Ensure all tests pass.

### Phase 5: Verification

- Visual inspection of all major views in both themes (terminal, chatgpt) and both modes (light, dark)
- Run full test suite
- Verify no `<style>` blocks remain except for animations/`:global()`/pseudo-elements
- Verify no font size below `text-sm` exists anywhere

## Complexity Tracking

No constitution violations to justify.
