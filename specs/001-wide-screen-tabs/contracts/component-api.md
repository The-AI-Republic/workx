# Component API Contracts: Wide Screen Mode with Left Tab Panel

**Feature**: 001-wide-screen-tabs
**Date**: 2026-02-23

## Overview

This document defines the public interfaces (props, events, stores) for all new and modified components. Since this is a frontend-only feature with no backend API changes, "contracts" here means Svelte component interfaces and store APIs.

---

## Stores

### layoutStore.ts

```typescript
// Exports
export const isWideMode: Readable<boolean>;
// true when window.matchMedia('(min-width: 769px)').matches
// false otherwise
// Automatically updates on media query change events

export interface NavItem {
  id: string;       // 'chat' | 'settings' | 'scheduler'
  label: string;    // i18n key for display label
  icon: string;     // SVG path data for the icon
  route: string;    // Router path: '/' | '/settings' | '/scheduler'
}

export const NAV_ITEMS: NavItem[];
// Static array of navigation items:
// [
//   { id: 'chat',      label: 'Chat',      icon: '<svg...>',  route: '/' },
//   { id: 'settings',  label: 'Settings',  icon: '<svg...>',  route: '/settings' },
//   { id: 'scheduler', label: 'Scheduler', icon: '<svg...>',  route: '/scheduler' },
// ]
```

---

## New Components

### AppShell.svelte

**Purpose**: Top-level responsive layout wrapper. Renders LeftPanel + content area in wide mode, or content-only with enhanced FooterBar in narrow mode.

**Props**: None

**Slots**:
- `default` — The routed page content (receives `<Router>` output)

**Subscriptions**:
- `isWideMode` from layoutStore
- `uiTheme` from themeStore

**Rendered structure**:

```
Wide mode:
┌──────────────────────────────────┐
│ LeftPanel │   <slot /> (Router)  │
│  (220px)  │   (remaining width)  │
│           │                      │
│  [tabs]   │                      │
│           │                      │
│  [user]   │                      │
└──────────────────────────────────┘

Narrow mode:
┌──────────────────────────────────┐
│        <slot /> (Router)         │
│                                  │
│                                  │
└──────────────────────────────────┘
(FooterBar rendered within page components as before,
 but now with navigation icons)
```

---

### LeftPanel.svelte

**Purpose**: Fixed vertical sidebar for wide-mode navigation.

**Props**: None

**Subscriptions**:
- `uiTheme` from themeStore
- `location` from svelte-spa-router (for active tab highlighting)

**Imports**:
- `NAV_ITEMS` from layoutStore
- `UserLoginStatus` component

**Rendered structure**:
```
┌─────────────┐
│  [App Logo]  │  (optional — depends on space)
├─────────────┤
│ 💬 Chat     │  ← NavTab (active state based on $location)
│ ⚙️ Settings │
│ 📅 Scheduler│
│             │
│  (spacer)   │
├─────────────┤
│ [UserLogin] │  ← UserLoginStatus component
└─────────────┘
```

**CSS classes**:
- `.left-panel` — Base styles
- `.left-panel.chatgpt` — ChatGPT theme override

---

### NavTab.svelte

**Purpose**: Reusable navigation tab/icon button used by both LeftPanel and FooterBar.

**Props**:

| Prop     | Type    | Required | Description                              |
|----------|---------|----------|------------------------------------------|
| item     | NavItem | Yes      | Navigation item configuration             |
| active   | boolean | Yes      | Whether this tab represents the active route |
| compact  | boolean | No       | If true, shows icon only (narrow mode). Default: false |

**Events**:
- `on:navigate` — Dispatched when tab is clicked. Detail: `{ route: string }`

**CSS classes**:
- `.nav-tab` — Base styles
- `.nav-tab.active` — Active route highlight
- `.nav-tab.compact` — Icon-only mode
- Theme variants via parent context

---

## Modified Components

### FooterBar.svelte (MODIFIED)

**Changes**:
- Import `isWideMode` store and `NAV_ITEMS`
- In narrow mode (`!$isWideMode`): Render navigation icons using `NavTab` components (compact mode)
- In wide mode (`$isWideMode`): Hide navigation icons (panel handles it), hide UserLoginStatus (panel has it)
- Preserve existing elements: ApprovalModeIndicator, settings button for logged-out users

**New subscriptions**:
- `isWideMode` from layoutStore
- `location` from svelte-spa-router

**New rendered structure (narrow mode)**:
```
┌────────────────────────────────────────────────┐
│ [UserLogin] [NavIcons: 💬 ⚙️ 📅] [Approval]  │
└────────────────────────────────────────────────┘
```

**New rendered structure (wide mode)**:
```
┌────────────────────────────────────────────────┐
│ [Approval]           (spacer)                  │
└────────────────────────────────────────────────┘
```

---

### App.svelte (MODIFIED)

**Changes**:
- Wrap `<Router>` with `<AppShell>` component
- No other logic changes (auth, cookies unchanged)

**Before**:
```svelte
<Router {routes} />
```

**After**:
```svelte
<AppShell>
  <Router {routes} />
</AppShell>
```

---

### Main.svelte (chat page) (MODIFIED)

**Changes**:
- FooterBar rendering location stays within Main.svelte (it's part of the bottom-controls area)
- No structural changes needed — FooterBar itself handles its narrow/wide mode rendering

---

## Theme Contract

All new components follow the existing theme pattern:

```svelte
<script>
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => { currentTheme = theme; });
</script>

<div class="component-name {currentTheme}">
  ...
</div>

<style>
  /* Terminal theme (default) */
  .component-name { ... }

  /* ChatGPT theme override */
  .component-name.chatgpt { ... }
</style>
```

### Terminal Theme Colors (Left Panel):
- Background: `#000000` (matching `--color-term-bg`)
- Tab text: `#00cc00` (matching `--color-term-dim-green`)
- Active tab: `#00ff00` (matching `--color-term-green`) with subtle left border accent
- Border: `1px solid #00cc00` on the right edge

### ChatGPT Theme Colors (Left Panel):
- Background: `var(--chat-bg, #ffffff)` or slightly darker surface
- Tab text: `var(--chat-text-secondary, #6e6e80)`
- Active tab: `var(--chat-text, #0d0d0d)` with `var(--chat-primary)` accent
- Border: `1px solid var(--chat-border, #e5e5e5)` on the right edge
