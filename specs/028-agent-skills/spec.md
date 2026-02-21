# Feature Specification: Agent Skills System

**Feature Branch**: `028-agent-skills`
**Created**: 2026-02-18
**Status**: Draft
**Input**: User description: "Skills system for browserx - Enable users to create, manage, and execute custom Agent Skills following the Agent Skills open standard (agentskills.io)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and Use a Custom Skill (Priority: P1)

A user wants to teach the agent a repeatable workflow. On desktop, the user creates a folder at `~/.airepublic-pi/skills/summarize-page/SKILL.md` with a name, description, and step-by-step instructions. On the Chrome extension, the user opens a skill editor in the sidepanel, fills in the same fields, and saves. The next time the agent starts a session, it discovers the new skill. The user can invoke the skill by typing `/summarize-page` in the chat input (manual invocation). Skills default to manual-only mode, but users can configure each skill's invocation mode in settings to also allow the agent to auto-invoke it when contextually relevant.

**Why this priority**: This is the core value proposition — without creating and using skills, nothing else matters.

**Independent Test**: Can be fully tested by creating a single skill with name + description + instructions, then verifying the agent discovers it at startup and follows the instructions when triggered.

**Acceptance Scenarios**:

1. **Given** a SKILL.md file exists at `~/.airepublic-pi/skills/my-skill/SKILL.md` with valid frontmatter, **When** the desktop app starts a new session, **Then** the skill appears in the list of available skills with its name and description, and is invocable via `/my-skill` in the chat input.
2. **Given** a skill named "summarize-page" in manual mode (default), **When** the user types `/summarize-page` in the chat input, **Then** the agent loads the full skill instructions and follows them.
3. **Given** a skill named "summarize-page" in hybrid mode, **When** the user asks "summarize this page for me" without using `/`, **Then** the agent recognizes the request matches the skill's description and auto-invokes it.
4. **Given** a user is on the Chrome extension, **When** they open the skill editor and fill in name, description, and instructions, **Then** the skill is saved and immediately available for use via `/skill-name`.
5. **Given** a skill with `$ARGUMENTS` in its body, **When** the user invokes it via `/skill-name some arguments`, **Then** the arguments are substituted into the skill instructions before the agent processes them.

---

### User Story 2 - Manage Skills (Priority: P2)

A user wants to view, edit, and delete their skills. They open a skills management section in the sidepanel settings. They see all discovered skills listed with name and description. They can select a skill to view its full instructions, edit any field, or delete it. On desktop, they can also choose to open the SKILL.md file in their external editor.

**Why this priority**: Users need to manage their skill library after creating skills — editing mistakes, removing outdated skills, and reviewing what's available.

**Independent Test**: Can be tested by pre-populating several skills, then verifying the management UI lists them, allows editing, and persists changes.

**Acceptance Scenarios**:

1. **Given** multiple skills exist across storage sources, **When** the user opens the skills management view, **Then** all skills are listed with their names and descriptions.
2. **Given** a user selects a skill to edit, **When** they change the description and save, **Then** the updated description is persisted and reflected in agent discovery.
3. **Given** a user deletes a skill, **When** they confirm deletion, **Then** the skill is removed from storage and no longer available to the agent.

---

### User Story 3 - Import Skills from URL (Priority: P3)

A user finds a useful skill shared online (e.g., a GitHub raw URL to a SKILL.md file). They use the import feature in the sidepanel, paste the URL, and the skill is fetched, parsed, and saved locally. On desktop, the imported skill is written as a folder in `~/.airepublic-pi/skills/`. On the Chrome extension, it is saved to IndexedDB.

**Why this priority**: Sharing and reusing community skills accelerates adoption, but users must be able to create and manage their own skills first.

**Independent Test**: Can be tested by hosting a valid SKILL.md at a URL, importing it, and verifying the skill is discoverable and executable.

**Acceptance Scenarios**:

1. **Given** a valid SKILL.md file hosted at a URL, **When** the user pastes the URL into the import dialog and confirms, **Then** the skill is fetched, parsed, and saved locally.
2. **Given** an imported URL returns invalid content (no frontmatter, missing name), **When** the import is attempted, **Then** the user sees a clear error message explaining what is wrong.
3. **Given** a skill with the same name already exists, **When** a user imports a skill with a duplicate name, **Then** the user is prompted to overwrite or rename before saving.

