# Research: Wide Screen Mode with Left Tab Panel

**Feature**: 001-wide-screen-tabs
**Date**: 2026-02-23

## R1: Responsive Breakpoint Detection in Svelte

**Decision**: Use `window.matchMedia('(min-width: 768px)')` with an event listener, wrapped in a Svelte writable store.

**Rationale**:
- `matchMedia` fires a single `change` event only when the threshold is crossed — no continuous resize listener needed
- More performant than `window.addEventListener('resize')` which fires on every pixel change
- The `MediaQueryList.addEventListener('change', callback)` API is supported in all modern browsers (Chrome 56+, Safari 14+, Firefox 55+)
- Aligns with CSS `@media (min-width: 768px)` for consistent behavior
- Svelte writable store makes the boolean reactive across all components

**Alternatives considered**:
- `resize` event + debounce: More complex, still fires frequently, needs manual threshold comparison
- Svelte `$: isWide = window.innerWidth > 768` with `resize` listener: Reactive but fires on every pixel
- CSS-only `@media` queries: Cannot move components between DOM locations (UserLoginStatus needs to move)
- ResizeObserver on container: Over-engineered for window-level breakpoint detection

**Implementation pattern**:
```typescript
import { writable } from 'svelte/store';

function createLayoutStore() {
  const mediaQuery = typeof window !== 'undefined'
    ? window.matchMedia('(min-width: 768px)')
    : null;

  const { subscribe, set } = writable(mediaQuery?.matches ?? false);

  mediaQuery?.addEventListener('change', (e) => set(e.matches));

  return { subscribe };
}

export const isWideMode = createLayoutStore();
```

## R2: svelte-spa-router Active Route Detection

**Decision**: Use the `location` readable store exported by `svelte-spa-router`.

**Rationale**:
- `svelte-spa-router` exports `location`, `querystring`, and `params` as readable Svelte stores
- `$location` returns the current hash-based path (e.g., `/settings`, `/scheduler`, `/`)
- Directly comparable to nav item routes — no parsing needed
- Already used implicitly by the `<Router>` component; subscribing to it is zero-cost

**Alternatives considered**:
- Custom store tracking `push()` calls: Duplicates router state, risk of desync
- `window.location.hash` parsing: Low-level, not reactive, no Svelte integration
- `active` directive from svelte-spa-router: Only works on `<a>` elements with `use:link`, not arbitrary buttons

## R3: Svelte Component Conditional Rendering for UserLoginStatus Relocation

**Decision**: Use `{#if $isWideMode}` blocks to conditionally render `UserLoginStatus` in either `LeftPanel` (wide) or `FooterBar` (narrow). The component unmounts from one location and mounts in the other.

**Rationale**:
- Svelte's reactive `{#if}` blocks handle mount/unmount efficiently
- `UserLoginStatus` manages its own internal state (menu open/close, login state) via stores, so remounting is safe — store subscriptions re-establish on mount
- No `onMount` side effects in UserLoginStatus that would break on remount (it only subscribes to stores)

**Alternatives considered**:
- CSS `display: none` to hide one instance: Would create two instances of UserLoginStatus, potentially causing duplicate event listeners or conflicting popup positioning
- Portal/teleport pattern: Svelte 4 doesn't have a built-in portal; a library would add complexity for a simple conditional render
- Passing a `container` prop: Over-engineered; conditional rendering is the standard Svelte pattern

## R4: Left Panel Width and Layout Impact

**Decision**: Fixed width of 220px for the left panel.

**Rationale**:
- Accommodates icon (24px) + label text (~120px) + padding (2 × 16px) + gap (12px) = ~188px minimum; 220px provides comfortable spacing
- At the 768px breakpoint, the main content area retains 548px (768 - 220), which is sufficient for the chat interface
- Chrome extension side panels are typically 400-500px; at 400px the app would be in narrow mode (below 768px threshold), so the panel width doesn't affect extension mode
- Desktop Tauri windows commonly start at 800-1200px, leaving 580-980px for content

**Alternatives considered**:
- 200px: Slightly tight for longer labels and i18n translations
- 240px: Leaves less room for content at the 768px boundary
- Percentage-based width: Creates unpredictable sizing; fixed width is more reliable for navigation panels

## R5: Navigation Icons Selection

**Decision**: Use inline SVG icons matching the existing icon style in the codebase.

**Rationale**:
- The codebase already uses inline SVG icons (see FooterBar.svelte settings gear icon, Scheduler clock icon)
- No icon library dependency needed — keeps the bundle lean
- SVGs scale cleanly and inherit `currentColor` for theme compatibility
- Icons selected:
  - **Chat**: Message bubble / chat icon (standard chat metaphor)
  - **Settings**: Gear icon (already exists in FooterBar.svelte, can be reused)
  - **Scheduler**: Clock/calendar icon (already exists in Scheduler.svelte)

**Alternatives considered**:
- Icon library (lucide, heroicons): Adds a dependency for just 3 icons
- CSS icons (pseudo-elements): Less accessible, harder to style

## R6: Breakpoint Value — 768px

**Decision**: Use 768px as the wide/narrow threshold.

**Rationale**:
- Standard tablet/desktop breakpoint used by Tailwind CSS (md: 768px), Bootstrap, and Material Design
- Chrome extension side panels default to ~400px wide and max at ~600px — always below the threshold (narrow mode)
- Tauri desktop windows can be resized freely — users with windows wider than 768px get the left panel
- Spec explicitly states 768px (FR-010)
- At exactly 768px, use narrow mode (spec edge case: `width > 768` for wide mode, `width <= 768` for narrow mode — `min-width: 769px` in media query, or equivalently `min-width: 768px` since the spec says "exceeds")

**Note on spec interpretation**: FR-010 says "exceeds the defined breakpoint", meaning `width > 768px`. The `matchMedia('(min-width: 769px)')` would be the strict interpretation. However, CSS convention uses `min-width: 768px` to mean "768px and above". Since the edge case spec says "exactly at breakpoint → narrow mode", we use `min-width: 769px` to ensure 768px stays in narrow mode.

## R7: Settings and Scheduler Page Layout Considerations

**Decision**: Settings and Scheduler pages remain standalone full-screen route components. The AppShell layout (left panel + content area) wraps the Router, so all pages including Settings and Scheduler automatically appear within the shell.

**Rationale**:
- Currently, Settings and Scheduler render as modal-like overlays with `height: 100vh` and centered containers. When wrapped by AppShell in wide mode, they'll render within the main content area next to the left panel, which is the desired behavior (tabs show which page is active).
- No changes needed to Settings.svelte or Scheduler.svelte themselves — their `100vh` height will be constrained to the content area's flex container.
- The left panel remains visible on all pages in wide mode, allowing users to quickly switch between pages.
