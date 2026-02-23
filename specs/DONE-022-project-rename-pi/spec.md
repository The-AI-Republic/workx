# Feature Specification: Project Rename — Pi Naming Convention

**Feature Branch**: `022-project-rename-pi`
**Created**: 2026-02-16
**Status**: Draft
**Input**: User description: "Rename project from browserx to Pi, with BrowserX as chrome extension name and Apple Pi as desktop app name"

## Naming Convention

This specification establishes a three-tier naming convention:

| Context              | Name       | Usage                                                                          |
|----------------------|------------|--------------------------------------------------------------------------------|
| **Project / Repo**   | Pi         | GitHub repo name, package name, project-level references, code-level identifier |
| **Chrome Extension** | BrowserX   | User-facing name in extension UI, Chrome Web Store, manifest, locales          |
| **Desktop App**      | Apple Pi   | User-facing name in desktop UI, window title, app store listing                |

**Critical Rule**: "Apple Pi" is exclusively a user-facing display name. In code (variables, class names, file paths, event names, CSS tokens), the shorter form "pi" is used. Users see "Apple Pi" in window titles, about screens, and documentation. Developers see "pi" in code.

**Rename Scope Rule**: Only general project-level / shared code (`src/core/`, `src/tools/`, `src/models/`, `src/desktop/`, project root configs) is renamed from `browserx` → `pi`. Chrome extension-specific code (`src/extension/`, `_locales/`, extension prompt files) keeps `browserx` naming since BrowserX is the legitimate extension product name.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chrome Extension Branding Consistency (Priority: P1)

A user installs the Chrome extension from the Chrome Web Store. Throughout their experience — from the store listing to the extension popup, side panel, cursor label, and system prompts — they see the name "BrowserX" consistently.

**Why this priority**: Chrome extension is the primary product surface and highest-traffic user touchpoint. Users must see a consistent brand identity.

**Independent Test**: Install the extension, open the side panel, interact with the agent, and verify "BrowserX" appears in all user-visible locations (extension name, action title, command descriptions, cursor label, system prompt greeting).

**Acceptance Scenarios**:

1. **Given** a user views the extension in Chrome extensions page, **When** they look at the extension name, **Then** they see "BrowserX"
2. **Given** a user hovers over the extension icon, **When** the tooltip appears, **Then** it reads "BrowserX Agent"
3. **Given** a user triggers the keyboard shortcut, **When** the side panel opens, **Then** the command description references "BrowserX"
4. **Given** a user interacts with the agent, **When** the cursor visual effect appears, **Then** the label shows "BrowserX" (correctly capitalized)
5. **Given** a user starts a conversation, **When** the agent introduces itself, **Then** the system prompt identifies it as "BrowserX"

---

### User Story 2 - Desktop App Branding (Priority: P1)

A user launches the desktop application. They see "Apple Pi" as the application name in the window title, about screen, and any user-facing descriptions. Internally, all code references use "pi" (lowercase).

**Why this priority**: Desktop app is the second major product surface. Consistent branding is essential for user trust and product identity.

**Independent Test**: Launch the Tauri desktop app and verify the window title shows "Apple Pi", the app description references "Apple Pi", and the deep-link scheme remains functional.

**Acceptance Scenarios**:

1. **Given** a user launches the desktop app, **When** the window appears, **Then** the title bar reads "Apple Pi"
2. **Given** a user views the app in their operating system's application list, **When** they look at the app name, **Then** they see "Apple Pi"
3. **Given** a user views the app's about or description, **When** they read the description, **Then** it references "Apple Pi" as the product name
4. **Given** a user triggers a deep-link, **When** the URL scheme is used, **Then** it uses the "airepublic-pi" scheme (code-level, not user-facing)

---

### User Story 3 - Project-Level Naming (Priority: P2)

A developer clones the repository, reads the README, and sees the project referred to as "Pi" with clear explanation that it ships as "BrowserX" (Chrome extension) and "Apple Pi" (desktop app).