---

### User Story 4 - Export and Share Skills (Priority: P4)

A user wants to share a skill they created. They select a skill from the management view and export it. The export produces a valid SKILL.md file that can be shared via file transfer, repository, or URL. On desktop, the user can also simply share the skill folder directly from the filesystem.

**Why this priority**: Export completes the sharing loop but depends on the skill management UI being in place.

**Independent Test**: Can be tested by creating a skill, exporting it, and verifying the exported file is a valid SKILL.md that can be re-imported.

**Acceptance Scenarios**:

1. **Given** a skill exists in the system, **When** the user selects export, **Then** a valid SKILL.md file is generated and offered for download.
2. **Given** an exported SKILL.md, **When** it is re-imported on a different device, **Then** the skill works identically.

---

### Edge Cases

- What happens when a SKILL.md file has invalid YAML frontmatter? The system logs a warning and skips the skill, reporting it in the management UI as "invalid".
- What happens when two skills have the same name from different sources (filesystem and IndexedDB)? The system uses a priority order: filesystem skills take precedence over IndexedDB skills on desktop. On extension-only, IndexedDB is the sole source.
- What happens when a skill references files (e.g., `references/REFERENCE.md`) that don't exist? The agent reports the missing reference to the user and continues with available instructions.
- What happens when the `~/.airepublic-pi/skills/` directory doesn't exist on desktop? The system creates it on first launch.
- What happens when a skill's instructions exceed a reasonable size? Skills larger than 50KB are truncated with a warning, encouraging the user to use referenced files.
- How does the system handle concurrent edits (user edits via external editor while sidepanel is open on desktop)? The system detects file changes on next skill discovery cycle and reloads.

## Clarifications

### Session 2026-02-18

- Q: How should the system handle trust for imported skills (URL import injects untrusted content into agent context)? → A: Imported skills are flagged as "untrusted" and require explicit user approval before auto-invocation. Manual invocation is always allowed.
- Q: Should skills support per-project scoping in addition to global? → A: Global only. The agent has no project scope concept in either browser extension or desktop — all skills live in `~/.airepublic-pi/skills/` (desktop) or IndexedDB (extension).
- Q: Should users be able to temporarily disable a skill without deleting it? → A: No separate disable toggle needed. Setting the invocation mode to "manual" prevents auto-invocation. Users simply won't manually invoke skills they don't want.
- Q: Should skills be invoked via "/" prefix (like Claude Code) or natural language only? → A: Both. Skills use "/" prefix as the primary manual invocation method (integrating with the existing slash command system). Auto-invocation by the LLM is opt-in per skill via the invocation mode setting.
- Q: What should the default invocation mode be? → A: Manual. Users must explicitly opt-in to auto or hybrid mode per skill in settings. This gives users predictable, explicit control by default.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST discover skills from `~/.airepublic-pi/skills/` on desktop (Tauri) at session startup.
- **FR-002**: System MUST discover skills from IndexedDB on Chrome extension at session startup.
- **FR-003**: System MUST parse SKILL.md files following the Agent Skills open standard: YAML frontmatter (name, description) between `---` delimiters, followed by markdown body.
- **FR-004**: System MUST validate that every skill has at minimum a `name` (max 64 characters, lowercase + hyphens only) and `description` (max 1024 characters). System MUST reject skill names that conflict with existing built-in commands (e.g., "new", "help", "settings").
- **FR-005**: System MUST support progressive loading: load only name + description at startup (Level 1), load full body when triggered (Level 2), load referenced files on demand (Level 3).
- **FR-006**: System MUST support manual skill invocation via `/skill-name [arguments]` syntax in the chat input. When the user types `/`, the system MUST show a dropdown of available skills (integrating with the existing slash command system from 021-slash-commands).
- **FR-007**: System MUST support automatic skill invocation when the agent determines a user's request matches a skill's description. Auto-invocation is only active for skills configured in "auto" or "hybrid" mode.
- **FR-008**: System MUST perform variable substitution in skill content: `$ARGUMENTS` for all arguments, `$1`, `$2`, etc. for positional arguments.
- **FR-009**: System MUST provide a unified skill provider interface with platform-specific implementations (filesystem for desktop, IndexedDB for extension).
- **FR-010**: System MUST provide a skill editor UI in the sidepanel for creating and editing skills, with fields for name, description, and markdown body.
- **FR-011**: System MUST support importing skills from a URL by fetching and parsing a remote SKILL.md file.
- **FR-012**: System MUST support exporting skills as valid SKILL.md files.
- **FR-013**: System MUST support deleting skills from both filesystem (desktop) and IndexedDB (extension).
- **FR-014**: System MUST create the `~/.airepublic-pi/skills/` directory on first desktop launch if it does not exist.
- **FR-015**: System MUST gracefully handle invalid SKILL.md files (malformed YAML, missing required fields) by skipping them and logging warnings.
- **FR-016**: System MUST support optional frontmatter fields: `metadata` (key-value pairs), `allowed-tools` (space-delimited tool names), `compatibility` (environment requirements).
- **FR-017**: Skills execute within the same permission and risk-assessment framework as built-in tools. Since skill instructions are injected as system prompt context, all tool calls the agent makes while following a skill go through the existing approval pipeline. No additional integration required.
- **FR-018**: System MUST support three invocation modes per skill, configurable in settings:
  - **Manual** (default): Skill is only invocable via `/skill-name`. The agent cannot auto-invoke it. Skill description is NOT included in the agent's system prompt.
  - **Auto**: Skill is only invocable by the agent automatically. Skill description IS included in the agent's system prompt. Skill does NOT appear in the `/` command dropdown.
  - **Hybrid**: Skill is invocable both via `/skill-name` AND by the agent automatically. Skill description IS included in the system prompt AND appears in the `/` command dropdown.
