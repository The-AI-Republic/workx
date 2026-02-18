# Research: UI Optimizations

**Feature**: 018-ui-optimizations
**Date**: 2026-02-13

## Research Topics

### R1: Approach for Fixing Native `<select>` Dark Mode Styling

**Decision**: Use `color-scheme: dark` CSS property on the terminal-themed settings modal container.

**Rationale**:
- The `color-scheme` CSS property tells the browser to render form controls using dark system colors, which directly fixes the native `<option>` element rendering issue.
- It is a single CSS property addition — minimal change, no component refactoring needed.
- Supported in all modern browsers (Chrome 81+, Firefox 96+, Safari 13+) which aligns with the project's target platforms.
- The project already uses `@media (prefers-color-scheme: dark)` in `sidepanel.css`, so this is consistent with existing patterns.

**Alternatives considered**:
1. **Custom dropdown component** (using PopupCard pattern like TabContext.svelte or ModelSelection.svelte): Rejected because it requires significant refactoring of the `<select>` element, introduces new accessibility requirements (keyboard navigation, focus management), and is disproportionate to the scope of the fix. The spec allows this approach but it adds unnecessary complexity for a single dropdown.
2. **Styling `<option>` elements directly**: Rejected because native `<option>` elements cannot be reliably styled with CSS across browsers — this is a known browser limitation.

### R2: Scope of `color-scheme` Application

**Decision**: Apply `color-scheme: dark` to the `.settings-modal-container` (terminal theme default) and ensure `.settings-modal-container.chatgpt` uses `color-scheme: light` to maintain correct light-theme rendering.

**Rationale**:
- The settings modal container is the root of all settings pages including ToolsSettings. Applying `color-scheme` at this level ensures all `<select>` elements across all settings pages (GeneralSettings, ModelSettings, ExtensionSettings, StorageSettings, MCPSettings) benefit from the fix automatically.
- The `.chatgpt` variant explicitly sets `color-scheme: light` to ensure no dark form controls leak into the light theme.

**Alternatives considered**:
1. **Apply only to `.form-select` elements**: Rejected because it would need to be applied in every settings component separately — the container-level approach is more maintainable.
2. **Apply to `:root`**: Rejected because it would affect the entire application including non-settings areas, potentially causing unintended side effects.

### R3: Content Container Width Impact

**Decision**: Simple value change from `max-width: 900px` to `max-width: 1200px` on `.content-container` in Main.svelte.

**Rationale**:
- The existing CSS already uses `width: 100%` and `margin: 0 auto`, so the centering behavior is preserved.
- No child elements have hardcoded widths that would break at 1200px — messages, code blocks, and input areas all use relative/percentage widths or `max-width: 100%`.
- The welcome screen and input area within `.content-container` will naturally expand to use the wider space.

**Alternatives considered**:
1. **Use `max-width: 75vw` (responsive)**: Rejected because the user explicitly requested 1200px as a fixed value.
2. **Add breakpoint-based widths**: Rejected as over-engineering for a direct user request.
