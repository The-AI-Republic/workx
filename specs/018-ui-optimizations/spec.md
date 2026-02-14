# Feature Specification: UI Optimizations

**Feature Branch**: `018-ui-optimizations`
**Created**: 2026-02-13
**Status**: Draft
**Input**: User description: "UI optimizations: extend content container max-width to 1200px and fix Terminal Sandbox dark mode styling in Tools Settings"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Wider Conversation Layout (Priority: P1)

As a user of the Pi desktop application or side panel on a wide monitor, I want the conversation area to use more horizontal space so that messages, code blocks, and content are easier to read without excessive empty margins on both sides.

**Why this priority**: The content container is currently capped at 900px, which wastes significant screen real estate on modern wide displays. Extending it to 1200px immediately improves the reading and working experience for all users with displays wider than 900px.

**Independent Test**: Can be tested by opening the application in a window wider than 1200px and verifying the conversation area extends to 1200px before centering.

**Acceptance Scenarios**:

1. **Given** the application is open in a window wider than 1200px, **When** the user views the chat conversation, **Then** the conversation content area spans up to 1200px and is horizontally centered.
2. **Given** the application is open in a window narrower than 1200px, **When** the user views the chat conversation, **Then** the conversation content area fills the available width (100%) without horizontal overflow.
3. **Given** the application is open in the browser extension side panel (narrow viewport), **When** the user views the chat conversation, **Then** the content area fills the full panel width and remains fully usable.

---

### User Story 2 - Terminal Sandbox Dark Mode Fix (Priority: P1)

As a user accessing Tools Settings > Advanced Configuration > Sandbox Policy in the terminal (dark) theme, I want the dropdown selector to be fully readable and visually consistent with the rest of the dark-themed settings UI, so I can easily read and select sandbox policy options.

**Why this priority**: The native `<select>` dropdown for Sandbox Policy does not render its `<option>` elements with dark mode styling, making them potentially unreadable or visually jarring against the dark-themed settings modal. This is a usability bug that affects any user adjusting sandbox settings in the default terminal theme.

**Independent Test**: Can be tested by opening Settings > Tools Settings > Advanced Configuration, clicking the Sandbox Policy dropdown, and verifying all options are readable with proper dark-themed colors.

**Acceptance Scenarios**:

1. **Given** the application is using the terminal (dark) theme, **When** the user opens Tools Settings and expands Advanced Configuration, **Then** the Sandbox Policy dropdown field displays with dark background and appropriately contrasting text.
2. **Given** the application is using the terminal (dark) theme, **When** the user clicks the Sandbox Policy dropdown to view options, **Then** all dropdown options ("Read-only", "Workspace Write", "Full Access (Dangerous)") are displayed with dark background and readable text — no bright white/light backgrounds flash.
3. **Given** the application is using the terminal (dark) theme, **When** the user hovers over dropdown options, **Then** the hover state uses a visually distinct but theme-consistent highlight color.
4. **Given** the application switches between light (ChatGPT) and dark (terminal) themes, **When** the user views the Sandbox Policy dropdown, **Then** the dropdown styling matches the active theme in both states.

---

### Edge Cases

- What happens when the viewport is exactly 1200px wide? The content container should fill the full width without horizontal scrollbars.
- What happens on very narrow viewports (e.g., 320px mobile or narrow side panel)? The content container should degrade gracefully to 100% width.
- What happens with the Sandbox Policy dropdown on operating systems that heavily enforce native select styling (e.g., macOS Safari)? The fix should provide a consistent experience or gracefully degrade.
- What if the user has a system-level dark mode preference that differs from the app theme? The dropdown styling should follow the app theme, not the OS preference.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The main conversation content container MUST have a maximum width of 1200px (increased from 900px).
- **FR-002**: The content container MUST remain horizontally centered when the viewport is wider than 1200px.
- **FR-003**: The content container MUST fill 100% of available width when the viewport is narrower than 1200px.
- **FR-004**: The Sandbox Policy dropdown in Tools Settings MUST display with theme-appropriate colors in the terminal (dark) theme — dark background with readable contrasting text for both the closed field and the open option list.
- **FR-005**: The Sandbox Policy dropdown options MUST be readable when the dropdown is expanded, with sufficient contrast against the background.
- **FR-006**: The dropdown fix MUST not break the appearance of the Sandbox Policy dropdown in the ChatGPT (light) theme.

### Assumptions

- The 1200px value is a direct user requirement and does not need A/B testing.
- The terminal theme is the default/primary theme; the fix should prioritize terminal theme dark mode while ensuring no regressions in the ChatGPT light theme.
- The native `<select>` element's dropdown options are the primary dark mode issue — replacing with a custom dropdown or applying `color-scheme` CSS property are both acceptable approaches.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The conversation content area uses up to 1200px of horizontal space on wide displays, a 33% increase from the previous 900px limit.
- **SC-002**: All three Sandbox Policy dropdown options are readable in the terminal (dark) theme — text has at least 4.5:1 contrast ratio against the dropdown background.
- **SC-003**: No visual regressions are introduced in the ChatGPT (light) theme for either the content container width or the dropdown styling.
- **SC-004**: The content container remains fully responsive — no horizontal scrollbars appear at any viewport width.