**Why this priority**: Developer-facing naming affects onboarding, documentation clarity, and ecosystem consistency. Important but secondary to user-facing branding.

**Independent Test**: Clone the repo, read the README, check package.json name, and verify the project identity is "Pi" throughout developer-facing materials.

**Acceptance Scenarios**:

1. **Given** a developer reads the README, **When** they look at the project heading, **Then** it reads "Pi" (not "BrowserX")
2. **Given** a developer checks the package configuration, **When** they look at the name field, **Then** it reflects the "pi" project name
3. **Given** a developer reads the README, **When** they look for build targets, **Then** the README explains both "BrowserX" (extension) and "Apple Pi" (desktop) as build outputs of the "Pi" project

---

### User Story 4 - Shared/Core Code Naming Modernization (Priority: P2)

A developer working on the shared codebase (`src/core/`, `src/tools/`, `src/models/`) encounters consistent naming: the core agent class and shared data attributes use "pi" instead of "browserx". Extension-specific code (`src/extension/`) retains "browserx" naming since BrowserX is the extension product name.

**Why this priority**: Code consistency reduces confusion and maintenance burden. Secondary to user-facing changes because it doesn't affect end users directly.

**Independent Test**: Search the shared codebase (`src/core/`, `src/tools/`) for "browserx" references and verify they have been updated to "pi" equivalents. Verify extension-specific code (`src/extension/`) still uses "browserx".

**Acceptance Scenarios**:

1. **Given** a developer searches for the agent class, **When** they look in the core directory, **Then** they find `PiAgent` (not `BrowserxAgent`)
2. **Given** a developer checks shared data attributes, **When** they search in `src/tools/`, **Then** they find `data-pi-injected` instead of `data-browserx-injected`
3. **Given** a developer inspects extension CSS custom properties, **When** they look at the design tokens in `src/extension/`, **Then** they still see `--browserx-primary`, `--browserx-secondary` (extension-specific, unchanged)
4. **Given** a developer looks at extension custom events, **When** they search in `src/extension/`, **Then** they still find `browserx:trigger-ripple`, `browserx:show-visual-effect` (extension-specific, unchanged)

---

### User Story 5 - Localization Consistency (Priority: P3)

All 50+ language locale files reflect the correct branding: "BrowserX" as the extension name across all languages. Locale message keys keep `browserx` naming since locales are Chrome extension-specific (Chrome i18n).

**Why this priority**: Localization affects international users. Important for completeness but the English locale (highest traffic) is covered in P1.

**Independent Test**: Open locale files for 3+ languages, verify extension_name is "BrowserX", and verify message keys and values are consistent.

**Acceptance Scenarios**:

1. **Given** a user switches their browser language to French, **When** they view the extension, **Then** the extension name displays as "BrowserX"
2. **Given** a developer checks locale message keys, **When** they look at key names, **Then** they see `browserx` naming retained (locales are extension-specific)

---

### Edge Cases

- What happens when a user has the old version installed and upgrades? Extension name in Chrome remains "BrowserX" (unchanged for extension users). Desktop app name updates from "Pi" to "Apple Pi" automatically.
- How does the system handle existing bookmarks, shortcuts, or saved references? Deep-link schemes use "airepublic-pi" (already in place), Chrome extension ID is unchanged.
- What happens to existing git history and references? Git history is preserved; only forward-looking references change. No history rewrite.
- How are prompt files handled? Extension prompt files (`default_browserx_agent_prompt.md`, `browserx_intro.md`, `browserx_tools.md`) keep their names since they are extension-specific. Desktop prompt (`default_pi_agent_prompt.md`) keeps its name and has content updated to say "Apple Pi".
- What about the `CLAUDE.md` file? It contains extensive documentation referencing "browserx" — these references should be updated to "pi" in code-level contexts while preserving "BrowserX" for extension-specific documentation.
- What happens to existing forks and clones after the GitHub repo rename? GitHub provides automatic redirects from the old URL for a period, but contributors must update their git remotes manually.

## Requirements *(mandatory)*

### Functional Requirements

