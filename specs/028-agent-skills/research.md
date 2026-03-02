# Research: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18

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

**Decision**: Skills are injected as system context into the LLM prompt, not as tool definitions in ToolRegistry
**Rationale**: Skills are instruction sets (natural language prompts), not executable tool functions. They don't have JSON schema parameters or return structured data. The agent already receives system prompts — skill instructions are appended when triggered. ToolRegistry integration (FR-017) means the approval system still gates any tools the skill's instructions tell the agent to use.
**Alternatives considered**:
- Register skills as tools in ToolRegistry: Would require fitting natural language instructions into a function-calling schema, which is unnatural. Skills don't have typed parameters.
- Custom Op type in protocol: Overengineered; skills modify the agent's context, not the execution protocol.

## R5: Auto-Invocation Strategy

**Decision**: Include skill metadata (name + description) in the agent's system prompt at session start. The LLM decides when a skill is relevant based on the description. When matched, the full skill body is loaded and injected.
**Rationale**: This follows the Agent Skills standard's progressive loading model (Level 1 → Level 2). The LLM is already responsible for deciding which tools to use based on descriptions — extending this to skills is natural. No keyword matching or embedding similarity needed.
**Alternatives considered**:
- Keyword/embedding matching: Adds complexity (embedding model, vector store) for marginal improvement over the LLM's native understanding.
- User-only invocation (no auto): Would require users to memorize skill names, reducing discoverability.

## R6: Trust Model Implementation

**Decision**: Add a `trusted` boolean field to the Skill record. User-created skills default to `trusted: true`. Imported skills default to `trusted: false`. Only trusted skills are included in auto-invocation metadata. Untrusted skills can still be manually invoked.
**Rationale**: Simple boolean flag is sufficient. The trust boundary is clear: user-created = trusted, URL-imported = untrusted until approved. No need for complex trust tiers or signature verification at this stage.
**Alternatives considered**:
- Content hash verification: Would detect tampering but adds complexity without a signing authority.
- Domain-based trust: Too restrictive and doesn't account for content quality.
