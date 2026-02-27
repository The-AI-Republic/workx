# Research: Unify CSS Styling with Tailwind

**Date**: 2026-02-25
**Feature**: 001-unify-css-tailwind

## R1: Tailwind v4 Dark Mode Strategy

**Decision**: Use Tailwind v4 `dark:` variant with named custom colors defined in `@theme` block.

**Rationale**: Tailwind CSS v4 defaults to `@media (prefers-color-scheme: dark)` for the `dark:` variant, which matches the project's existing OS-preference-based dark mode approach. By defining chatgpt theme colors as named tokens in `@theme` (both light and dark variants), components use semantic class names like `bg-chat-bg dark:bg-chat-bg-dark` instead of arbitrary hex values.

**Alternatives considered**:
- CSS custom properties with media query overrides (current approach) — rejected because user wants full Tailwind migration
- Responsive CSS variables via `light-dark()` function — rejected because it doesn't use `dark:` prefix as requested
- Arbitrary values in markup (`dark:bg-[#212121]`) — rejected because it scatters hex values across 63 components, defeating maintainability

**Implementation detail**: Define all chatgpt light/dark color pairs in `src/webfront/styles.css` `@theme` block. Terminal colors remain fixed (no dark counterparts needed).

## R2: Dual Tailwind Configuration Consolidation

**Decision**: Remove `tailwind.config.mjs` entirely and consolidate into `styles.css` `@theme` block.

**Rationale**: The project currently has duplicate terminal color definitions in both `tailwind.config.mjs` (v3 style) and `styles.css` `@theme` (v4 style). Since the project uses `@import "tailwindcss"` (v4 syntax), the `@theme` block is the canonical source. The v3-style config file is redundant and could cause confusion.

**Alternatives considered**:
- Keep both files in sync — rejected because it's error-prone maintenance burden
- Use only `tailwind.config.mjs` — rejected because the project already uses v4 CSS-first config via `@import "tailwindcss"`

## R3: sidepanel.css CSS Variable Inventory

**Decision**: Map all 44 CSS custom properties to named Tailwind color tokens.

**Rationale**: `sidepanel.css` defines 10 `--browserx-*` variables and 34 `--chat-*` variables, each with light and dark variants. These will be replaced by Tailwind theme tokens in the `@theme` block.

**Color mapping (light → dark)**:

| CSS Variable | Light | Dark | Tailwind Token |
|-------------|-------|------|----------------|
| `--browserx-primary` | #4f46e5 | #6366f1 | `bx-primary` / `bx-primary-dark` |
| `--browserx-secondary` | #6366f1 | #818cf8 | `bx-secondary` / `bx-secondary-dark` |
| `--browserx-background` | #ffffff | #111827 | `bx-bg` / `bx-bg-dark` |
| `--browserx-surface` | #f9fafb | #1f2937 | `bx-surface` / `bx-surface-dark` |
| `--browserx-text` | #111827 | #f9fafb | `bx-text` / `bx-text-dark` |
| `--browserx-text-secondary` | #6b7280 | #9ca3af | `bx-text-secondary` / `bx-text-secondary-dark` |
| `--browserx-border` | #e5e7eb | #374151 | `bx-border` / `bx-border-dark` |
| `--browserx-error` | #ef4444 | #f87171 | `bx-error` / `bx-error-dark` |
| `--browserx-success` | #10b981 | #34d399 | `bx-success` / `bx-success-dark` |
| `--browserx-warning` | #f59e0b | #fbbf24 | `bx-warning` / `bx-warning-dark` |
| `--chat-bg` | #ffffff | #212121 | `chat-bg` / `chat-bg-dark` |
| `--chat-bg-secondary` | #f7f7f8 | #2f2f2f | `chat-surface` / `chat-surface-dark` |
| `--chat-text` | #0d0d0d | #ececec | `chat-text` / `chat-text-dark` |
| `--chat-text-secondary` | #6e6e80 | #b4b4b4 | `chat-text-muted` / `chat-text-muted-dark` |
| `--chat-border` | #e5e5e5 | #3e3e3e | `chat-border` / `chat-border-dark` |
| `--chat-input-bg` | #f4f4f4 | #2f2f2f | `chat-input` / `chat-input-dark` |
| `--chat-input-border` | #e5e5e5 | #3e3e3e | `chat-input-border` / `chat-input-border-dark` |
| `--chat-primary` | #60a5fa | #60a5fa | `chat-primary` (same both modes) |
| `--chat-error` | #ef4444 | #f87171 | `chat-error` / `chat-error-dark` |
| `--chat-card-bg` | #ffffff | #2f2f2f | `chat-card` / `chat-card-dark` |
| `--chat-card-border` | #e5e5e5 | #3e3e3e | `chat-card-border` / `chat-card-border-dark` |
| `--chat-card-hover` | #f7f7f8 | #3a3a3a | `chat-card-hover` / `chat-card-hover-dark` |
| `--chat-send-button-bg` | #0d0d0d | #ececec | `chat-send` / `chat-send-dark` |
| `--chat-send-button-text` | #ffffff | #212121 | `chat-send-text` / `chat-send-text-dark` |
| `--chat-stop-button-bg` | #ef4444 | #ef4444 | `chat-stop` (same both modes) |