#### Project-Level (GitHub / npm)

- **FR-001**: The npm package name MUST be updated from `browserx-chrome` to `pi`
- **FR-002**: The README MUST reference the project as "Pi" in headings and descriptions
- **FR-003**: The README MUST clearly explain the three naming tiers: Pi (project), BrowserX (extension), Apple Pi (desktop)
- **FR-004**: The CHANGELOG MUST reference "Pi" as the project name going forward
- **FR-004a**: The GitHub repository MUST be renamed from `browserx` to `pi` (via GitHub Settings)
- **FR-004b**: All git remote URLs in documentation (README clone instructions, contributing guides) MUST be updated from `browserx.git` to `pi.git`
- **FR-004c**: Any CI/CD configuration referencing the old repo name MUST be updated

#### Chrome Extension (User-Facing: "BrowserX")

- **FR-005**: The Chrome extension manifest `extension_name` MUST remain "BrowserX"
- **FR-006**: The manifest action `default_title` MUST display "BrowserX Agent"
- **FR-007**: The manifest command description MUST reference "BrowserX side panel"
- **FR-008**: All 50+ locale files MUST retain "BrowserX" as the `extension_name` message value
- **FR-009**: The extension agent prompt (`default_browserx_agent_prompt.md`) MUST keep its filename and identify itself as "BrowserX"
- **FR-010**: The cursor visual effect label MUST display "BrowserX" (capitalized correctly, not lowercase "browserx")

#### Desktop App (User-Facing: "Apple Pi")

User-facing UI surfaces (where the user directly sees the name) use "Apple Pi":

- **FR-011**: The Tauri `productName` MUST be updated from "Pi" to "Apple Pi" (OS app name visible to user)
- **FR-012**: The Tauri window `title` MUST display "Apple Pi" (title bar visible to user)
- **FR-015**: The desktop HTML page title MUST display "Apple Pi" (currently "BrowserX Desktop")
- **FR-016**: The desktop agent prompt (`default_pi_agent_prompt.md`) MUST identify itself as "Apple Pi" (LLM identity visible to user)

Non-UI config and code-level values stay "Pi" / "pi":

- **FR-013**: The Tauri `shortDescription` MUST stay as "Pi" (config metadata, not directly visible in UI)
- **FR-014**: The Tauri `longDescription` MUST stay as "Pi" (config metadata, not directly visible in UI)
- **FR-017**: The Tauri `identifier` MUST remain `com.airepublic.pi` (code-level, unchanged)
- **FR-018**: The Cargo package name MUST remain `pi` (code-level, unchanged)
- **FR-019**: The deep-link scheme MUST remain `airepublic-pi` (code-level, unchanged)

#### Shared/Core Code Renaming (rename `browserx` → `pi`)

These are in shared directories (`src/core/`, `src/tools/`, project root) used by both extension and desktop:

- **FR-020**: The core agent class MUST be renamed from `BrowserxAgent` to `PiAgent` (`src/core/BrowserxAgent.ts`)
- **FR-021**: All imports referencing `BrowserxAgent` MUST be updated to `PiAgent` (in both `src/extension/` and `src/desktop/`)
- **FR-024**: Data attributes in shared tools MUST be renamed from `data-browserx-*` to `data-pi-*` (`src/tools/dom/plugins/GoogleDocPlugin.ts`)
- **FR-029**: Static assets with `browserx` in the filename (e.g., `browserx_UI.png`) MUST be renamed to use `pi` (project-level, referenced only in README)
- **FR-030**: The source file `BrowserxAgent.ts` MUST be renamed to `PiAgent.ts`

#### Chrome Extension Code (keep `browserx` — BrowserX is the product name)

These are in extension-specific directories (`src/extension/`, `_locales/`, extension prompt files):

