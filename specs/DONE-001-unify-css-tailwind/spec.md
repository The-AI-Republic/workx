# Feature Specification: Unify CSS Styling with Tailwind

**Feature Branch**: `001-unify-css-tailwind`
**Created**: 2026-02-25
**Status**: Draft
**Input**: User description: "Inspect and unify our CSS styling: 1) use Tailwind instead of native CSS, 2) UI elements adopt light/dark theme well, 3) increase any text-xs or smaller fonts to text-sm"

## Clarifications

### Session 2026-02-25

- Q: Should dark/light theming use the existing CSS custom properties or migrate to Tailwind `dark:` prefix utilities? → A: Fully migrate to Tailwind `dark:` prefix utilities, replacing the CSS custom property theming system entirely.
- Q: When the terminal theme is active, should UI elements follow the OS light/dark preference or use a fixed appearance? → A: The terminal theme has its own fixed visual style that is independent of light/dark mode. It does not respond to OS preference at all. Only the chatgpt theme switches between light and dark.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consistent Utility-Based Styling Across All Components (Priority: P1)

As a developer working on BrowserX, I want all UI components to use a unified utility-class styling approach instead of a mix of scoped CSS and utility classes, so that the codebase is easier to maintain, review, and extend.

Currently, approximately 63 Svelte components use a combination of scoped `<style>` blocks with native CSS properties (pixel-based font sizes, hardcoded colors, manual spacing) alongside utility classes. This inconsistency increases cognitive load and makes global style changes difficult. This story converts all native CSS styling to equivalent utility classes wherever feasible.

**Why this priority**: This is the foundational change that enables consistent theming and font-size normalization. Without unified styling, theme and size changes would need to be applied in two different systems.

**Independent Test**: Can be verified by inspecting any converted component - it should render identically to before while using utility classes instead of native CSS in its `<style>` block.

**Acceptance Scenarios**:

1. **Given** a component with native CSS properties in a `<style>` block (e.g., `font-size: 11px; color: #00ff00; padding: 4px 8px`), **When** the migration is complete, **Then** those properties are replaced with equivalent utility classes in the component markup, and the visual output is identical.
2. **Given** a component with inline styles for dynamic/computed values (e.g., `style="left: {x}px"`), **When** the migration is complete, **Then** dynamic inline styles are preserved (since they require runtime computation), but static inline styles are converted to utility classes.
3. **Given** the full set of migrated components, **When** a developer reviews the codebase, **Then** there is a single consistent approach to styling across all components.

---

### User Story 2 - Reliable Light and Dark Theme Appearance (Priority: P2)

As a user of BrowserX, I want all UI elements to display correctly in both light mode and dark mode, so that the interface is comfortable to use regardless of my system preference or chosen theme.

Currently, the application uses CSS custom properties (e.g., `--browserx-primary`, `--chat-bg`) with `@media (prefers-color-scheme: dark)` overrides for theming. This approach will be replaced with Tailwind's `dark:` prefix utilities, making all theme logic declarative in component markup. Some components also use hardcoded colors that do not adapt to theme changes. This story migrates all theming to Tailwind `dark:` variants and ensures every visible element responds appropriately to theme switching.

**Why this priority**: Theme consistency directly impacts user experience. Users who switch between light and dark environments will encounter visual inconsistencies until this is addressed.

**Independent Test**: Can be tested by toggling between light and dark system preferences and verifying every visible element (text, backgrounds, borders, icons, interactive controls) adapts correctly in both modes.

**Acceptance Scenarios**:

1. **Given** a user with system dark mode enabled, **When** they open any page or panel in BrowserX, **Then** all text is readable against its background, no elements use hardcoded light-only colors, and contrast meets accessibility guidelines (WCAG AA minimum 4.5:1 for normal text).
2. **Given** a user with system light mode enabled, **When** they open any page or panel, **Then** all elements display with appropriate light-theme colors and no dark-mode artifacts appear.
3. **Given** a user who changes their system preference from light to dark (or vice versa) while BrowserX is open, **When** the preference changes, **Then** the UI updates to reflect the new theme without requiring a page reload.
4. **Given** a user with the terminal theme selected, **When** the OS preference is set to light mode, **Then** all UI elements (including settings, inputs, navigation) retain the terminal theme's fixed appearance and do not switch to light colors.
5. **Given** a user with the chatgpt theme selected, **When** the OS preference changes between light and dark, **Then** all UI elements adapt accordingly using Tailwind `dark:` variants.

---

### User Story 3 - Minimum Readable Font Size Enforcement (Priority: P3)

As a user of BrowserX, I want all text in the interface to be at least 14px (0.875rem / text-sm equivalent), so that I can comfortably read all content without straining.

Currently, the application has over 100 instances of text sized at 12px or smaller, including 10px text in scheduler components, 11px in tooltips and status bars, and widespread use of 0.75rem (12px) across components. This story increases all such instances to a minimum of 14px (0.875rem).

**Why this priority**: While important for readability, this change is lower risk and more mechanical than the styling unification and theme work. It builds naturally on top of the utility-class migration.

**Independent Test**: Can be tested by searching the entire codebase for any font-size declaration below 14px / 0.875rem and confirming none exist, then visually inspecting the UI to confirm no text appears too small.

**Acceptance Scenarios**:

1. **Given** any text element in the application, **When** it is rendered, **Then** its computed font size is at least 14px (0.875rem).
2. **Given** a component that previously used 10px, 11px, or 12px text (e.g., scheduler items, tooltips, model selection), **When** the font size is increased, **Then** the surrounding layout accommodates the larger text without overflow, clipping, or broken alignment.
3. **Given** the full application UI, **When** all font sizes have been updated, **Then** the visual hierarchy is preserved - headings remain larger than body text, secondary information remains visually subordinate to primary content.

