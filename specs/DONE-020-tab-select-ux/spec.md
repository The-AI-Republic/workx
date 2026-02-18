# Feature Specification: Tab Select Menu UX Improvements

**Feature Branch**: `020-tab-select-ux`
**Created**: 2026-02-14
**Status**: Draft
**Input**: User description: "Currently for the chrome extension app browser, we show select tab menu for user to select the tab to work on, let's do following changes instead: 1. when mouse hover to the tab option, we should use tooltip to show the full name of tab title 2. mark '(current)' to the active tab, when active tab changed, the component will reactively change the (current) prefix as well."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tooltip on Tab Option Hover (Priority: P1)

When users open the tab selection dropdown, tab titles may be truncated due to limited width. Users need a way to see the full tab title before selecting a tab. When a user hovers over any tab option in the dropdown menu, a tooltip appears showing the full, untruncated tab title.

**Why this priority**: Users cannot make informed tab selection decisions when titles are cut off. Seeing the full title is essential for distinguishing between similarly-named tabs (e.g., multiple Google Docs or GitHub pages).

**Independent Test**: Can be fully tested by opening the tab dropdown, hovering over a tab with a long title, and verifying the tooltip displays the complete title.

**Acceptance Scenarios**:

1. **Given** the tab dropdown is open and a tab has a title longer than the visible area, **When** the user hovers over that tab option, **Then** a tooltip appears showing the full tab title.
2. **Given** the tab dropdown is open and a tab has a short title that fits entirely, **When** the user hovers over that tab option, **Then** a tooltip still appears showing the full title (consistent behavior).
3. **Given** the user hovers over the "Create New Tab" option, **When** the tooltip would normally appear, **Then** no tooltip is needed since the text is short and fully visible (or optionally a tooltip is shown for consistency).

---

### User Story 2 - Active Tab "(current)" Marker (Priority: P1)

Users need to quickly identify which tab in the dropdown is the browser's currently active (focused) tab. The active tab in the dropdown list is prefixed with "(current)" text. When the user switches the active tab in the browser, the "(current)" marker reactively moves to the newly active tab without requiring the dropdown to be closed and reopened.

**Why this priority**: Equally important as tooltips — knowing which tab is currently active helps users orient themselves and make correct tab selections, especially when working with many open tabs.

**Independent Test**: Can be fully tested by opening the dropdown, observing the "(current)" marker on the active tab, switching tabs in the browser, reopening the dropdown, and verifying the marker moved to the new active tab.

**Acceptance Scenarios**:

1. **Given** the tab dropdown is open, **When** the user views the list of tabs, **Then** the browser's currently active tab is displayed with a "(current)" prefix before its title.
2. **Given** the browser's active tab changes (user switches tabs), **When** the dropdown is opened again, **Then** the "(current)" marker appears on the newly active tab and is removed from the previously active tab.
3. **Given** a tab is both the active tab and the selected tab for the session, **When** the user views the dropdown, **Then** the tab shows both the "(current)" prefix and the selected checkmark indicator.
4. **Given** the "Create New Tab" option is shown, **When** it is not a real browser tab, **Then** it never receives the "(current)" marker.

---

### Edge Cases

- What happens when the active tab is a Chrome internal page that is filtered out of the dropdown? The "(current)" marker simply doesn't appear on any tab in the list.
- What happens when no tabs are available? The "No tabs available" message is shown without any "(current)" marker.
- What happens when a tab title is empty or missing? The tooltip shows the fallback title (hostname or "Untitled"), and "(current)" is prefixed to that fallback text.
- What happens when the active tab changes while the dropdown is already open? The "(current)" marker reactively updates in real-time within the open dropdown.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST display a tooltip showing the full tab title when the user hovers over any tab option in the dropdown menu.
- **FR-002**: The tooltip MUST show the complete, untruncated tab title text, including for tabs with fallback titles (hostname or "Untitled").
- **FR-003**: System MUST display a "(current)" text prefix on the tab option that corresponds to the browser's currently active tab.
- **FR-004**: The "(current)" marker MUST reactively update when the browser's active tab changes, both when the dropdown is closed and when it is open.
- **FR-005**: The "(current)" marker MUST NOT appear on the "Create New Tab" option.
- **FR-006**: The "(current)" prefix and the existing selected checkmark indicator MUST be able to appear on the same tab simultaneously (they represent different concepts: active vs. selected).
- **FR-007**: Tooltip and "(current)" marker MUST work correctly in both terminal and chatgpt themes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can see the full title of any tab in the dropdown by hovering over it, regardless of title length.
- **SC-002**: Users can identify the browser's currently active tab at a glance when the dropdown is open.
- **SC-003**: The "(current)" marker updates correctly within 1 second of the active tab changing in the browser.
- **SC-004**: Both features work consistently across the terminal and chatgpt visual themes.

## Assumptions

- The existing Tooltip component (already imported and used in TabContext.svelte) can be reused for dropdown item tooltips.
- The browser tab object's `active` property reliably indicates the currently active tab in the window.
- The browser's tab activation event can be used to reactively detect active tab changes.
- The "(current)" text is displayed as a prefix in the format "(current) Tab Title" rather than as a suffix or separate visual indicator.