- **FR-022**: CSS custom properties `--browserx-*` MUST keep their current names (`src/extension/sidepanel/sidepanel.css` — extension-specific styling)
- **FR-023**: Custom event names `browserx:*` MUST keep their current names (`browserx:trigger-ripple`, `browserx:show-visual-effect`, `browserx:stop-agent` — extension visual effects)
- **FR-025**: Internal event title value `'browserx'` in chat event processing MUST keep its current name (`src/extension/sidepanel/pages/chat/Main.svelte` — extension UI)
- **FR-026**: Prompt fragment files (`browserx_intro.md`, `browserx_tools.md`) MUST keep their current names
- **FR-027**: The extension agent prompt file `default_browserx_agent_prompt.md` MUST keep its current name
- **FR-028**: Localization message keys containing `browserx` MUST keep their current names (`_locales/` — Chrome i18n, extension-only)

### Key Entities

- **Naming Tier**: A mapping between context (project, extension, desktop) and the display name used in that context
- **Locale File**: JSON translation file containing user-facing strings, keyed by message identifier
- **System Prompt**: Markdown file defining the agent's identity and behavior instructions
- **CSS Design Token**: CSS custom property defining a theme value (color, spacing, etc.)
- **Custom Event**: Browser CustomEvent with namespaced name for internal communication

## Clarifications

### Session 2026-02-16

- Q: What should the exact npm package name be? → A: `pi` (unified project name)
- Q: Is actual GitHub repo rename in scope? → A: Yes, include repo rename + update all git remote references
- Q: How should agent prompt identity work for extension vs desktop? → A: Already split — `default_browserx_agent_prompt.md` (extension, keeps name since BrowserX is the extension product name) and `default_pi_agent_prompt.md` (desktop, update content to say "Apple Pi").
- Q: Which code uses `browserx` naming vs `pi`? → A: Only general project-level/shared code (`src/core/`, `src/tools/`, project root) renames to `pi`. Chrome extension-specific code (`src/extension/`, `_locales/`, extension prompts) keeps `browserx` since BrowserX is the extension product name.
- Q: Where does "Apple Pi" appear vs "Pi"? → A: "Apple Pi" only in UI surfaces users directly see (app name, window title, HTML page title, LLM system prompt identity). All other code and config (descriptions, identifiers, Cargo name, deep-links) stays "Pi" / "pi".

## Assumptions

- The Chrome extension ID (assigned by Chrome Web Store) does not change — only display names and internal code references change
- The Tauri app identifier (`com.airepublic.pi`) and deep-link scheme (`airepublic-pi`) remain unchanged as they are code-level
- The Cargo crate name remains `pi` as it is code-level
- Git history is preserved; this is a forward-looking rename, not a history rewrite
- Extension-specific CSS (`--browserx-*`), custom events (`browserx:*`), locale keys, and prompt files retain `browserx` naming — no rename needed
- Prompt files use the appropriate user-facing name in content ("BrowserX" for extension, "Apple Pi" for desktop)
- The image file `browserx_UI.png` can be renamed without breaking external references (only referenced in README)
- The manifest resource path `prompts/default_browserx_agent_prompt.md` stays unchanged (BrowserX is the extension product name)
- The desktop prompt file `default_pi_agent_prompt.md` already exists and only needs content update (identity: "Apple Pi")
- GitHub provides automatic URL redirects after repo rename, but contributors should update their git remotes

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero occurrences of "browserx" (case-insensitive) in shared/core code (`src/core/`, `src/tools/`, `src/models/`, `src/desktop/`, project root configs). Extension-specific code (`src/extension/`, `_locales/`, extension prompts) retains `browserx` as the legitimate product name.
- **SC-002**: 100% of user-facing Chrome extension surfaces display "BrowserX" (extension name, action title, command description, cursor label, system prompt)
- **SC-003**: 100% of user-facing desktop app surfaces display "Apple Pi" (window title, app name, descriptions)
- **SC-004**: All 50+ locale files pass validation with "BrowserX" as extension_name value
- **SC-005**: The project builds successfully for both Chrome extension and Tauri desktop targets after all renames
- **SC-006**: All existing tests pass after the rename (adjusted for new naming)
- **SC-007**: README clearly communicates the three-tier naming convention within the first 10 lines