- **FR-019**: System MUST default new skills (both user-created and imported) to "manual" invocation mode.
- **FR-020**: System MUST provide a per-skill invocation mode setting in the skill management UI, allowing users to switch between manual, auto, and hybrid modes.
- **FR-021**: System MUST flag skills imported from a URL as "untrusted" by default. Untrusted skills MUST NOT be available for auto-invocation (even if set to auto or hybrid mode) until the user explicitly approves them. Manual invocation of untrusted skills via `/` is always permitted.
- **FR-022**: System MUST allow users to mark an untrusted skill as "trusted" after review, enabling auto-invocation if the skill's mode is set to auto or hybrid.
- **FR-023**: System MUST register skills with the existing slash command system (CommandRegistry from 021-slash-commands) so that `/skill-name` appears alongside built-in commands in the command dropdown.

### Key Entities

- **Skill**: A reusable instruction set with a unique name, description, optional metadata, an invocation mode (manual, auto, or hybrid), a trust status (trusted or untrusted), and a markdown body containing agent instructions. New skills default to manual mode and trusted status (user-created) or untrusted (imported). May include references to supporting files.
- **SkillProvider**: A platform-specific adapter responsible for discovering, loading, saving, and deleting skills from the underlying storage (filesystem or IndexedDB).
- **SkillRegistry**: The central coordinator that manages skill lifecycle — discovery at startup, lookup by name, triggering based on user requests, and variable substitution before passing instructions to the agent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a new skill and have it available for use within the same session (no app restart required on save via UI).
- **SC-002**: Skill discovery at startup completes within 500ms for up to 50 skills.
- **SC-003**: Skills configured in auto or hybrid mode are correctly matched and invoked by the agent for at least 90% of requests that clearly match a skill's description.
- **SC-007**: Users can invoke any skill via `/skill-name` in the chat input, and skills appear in the slash command dropdown alongside built-in commands.
- **SC-008**: Users can change a skill's invocation mode (manual/auto/hybrid) in settings and the change takes effect immediately without restarting the session.
- **SC-004**: Users can import a skill from a URL in under 3 steps (paste URL, preview, confirm).
- **SC-005**: All skills created on desktop as SKILL.md files are fully compatible with other tools that support the Agent Skills open standard.
- **SC-006**: Invalid skills (malformed YAML, missing fields) never crash the system — they are skipped with a user-visible warning.
