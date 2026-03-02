# Feature Specification: Wide Screen Mode with Left Tab Panel

**Feature Branch**: `001-wide-screen-tabs`
**Created**: 2026-02-23
**Status**: Draft
**Input**: User description: "Support wide screen mode — when the page window is extended to a specific size, add a left tab panel for page navigation. In wide mode a left panel lists tabs for switching pages and the user center moves to the bottom-left of that panel. In narrow mode, page switching uses icons on the footer bar. Supported pages: main chat, settings, and scheduler."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate Pages via Left Panel in Wide Mode (Priority: P1)

A user opens the application on a wide display (or resizes the window beyond the breakpoint). A vertical left panel appears showing labeled tabs for Chat, Settings, and Scheduler. The user clicks a tab to switch pages instantly. The user center (avatar / login menu) is positioned at the bottom of this left panel, keeping it always accessible without competing with the main content area.

**Why this priority**: This is the core feature — the left panel navigation is the defining experience of wide screen mode and the primary reason for the feature request.

**Independent Test**: Can be fully tested by opening the app in a wide window (above the breakpoint), verifying the left panel renders with all three tabs, clicking each tab, and confirming the correct page loads. Delivers the core wide-screen navigation value.

**Acceptance Scenarios**:

1. **Given** the window width is above the wide-mode breakpoint, **When** the app loads, **Then** a vertical left panel is displayed with labeled tabs for Chat, Settings, and Scheduler.
2. **Given** the left panel is visible, **When** the user clicks the Settings tab, **Then** the Settings page is displayed in the main content area and the Settings tab is visually highlighted as active.
3. **Given** the left panel is visible, **When** the user clicks the Scheduler tab, **Then** the Scheduler page is displayed and the Scheduler tab is highlighted.
4. **Given** the left panel is visible, **When** the user looks at the bottom of the panel, **Then** the user center (avatar/login menu) is displayed there.

---

### User Story 2 - Navigate Pages via Footer Bar in Narrow Mode (Priority: P2)

A user opens the application on a small screen or resizes the window below the breakpoint. The left panel is hidden and instead the footer bar displays navigation icons for Chat, Settings, and Scheduler. The user taps/clicks an icon to switch pages. The user center remains accessible from the footer area.

**Why this priority**: Ensures the app remains fully navigable on narrow/mobile screens. Without this, narrow-mode users would lose access to page switching, making the app unusable for a significant portion of users.

**Independent Test**: Can be fully tested by opening the app in a narrow window (below the breakpoint), verifying the footer bar shows page navigation icons, tapping each icon, and confirming the correct page loads.

**Acceptance Scenarios**:

1. **Given** the window width is below the wide-mode breakpoint, **When** the app loads, **Then** the left panel is NOT visible and the footer bar displays navigation icons for Chat, Settings, and Scheduler.
2. **Given** the footer bar shows navigation icons, **When** the user clicks the Settings icon, **Then** the Settings page is displayed and the Settings icon is visually highlighted as active.
3. **Given** the footer bar shows navigation icons, **When** the user clicks the Scheduler icon, **Then** the Scheduler page is displayed and the Scheduler icon is highlighted.
4. **Given** the narrow-mode footer bar, **When** the user looks at the footer, **Then** the user center (avatar/login) is accessible from the footer area.

---

### User Story 3 - Seamless Transition Between Wide and Narrow Mode (Priority: P3)

A user resizes their browser window from wide to narrow (or vice versa). The navigation seamlessly transitions between the left panel and the footer bar icons without losing the user's current page or requiring a page reload.

**Why this priority**: A smooth responsive transition avoids jarring layout shifts and ensures the user experience feels polished. Without it, users who resize frequently (or use split-screen workflows) would see broken layouts.

**Independent Test**: Can be fully tested by starting on a wide window displaying the left panel, navigating to Settings, then resizing below the breakpoint and verifying the footer icons appear with Settings still active — then resizing back and confirming the left panel returns with Settings still highlighted.

**Acceptance Scenarios**:

1. **Given** the user is on the Settings page in wide mode, **When** they resize the window below the breakpoint, **Then** the left panel disappears, footer navigation icons appear, and the Settings icon is highlighted as active.
2. **Given** the user is on the Chat page in narrow mode, **When** they resize the window above the breakpoint, **Then** the footer navigation icons are replaced by the left panel with the Chat tab highlighted.
3. **Given** the user resizes between modes, **When** the transition occurs, **Then** no page reload happens and the main content remains on the same page.

---

### User Story 4 - Theme Consistency Across Both Modes (Priority: P4)

Both the left panel (wide mode) and footer navigation icons (narrow mode) visually match the active theme (terminal or ChatGPT). The navigation elements use theme-appropriate colors, fonts, and styles.