---

### Edge Cases

- What happens when a component relies on small font sizes to fit content in a constrained space (e.g., status indicators, badges)? The layout must be adjusted to accommodate the larger minimum size without breaking.
- What happens when native CSS in a `<style>` block uses complex selectors (`:global()`, nested selectors, pseudo-elements) that don't have direct utility-class equivalents? These should be handled on a case-by-case basis, keeping native CSS only where utility classes cannot express the same behavior.
- What happens when a component's scoped styles use CSS animations or transitions? Animation keyframes and transition definitions may remain in `<style>` blocks since they are not representable as utility classes.
- How does the terminal theme (green-on-black aesthetic) interact with dark mode? The terminal theme has its own fixed visual identity that is completely independent of OS light/dark preference. All UI elements use the terminal palette regardless of OS setting. Only the chatgpt theme responds to light/dark switching.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All static visual styling (colors, spacing, typography, borders, layout) in component markup MUST use utility classes instead of native CSS properties in scoped style blocks.
- **FR-002**: Scoped `<style>` blocks MUST only be retained for styling that cannot be expressed with utility classes: CSS animations/keyframes, complex pseudo-element styling, `:global()` selectors, and CSS custom property definitions.
- **FR-003**: Dynamic inline styles that depend on runtime-computed values (e.g., positioning calculated from variables) MUST be preserved as inline styles.
- **FR-004**: Static inline styles (e.g., `style="margin-bottom: 0.5rem"`) MUST be converted to utility classes.
- **FR-005**: When the chatgpt theme is active, all UI elements MUST adapt their appearance (text color, background color, border color, icon color) when the user's system color scheme preference changes between light and dark.
- **FR-006**: All hardcoded color values and CSS custom property-based theme colors MUST be replaced with Tailwind `dark:` prefix utility classes. The existing CSS custom property theming system (`--browserx-*`, `--chat-*` variables with `@media (prefers-color-scheme: dark)` overrides) MUST be removed and replaced entirely with Tailwind dark mode variants.
- **FR-013**: The terminal theme MUST use its own fixed color palette for all UI elements and MUST NOT respond to OS light/dark preference changes. The terminal appearance is independent of the system color scheme.
- **FR-007**: Text contrast MUST meet WCAG AA standards (minimum 4.5:1 ratio for normal text, 3:1 for large text) in both light and dark modes.
- **FR-008**: No text element in the application MUST have a computed font size smaller than 14px (0.875rem).
- **FR-009**: Any text currently sized at 12px or smaller (including utility classes equivalent to 12px, and pixel/rem declarations of 0.75rem or below) MUST be increased to at least 14px (0.875rem).
- **FR-010**: Layout containers surrounding resized text MUST accommodate the new size without visual overflow, clipping, or misalignment.
- **FR-011**: The existing visual hierarchy (headings > body > secondary text) MUST be preserved after font size changes.
- **FR-012**: The visual output of every migrated component MUST be identical to its pre-migration appearance (except for the intentional font-size increases).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of components use utility classes as the primary styling method, with scoped CSS blocks used only for non-utility-expressible styles (animations, pseudo-elements, global selectors).
- **SC-002**: Zero instances of hardcoded color values that fail to adapt when switching between light and dark system preferences.
- **SC-003**: All text elements across the application pass WCAG AA contrast requirements (4.5:1 minimum) in both light and dark modes.
- **SC-004**: Zero instances of text with a computed font size below 14px (0.875rem) anywhere in the application.
- **SC-005**: All existing automated tests continue to pass after the migration with no regressions.
- **SC-006**: No visual regressions in any component beyond the intentional font-size increases - layout, spacing, colors, and interactivity remain identical.

## Assumptions

- The existing utility-class framework configuration (content paths, custom theme extensions, PostCSS pipeline) is already functional and does not need to be set up from scratch.
- The dual theme system (terminal/chatgpt) will be preserved as a UI concept, but the underlying CSS custom property theming mechanism will be replaced with Tailwind `dark:` utilities. OS-level dark mode detection will be handled by Tailwind's built-in dark mode support rather than manual `@media` queries.
- CSS animation keyframes, transition definitions, and complex pseudo-element styles are acceptable to keep in scoped `<style>` blocks since utility classes cannot express these.
- Dynamic inline styles that depend on runtime-computed values (e.g., `style="left: {x}px"`) are acceptable and will not be converted.
- The desktop application (Tauri wrapper) shares the same styling as the web/extension UI and will benefit from the same changes.
- "text-sm" equivalent is 14px / 0.875rem as the minimum readable font size threshold.

## Scope

### In Scope

- Converting native CSS in scoped `<style>` blocks to utility classes across all ~63 Svelte components
- Converting static inline styles to utility classes
- Removing the existing CSS custom property theming system and replacing with Tailwind `dark:` utilities
- Auditing and fixing all hardcoded colors for theme responsiveness
- Increasing all font sizes below 14px to at least 14px
- Adjusting layouts to accommodate increased font sizes
- Ensuring theme switching works correctly across all UI elements
- Main CSS files (styles.css, sidepanel.css) cleanup and consolidation

### Out of Scope

- Changing the theme architecture (terminal/chatgpt dual system stays as-is)
- Adding new themes beyond light/dark
- Redesigning any UI layouts or component structures
- Adding responsive/mobile layouts
- Changing the build pipeline or tooling configuration
- Welcome page styling (separate build target)
