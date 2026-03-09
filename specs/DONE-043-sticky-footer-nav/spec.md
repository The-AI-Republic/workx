# Feature Specification: Sticky Footer Navigation Bar

**Feature Branch**: `043-sticky-footer-nav`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "let's make the footer bar always showing up in the page switch (like iphone app bottom bar) in narrow screen mode (wide screen mode has side bar instead, so no need to change so far)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persistent navigation across all pages (Priority: P1)

A user on a narrow screen navigates from the Chat page to the Scheduler or Skills page. They see a persistent bottom navigation bar (iPhone-style) with icons for Chat, Scheduler, and Skills, allowing them to switch between pages without needing the browser back button.

**Why this priority**: This is the core value — without persistent nav, users on narrow screens get stranded on non-Chat pages with no obvious way to navigate back.

**Independent Test**: Navigate to any page in narrow mode and verify the bottom nav bar is visible and functional.

**Acceptance Scenarios**:

1. **Given** the user is on the Chat page in narrow mode, **When** they look at the bottom of the screen, **Then** they see a navigation bar with Chat, Scheduler, and Skills icons (same as today).
2. **Given** the user is on the Scheduler page in narrow mode, **When** they look at the bottom of the screen, **Then** they see the same navigation bar with the Scheduler icon highlighted as active.
3. **Given** the user is on the Skills page in narrow mode, **When** they tap the Chat icon in the bottom nav, **Then** they are navigated to the Chat page and the Chat icon becomes active.
4. **Given** the user is in wide mode on any page, **When** they look at the layout, **Then** the sidebar remains the primary navigation and the bottom nav behavior is unchanged.

---

### User Story 2 - Footer does not overlap page content (Priority: P2)

The persistent footer bar does not cover or overlap any page content. All pages properly account for the footer height so content remains scrollable and fully visible.

**Why this priority**: A persistent footer that covers content is worse than no footer at all.

**Independent Test**: On each page in narrow mode, scroll to the bottom of content and verify nothing is hidden behind the footer.

**Acceptance Scenarios**:

1. **Given** the Chat page has many messages in narrow mode, **When** the user scrolls to the bottom, **Then** the last message is fully visible above the footer bar.
2. **Given** the Scheduler page has content in narrow mode, **When** the user scrolls down, **Then** all content is visible and not obscured by the footer.

---

### Edge Cases

- Window resizes from narrow to wide mode while on the Scheduler page: footer disappears and sidebar appears (existing responsive behavior preserved).
- Settings page is a modal overlay: footer should remain visible underneath since Settings overlays the current page.
- Chat page currently embeds FooterBar inside its layout — this must be removed to avoid duplication after the footer moves to the shell level.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: In narrow mode (<1500px), the navigation footer bar MUST be visible on all pages (Chat, Scheduler, Skills, Settings).
- **FR-002**: The footer bar MUST show the same navigation icons (Chat, Scheduler, Skills) and user login status as it does today.
- **FR-003**: The active page MUST be visually indicated in the footer nav (highlighted icon).
- **FR-004**: In wide mode (>=1500px), the footer MUST remain minimal (current behavior unchanged — sidebar handles navigation).
- **FR-005**: The footer bar MUST NOT overlap or obscure page content on any page.
- **FR-006**: The FooterBar MUST be removed from the Chat page's internal layout to avoid duplication.
- **FR-007**: Theme support (terminal/modern) MUST be preserved for the footer bar in its new position.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Footer navigation bar is visible on all pages in narrow mode.
- **SC-002**: Users can navigate between all pages using the footer bar from any page.
- **SC-003**: No content is obscured by the footer bar on any page.
- **SC-004**: Wide mode layout and behavior is completely unchanged.
- **SC-005**: Both terminal and modern themes render correctly with the relocated footer.
