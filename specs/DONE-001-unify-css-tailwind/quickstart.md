# Quickstart: Unify CSS Styling with Tailwind

**Feature**: 001-unify-css-tailwind

## Prerequisites

- Node.js (version per project `.nvmrc` or `package.json`)
- npm dependencies installed: `npm install`
- Familiarity with Tailwind CSS v4 utility classes and `dark:` variant

## Development Workflow

### 1. Run Dev Server

```bash
npm run dev
```

This starts the Vite dev server with HMR. Tailwind classes are processed via PostCSS on the fly.

### 2. Run Tests

```bash
npm test
```

Uses Vitest with jsdom environment. After migrating a component, run tests to check for regressions.

### 3. Component Migration Pattern

For each Svelte component, follow this conversion workflow:

**Step A — Identify scoped CSS rules**:
Open the component's `<style>` block and catalog each CSS rule.

**Step B — Convert to Tailwind utilities**:
Replace each CSS property with its Tailwind class equivalent in the component markup.

| CSS Property | Tailwind Class |
|-------------|----------------|
| `font-size: 0.875rem` | `text-sm` |
| `padding: 0.5rem 1rem` | `py-2 px-4` |
| `color: #00ff00` | `text-term-green` |
| `background: #000000` | `bg-term-bg` |
| `display: flex` | `flex` |
| `flex-direction: column` | `flex-col` |
| `border: 1px solid #e5e5e5` | `border border-chat-border dark:border-chat-border-dark` |

**Step C — Handle theme-conditional styles**:

Current (scoped CSS):
```css
.element.chatgpt { color: var(--chat-text); }
```

Target (Tailwind in markup):
```svelte
<div class="{currentTheme === 'chatgpt'
  ? 'text-chat-text dark:text-chat-text-dark'
  : 'text-term-green'}">
```

**Step D — Keep what must stay**:
Only retain `<style>` blocks for: keyframe animations, `:global()` selectors, pseudo-elements, scrollbar styles.

**Step E — Font size check**:
Replace any `text-xs`, `font-size: 10px`, `font-size: 11px`, `font-size: 12px`, or `font-size: 0.75rem` with `text-sm` (14px / 0.875rem).

### 4. Tailwind Theme Token Reference

Terminal theme colors (fixed, no dark variants):
- `text-term-green`, `text-term-yellow`, `text-term-red`, `text-term-bright-green`, `text-term-dim-green`, `text-term-blue`
- `bg-term-bg`
- `font-terminal`

ChatGPT theme colors (with `dark:` variants):
- `bg-chat-bg dark:bg-chat-bg-dark` — main background
- `text-chat-text dark:text-chat-text-dark` — primary text
- `text-chat-text-muted dark:text-chat-text-muted-dark` — secondary text
- `border-chat-border dark:border-chat-border-dark` — borders
- `bg-chat-input dark:bg-chat-input-dark` — input backgrounds
- `bg-chat-surface dark:bg-chat-surface-dark` — secondary backgrounds

BrowserX semantic colors (with `dark:` variants):
- `text-bx-text dark:text-bx-text-dark` — app-level text
- `bg-bx-bg dark:bg-bx-bg-dark` — app-level background
- `border-bx-border dark:border-bx-border-dark` — app-level borders

### 5. Verification Checklist (per component)

- [ ] All static CSS rules removed from `<style>` block (or block removed entirely)
- [ ] Equivalent Tailwind classes applied in markup
- [ ] Terminal theme uses fixed `term-*` colors (no `dark:` variants)
- [ ] ChatGPT theme uses `dark:` variants for all colors
- [ ] No font size below `text-sm` (14px)
- [ ] Visual output matches pre-migration appearance
- [ ] Related tests pass