(Full mapping for all 44 variables to be finalized during implementation.)

## R4: Component Migration Complexity Inventory

**Decision**: Migrate in three waves ordered by complexity (simple → medium → complex).

**Rationale**: The codebase has 46 components with `<style>` blocks. Breaking migration into waves allows incremental verification and reduces risk of breaking multiple components simultaneously.

**Wave breakdown**:
- **Wave 1 — Simple** (11 components, ~0-5 CSS rules): `TerminalInput`, `ReasoningEvent`, `SystemEvent`, `OutputEvent`, `ErrorEvent`, `ApprovalEvent`, `MessageEvent`, `ToolCallEvent`, `PlanEvent`, `Portal`, `TabContext` (no style blocks)
- **Wave 2 — Medium** (10 components, ~6-15 CSS rules): `TerminalMessage`, `TerminalContainer`, `CommandError`, `CommandDropdown`, `Switch`, `ChatHistoryPopup`, `ApprovalModeIndicator`, `FooterBar`, `TaskEvent`, `Credits` (footbar)
- **Wave 3 — Complex** (15 components, 16+ CSS rules): `SchedulerPopup` (317 rules), `ScheduleTaskModal` (128), `MessageInput` (102), `ModelSelection` (87), `SchedulerTaskItem` (80), `Credits` (67), `MessageDisplay` (65), `UserLoginStatus` (62), `ArchivedTasksView` (58), `ChatHistoryList` (57), `MessageEvent` (54), `EventDisplay` (53), `PopupCard` (21), `Tooltip` (21)

## R5: Theme Switching Architecture

**Decision**: Keep the existing Svelte store-based theme switching (`uiTheme` store with `terminal` | `chatgpt` values). Apply theme via conditional Tailwind classes in markup.

**Rationale**: The theme store pattern is well-established across 20+ components. Components apply the theme via `class="{currentTheme}"` on container elements with CSS cascading. The migration replaces the cascading CSS approach with conditional Tailwind classes.

**Current pattern** (to be replaced):
```html
<div class="component {currentTheme}">
<!-- Scoped CSS: .component.chatgpt { color: var(--chat-text) } -->
```

**Target pattern**:
```html
<div class="{currentTheme === 'chatgpt'
  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
  : 'bg-term-bg text-term-green font-terminal'}">
```

Or using Svelte reactive class directives for cleaner markup where appropriate.

## R6: Styles Requiring Scoped CSS Retention

**Decision**: Keep scoped `<style>` blocks only for CSS that cannot be expressed as Tailwind utilities.

**Items that must stay as scoped CSS**:
- **Keyframe animations** (13 components): `blink`, `pulse`, `fadeIn`, `slideIn`, `slideUp`, `slideDown`, `spin`, `streaming-bg`, `runningPulse`, `badgePulse`, `pulse-subtle`
- **`:global()` selectors** (4 components): `MessageDisplay`, `MessageEvent`, `CommandDropdown`, `Tooltip` — for styling markdown rendered content and third-party library elements (Tippy.js)
- **Pseudo-element styling** (`::before`, `::after`): `Tooltip` (Tippy arrow), `MessageInput` (webkit calendar picker)
- **Scrollbar styling**: `::-webkit-scrollbar` in `sidepanel.css`

## R7: Test Migration Impact

**Decision**: Update 11 test files to align with new Tailwind class names.

**Tests requiring updates**:
- **High priority** (assert specific CSS classes): `theme-integration.test.ts`, `terminal-message.test.ts`, `terminal-container.test.ts`, `terminal-input.test.ts`, `styles.test.ts`, `userMessages.visual.test.ts`
- **Medium priority** (assert computed styles/colors): `accessibility.test.ts`, `TerminalInput.test.ts`
- **Low priority** (assert container selectors): `TerminalMessage.test.ts`, `MessageInput.test.ts`, `inputOutline.visual.test.ts`

## R8: sidepanel.css Dual Import Resolution

**Decision**: Consolidate `sidepanel.css` legacy Tailwind directives (`@tailwind base/components/utilities`) into the `styles.css` `@import "tailwindcss"` (v4) approach, then remove `sidepanel.css` entirely.

**Rationale**: Having two CSS entry points with conflicting Tailwind import styles creates ambiguity. The global CSS variables, body styles, and scrollbar styles from `sidepanel.css` will be migrated to `styles.css` and Tailwind utilities.

**Alternatives considered**:
- Keep both files — rejected because two conflicting Tailwind import styles is confusing
- Keep `sidepanel.css` as primary — rejected because it uses v3 syntax while the project uses v4
