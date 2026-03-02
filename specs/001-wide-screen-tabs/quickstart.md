# Quickstart: Wide Screen Mode with Left Tab Panel

**Feature**: 001-wide-screen-tabs
**Date**: 2026-02-23

## Prerequisites

- Node.js (version compatible with package.json)
- npm dependencies installed (`npm install`)
- Familiarity with Svelte 4, TypeScript, and the existing codebase structure

## Key Files to Understand First

1. **`src/webfront/App.svelte`** — Current app entry point with Router and auth logic
2. **`src/webfront/pages/chat/Main.svelte`** — Chat page that renders FooterBar
3. **`src/webfront/components/layout/FooterBar.svelte`** — Current footer with user login status
4. **`src/webfront/components/common/UserLoginStatus.svelte`** — Avatar/login component that moves between panel and footer
5. **`src/webfront/stores/themeStore.ts`** — Theme store pattern to follow for new stores

## Implementation Order

### Step 1: Create `layoutStore.ts`

Create `src/webfront/stores/layoutStore.ts`:
- Export `isWideMode` readable store using `window.matchMedia('(min-width: 769px)')`
- Export `NAV_ITEMS` constant array with Chat, Settings, Scheduler definitions
- Export `NavItem` TypeScript interface

### Step 2: Create `NavTab.svelte`

Create `src/webfront/components/layout/NavTab.svelte`:
- Reusable tab button accepting `item: NavItem`, `active: boolean`, `compact: boolean`
- Renders icon + label (full mode) or icon-only (compact mode)
- Dispatches `navigate` event on click
- Supports terminal and chatgpt theme classes

### Step 3: Create `LeftPanel.svelte`

Create `src/webfront/components/layout/LeftPanel.svelte`:
- Renders vertical list of `NavTab` components using `NAV_ITEMS`
- Shows `UserLoginStatus` at the bottom
- Uses `$location` from svelte-spa-router for active tab detection
- Full theme support

### Step 4: Create `AppShell.svelte`

Create `src/webfront/components/layout/AppShell.svelte`:
- Subscribes to `isWideMode`
- Wide mode: flexbox layout with `LeftPanel` (220px fixed) + `<slot>` (flex: 1)
- Narrow mode: just `<slot>` (full width)
- Apply 100vh height, overflow hidden

### Step 5: Modify `App.svelte`

Wrap `<Router {routes} />` with `<AppShell>`:
```svelte
<AppShell>
  <Router {routes} />
</AppShell>
```

### Step 6: Modify `FooterBar.svelte`

- Import `isWideMode` and `NAV_ITEMS`
- In narrow mode: add navigation icons using `NavTab` (compact mode)
- In wide mode: hide UserLoginStatus and navigation icons (panel handles it)
- In narrow mode: keep UserLoginStatus in footer

### Step 7: Modify `Main.svelte` (Chat page)

- The FooterBar is already rendered here — it will adapt automatically via the store
- May need minor layout adjustments to ensure the chat page fills the available space within AppShell

### Step 8: Add theme CSS variables

Update `src/webfront/styles.css` if new CSS custom properties are needed for left panel styling.

## Running & Testing

```bash
# Development (extension mode)
npm run dev

# Development (desktop mode)
npm run dev:desktop

# Run tests
npm test

# Type check
npm run type-check

# Lint
npm run lint
```

## Testing Checklist

- [ ] Wide mode (>768px): Left panel visible with 3 tabs + user center at bottom
- [ ] Narrow mode (<=768px): Footer bar shows navigation icons
- [ ] Click each tab in wide mode → correct page loads, tab highlighted
- [ ] Click each icon in narrow mode → correct page loads, icon highlighted
- [ ] Resize window across breakpoint → layout switches instantly, active page preserved
- [ ] Terminal theme: panel uses dark bg, green accents
- [ ] ChatGPT theme: panel uses light bg, standard accents
- [ ] Logged out state: login button shows correctly in panel (wide) and footer (narrow)
- [ ] Chrome extension side panel (~400px): always narrow mode, footer navigation works
- [ ] Tauri desktop window: wide mode above 768px, narrow mode below

## Common Pitfalls

1. **SSR guard**: `window.matchMedia` doesn't exist during SSR/testing. Guard with `typeof window !== 'undefined'`.
2. **Settings/Scheduler pages**: These currently use `height: 100vh` and centered overlays. They may need CSS adjustments to fit within the AppShell content area rather than taking the full viewport.
3. **PopupCard z-index**: `UserLoginStatus` uses `PopupCard` for its dropdown menu. Ensure the left panel doesn't create a stacking context that traps the popup.
4. **i18n**: All new labels (tab names) must use the `_t()` / `t()` i18n function for translation support.
