# Research: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18 | **Updated**: 2026-02-20

## R1: YAML Parsing Library Selection

**Decision**: Use `yaml` (v2.x) npm package
**Rationale**: The codebase has no existing YAML parser. The `yaml` package is the modern successor to `js-yaml`, supports YAML 1.2, has TypeScript types built-in, and handles frontmatter extraction cleanly. It's lightweight (~50KB) and well-maintained.
**Alternatives considered**:
- `js-yaml`: Older, YAML 1.1 only, separate `@types/js-yaml` needed. Still widely used but less maintained.
- `gray-matter`: Full frontmatter parser (YAML + markdown split). Convenient but pulls in additional dependencies and is overkill since we only need basic YAML parsing.
- Custom regex parser: Minimal dependency but fragile for edge cases (multi-line strings, special characters). Not worth the maintenance risk.

## R2: Skill Storage Pattern for Chrome Extension

**Decision**: Use existing StorageProvider interface with a new `skills` collection in IndexedDB
**Rationale**: The StorageProvider already supports `get`, `set`, `delete`, `list`, and `query` operations with collection-based organization. Adding a `skills` collection follows the established pattern used by `conversations`, `messages`, `memory`, etc. No new storage abstraction needed.
**Alternatives considered**:
- Origin Private File System (OPFS): Provides real folder semantics but adds complexity without benefit since users can't manually add files anyway. OPFS also requires Web Worker context for synchronous access.
- Separate IndexedDB store: Unnecessary isolation; the existing StorageProvider handles multi-collection cleanly.

## R3: Filesystem Skill Discovery on Desktop (Tauri)

**Decision**: Use Tauri's filesystem plugin via `invoke()` commands to scan `~/.airepublic-pi/skills/`
**Rationale**: Desktop already uses Tauri `invoke()` for all filesystem operations (SQLiteStorageProvider, TauriConfigStorage). Adding new Rust commands for skill directory scanning follows the established pattern. The Rust backend handles filesystem access securely within Tauri's permission model.
**Alternatives considered**:
- `@tauri-apps/plugin-fs` JavaScript API: Direct filesystem access from frontend, but less consistent with existing patterns that use custom Rust commands.
- Node.js fs module: Not available in Tauri's WebView context.

## R4: Skill Invocation Mechanism

**Decision**: Skills support dual invocation — manual via `/skill-name` (integrated with CommandRegistry from 021-slash-commands) and automatic via LLM context injection, controlled by a per-skill invocation mode setting.
**Rationale**: Following Claude Code's design pattern, skills are invoked primarily through the `/` prefix (predictable, explicit UX) and optionally through LLM auto-invocation (contextual intelligence). The three-mode system (manual, auto, hybrid) gives users full control. Manual mode is the default for safety — users must explicitly opt-in to LLM-driven invocation.
**Alternatives considered**:
- Auto-invocation only (original design): Unpredictable — LLM may pick wrong skill or miss relevant ones. No structured invocation syntax.
- Manual-only (no auto): Would miss the progressive intelligence benefit where the agent proactively uses skills.
- Register skills as tools in ToolRegistry: Would require fitting natural language instructions into a function-calling schema, which is unnatural. Skills don't have typed parameters.

## R5: Auto-Invocation Strategy

**Decision**: Include skill metadata (name + description) in the agent's system prompt at session start, but ONLY for skills in "auto" or "hybrid" mode that are also trusted. The LLM decides when a skill is relevant based on the description. When matched, the full skill body is loaded and injected.
**Rationale**: This follows the Agent Skills standard's progressive loading model (Level 1 → Level 2). The LLM is already responsible for deciding which tools to use based on descriptions — extending this to skills is natural. Limiting auto-invocation to opted-in skills prevents unexpected behavior.
**Alternatives considered**:
- Include all skill descriptions in prompt (original design): Pollutes system prompt with skills the user may not want auto-invoked. Wastes context tokens.
- Keyword/embedding matching: Adds complexity (embedding model, vector store) for marginal improvement over the LLM's native understanding.

## R6: Trust Model Implementation

**Decision**: Add a `trusted` boolean field to the Skill record. User-created skills default to `trusted: true`. Imported skills default to `trusted: false`. Trust interacts with invocation mode: untrusted skills can always be manually invoked via `/`, but cannot auto-invoke even if set to "auto" or "hybrid" mode.
**Rationale**: Simple boolean flag is sufficient. The trust boundary is clear: user-created = trusted, URL-imported = untrusted until approved. Separating trust from invocation mode keeps both concepts clean.
**Alternatives considered**:
- Content hash verification: Would detect tampering but adds complexity without a signing authority.
- Domain-based trust: Too restrictive and doesn't account for content quality.

## R7: Slash Command Integration Pattern

**Decision**: Register each skill as a command in the existing CommandRegistry when skills are discovered. Skills in "manual" or "hybrid" mode get registered; "auto" mode skills do not. The command `action` function calls `SkillRegistry.invoke()` which loads the full skill body, substitutes variables, and injects into agent context.
**Rationale**: The CommandRegistry from 021-slash-commands already handles `/` prefix detection, dropdown UI, filtering, and execution. Registering skills as commands requires zero UI changes — skills automatically appear in the dropdown alongside built-in commands (`/new`, `/help`, `/settings`). The `argumentHint` field maps naturally to skill argument patterns (`$ARGUMENTS`, `$1`, `$2`).
**Alternatives considered**:
- Separate skill dropdown UI: Duplicates existing command infrastructure. More code to maintain, inconsistent UX.
- Override MessageInput to handle skills specially: Fragile coupling to input component internals.

## R8: Invocation Mode Setting Storage

**Decision**: Store `invocationMode` as a field on the Skill entity itself (enum: "manual" | "auto" | "hybrid", default "manual"). On desktop, stored in `.skill-meta.json` sidecar file. On extension, stored in IndexedDB skill record.
**Rationale**: The invocation mode is a per-skill user preference, not part of the Agent Skills standard. Storing it in the sidecar file (desktop) keeps the SKILL.md standard-compliant while preserving user settings. IndexedDB naturally accommodates additional fields.
**Alternatives considered**:
- Store in SKILL.md frontmatter: Would add non-standard fields to the portable format, breaking compatibility with other tools.
- Store in a separate global config: Makes skill export/import lose the mode setting.