**Why this priority**: The app already supports two distinct themes. New navigation elements must respect the theme system to avoid visual inconsistency.

**Independent Test**: Can be tested by switching between terminal and ChatGPT themes in both wide and narrow modes, verifying the left panel and footer icons adopt the correct theme styling.

**Acceptance Scenarios**:

1. **Given** the terminal theme is active and the window is wide, **When** the left panel renders, **Then** it uses terminal theme colors (dark background, green accents).
2. **Given** the ChatGPT theme is active and the window is narrow, **When** the footer navigation renders, **Then** it uses ChatGPT theme colors (light background, standard accents).

---

### Edge Cases

- What happens when the window width is exactly at the breakpoint? The system should consistently choose one mode (narrow) to avoid flickering.
- What happens if the user rapidly resizes the window back and forth across the breakpoint? The layout transition should be debounced or smooth, with no visual glitching or lost navigation state.
- What happens when a page is active and the user switches themes while in wide mode? The left panel should re-render with the new theme without losing the active page state.
- What happens when the user is logged out? The user center area at the bottom of the left panel should display a login option instead of the user avatar, consistent with current logged-out behavior.

## Clarifications

### Session 2026-02-23

- Q: Should the left panel in wide mode be collapsible or always fixed? → A: Always fixed and visible — the panel cannot be collapsed or minimized by the user.
- Q: Should tabs in the wide-mode left panel show icon + label, label only, or icon only? → A: Icon + label — each tab displays a recognizable icon alongside its text label.
- Q: Should the wide/narrow mode transition be animated or instant? → A: Instant — layout switches immediately with no slide animation when crossing the breakpoint.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST detect the window width and apply wide mode when the width exceeds the defined breakpoint, and narrow mode otherwise.
- **FR-002**: In wide mode, the application MUST display a vertical left panel containing navigation tabs for Chat, Settings, and Scheduler, each showing both a recognizable icon and a text label.
- **FR-003**: In wide mode, the user center (avatar/login menu) MUST be positioned at the bottom of the left panel.
- **FR-004**: In narrow mode, the application MUST display navigation icons for Chat, Settings, and Scheduler in the footer bar.
- **FR-005**: In narrow mode, the user center MUST remain accessible from the footer area (preserving current behavior).
- **FR-006**: Clicking/tapping a navigation tab (wide mode) or icon (narrow mode) MUST switch the displayed page to the corresponding page.
- **FR-007**: The currently active page tab or icon MUST be visually distinguished (highlighted) in both modes.
- **FR-008**: Transitioning between wide and narrow mode (by resizing) MUST preserve the currently active page without triggering a reload. The layout switch MUST be instant (no slide or fade animation).
- **FR-009**: All navigation elements (left panel, tabs, footer icons) MUST render correctly in both the terminal and ChatGPT themes.
- **FR-010**: The wide-mode breakpoint MUST be set at 768px window width (standard tablet/desktop threshold).

### Key Entities

- **Navigation Tab**: Represents a page destination (Chat, Settings, or Scheduler). Has a label, icon, route path, and active/inactive state. In wide mode, both icon and label are displayed; in narrow mode, only the icon is shown.
- **Left Panel**: A persistent, non-collapsible vertical sidebar visible only in wide mode. Always fixed and visible when above the breakpoint. Contains navigation tabs and the user center.
- **Footer Navigation**: A set of icons in the footer bar visible only in narrow mode. Provides the same page-switching functionality as the left panel tabs.

## Assumptions

- The 768px breakpoint is a reasonable default for distinguishing wide vs. narrow layouts. This aligns with common tablet/desktop breakpoints.
- The left panel width will be narrow enough (approximately 200-240px) to not significantly reduce the main content area on typical desktop screens.
- The three supported pages (Chat, Settings, Scheduler) are a fixed set for this feature. Adding new pages in the future should be straightforward but is outside scope.
- Navigation icons in narrow mode will use recognizable icons (e.g., chat bubble, gear, calendar) consistent with common UI patterns.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can switch between all three pages (Chat, Settings, Scheduler) using the left panel in wide mode within 1 click per page switch.
- **SC-002**: Users can switch between all three pages using footer icons in narrow mode within 1 tap per page switch.
- **SC-003**: Resizing the window across the breakpoint transitions the navigation layout within 200ms with no visible layout break or content loss.
- **SC-004**: The active page indicator is visible and correctly reflects the current page 100% of the time in both modes.
- **SC-005**: Both themes (terminal and ChatGPT) render the navigation elements without visual inconsistencies in both wide and narrow modes.
- **SC-006**: The user center is always accessible — in the left panel bottom (wide) or footer area (narrow) — regardless of mode.
