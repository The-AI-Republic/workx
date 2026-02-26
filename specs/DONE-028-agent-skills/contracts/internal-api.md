# Internal API Contracts: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18 | **Updated**: 2026-02-20

These are internal TypeScript interfaces — not external REST/GraphQL APIs. The skills system is entirely client-side.

## Core Types (`src/core/skills/types.ts`)

```typescript
/** Invocation mode controls how a skill can be triggered */
export type InvocationMode = 'manual' | 'auto' | 'hybrid';

/** Full skill record */
export interface Skill {
  name: string;
  description: string;
  body: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
  sourceUrl?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  compatibility?: string;
  createdAt: string;
  updatedAt: string;
}

/** Level 1 metadata — loaded at startup for all skills */
export interface SkillMeta {
  name: string;
  description: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
}

/** Result of parsing a SKILL.md file */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** YAML frontmatter fields from SKILL.md (standard-compliant, no invocationMode) */
export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  compatibility?: string;
}

/** Skill with resolved references (Level 3) */
export interface SkillWithReferences extends Skill {
  references: Record<string, string>;
}
```

## CommandRegistry Extension (`src/extension/sidepanel/commands/CommandRegistry.ts`)

The existing CommandRegistry needs one new method to support skill invocation mode switching:

```typescript
/** Unregister a command by name. Returns true if removed, false if not found. */
unregister(name: string): boolean;
```

This is required because when a skill's invocation mode changes to "auto", it must be removed from the `/` dropdown. Without `unregister()`, the only option is `reset()` which clears ALL commands including built-ins.

## Command Registry Interface for Dependency Injection

SkillRegistry (a core module) must not import directly from the extension layer. Instead, it accepts a command registry via constructor injection:

```typescript
/** Minimal interface for command registration — used by SkillRegistry via DI */
export interface ICommandRegistry {
  register(registration: { name: string; description: string; argumentHint?: string; action: (args?: string) => void | Promise<void> }): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
}
```

The existing `commandRegistry` singleton satisfies this interface. It is passed to `SkillRegistry` at initialization time by the platform-specific bootstrap code (BrowserxAgent or equivalent).

## SkillProvider Interface (`src/core/skills/SkillProvider.ts`)

```typescript
/** Platform-agnostic skill storage interface */
export interface ISkillProvider {
  /** Initialize the provider (create directories, open connections) */
  initialize(): Promise<void>;

  /** List all skill metadata (Level 1 — name + description + invocationMode) */
  listMeta(): Promise<SkillMeta[]>;

  /** Load a full skill by name (Level 2 — includes body) */
  load(name: string): Promise<Skill | null>;

  /** Load a referenced file from a skill (Level 3) */
  loadReference(skillName: string, refPath: string): Promise<string | null>;

  /** Save a skill (create or update) */
  save(skill: Skill): Promise<void>;

  /** Delete a skill by name */
  delete(name: string): Promise<void>;

  /** Check if a skill exists */
  exists(name: string): Promise<boolean>;

  /** Export a skill as standard-compliant SKILL.md content (no invocationMode) */
  exportAsSkillMd(name: string): Promise<string | null>;
}
```

### IndexedDBSkillProvider (`src/extension/storage/IndexedDBSkillProvider.ts`)

```typescript
/**
 * Implements ISkillProvider using the existing StorageProvider (IndexedDB).
 * Collection: 'skills', Key: skill.name, Value: Skill object (includes invocationMode).
 * References stored inline as skill.references field.
 */
export class IndexedDBSkillProvider implements ISkillProvider {
  constructor(storageProvider: StorageProvider);
  // All methods delegate to storageProvider.get/set/delete/list('skills', ...)
}
```

### FilesystemSkillProvider (`src/desktop/storage/FilesystemSkillProvider.ts`)

```typescript
/**
 * Implements ISkillProvider using Tauri filesystem commands.
 * Skills stored at ~/.airepublic-pi/skills/{name}/SKILL.md
 * User settings stored in ~/.airepublic-pi/skills/{name}/.skill-meta.json
 *   (contains invocationMode, trusted, source, sourceUrl, createdAt, updatedAt)
 * Keeps SKILL.md standard-compliant (no invocationMode in the file).
 */
export class FilesystemSkillProvider implements ISkillProvider {
  constructor(basePath: string); // defaults to ~/.airepublic-pi/skills
  // Uses Tauri invoke() for all filesystem operations
}
```

## SkillParser (`src/core/skills/SkillParser.ts`)

```typescript
/** Parse a SKILL.md file into structured data */
export function parseSkillMd(content: string): ParsedSkill;

/** Serialize a Skill back to standard-compliant SKILL.md format (no invocationMode) */
export function serializeToSkillMd(skill: Skill): string;

/** Validate a parsed skill against the schema (uses Zod) */
export function validateSkill(parsed: ParsedSkill): { valid: boolean; errors: string[] };

/** Perform variable substitution on skill body */
export function substituteVariables(body: string, args: string[]): string;
```

## SkillRegistry (`src/core/skills/SkillRegistry.ts`)

```typescript
/** Central coordinator for skill lifecycle */
export class SkillRegistry {
  /**
   * @param provider - Platform-specific skill storage
   * @param commandRegistry - Optional command registry for `/` command integration (DI)
   */
  constructor(provider: ISkillProvider, commandRegistry?: ICommandRegistry);

  /** Discover all skills and load Level 1 metadata */
  discover(): Promise<SkillMeta[]>;

  /** Get all skill metadata (cached from last discover()) */
  getSkillMetas(): SkillMeta[];

  /** Get auto-invocable skills (invocationMode is 'auto' or 'hybrid' AND trusted) */
  getAutoInvocableSkills(): SkillMeta[];

  /** Register skills as commands in CommandRegistry (manual/hybrid → register, auto → skip) */
  registerCommands(): void;

  /** Load full skill content (Level 2) and perform variable substitution */
  invoke(name: string, args?: string[]): Promise<string | null>;

  /** Load a referenced file (Level 3) */
  loadReference(skillName: string, refPath: string): Promise<string | null>;

  /** Update a skill's invocation mode and re-sync CommandRegistry + system prompt */
  updateInvocationMode(name: string, mode: InvocationMode): Promise<void>;

  /** Import a skill from URL, flagged as untrusted, defaults to manual mode */
  importFromUrl(url: string): Promise<Skill>;

  /** Mark an imported skill as trusted, enabling auto-invocation if mode is auto/hybrid */
  trustSkill(name: string): Promise<void>;

  /** Save a new or updated skill. Throws if name conflicts with a built-in command. */
  save(skill: Skill): Promise<void>;

  /** Delete a skill and unregister from CommandRegistry */
  delete(name: string): Promise<void>;

  /** Export a skill as standard-compliant SKILL.md */
  export(name: string): Promise<string | null>;

  /** Generate system prompt block for auto-invocable skills */
  buildSkillsSystemPrompt(): string;

  /** Re-run discovery (for filesystem change detection on desktop) */
  refresh(): Promise<SkillMeta[]>;
}
```

## UI Messaging (Extension ↔ Background)

New message types for the MessageRouter:

```typescript
// Add to existing MessageType enum
SKILLS_LIST = 'SKILLS_LIST',                 // Request skill metadata list
SKILLS_LOAD = 'SKILLS_LOAD',                 // Load full skill by name
SKILLS_SAVE = 'SKILLS_SAVE',                 // Save skill (create/update)
SKILLS_DELETE = 'SKILLS_DELETE',             // Delete skill
SKILLS_UPDATE_MODE = 'SKILLS_UPDATE_MODE',   // Change invocation mode (manual/auto/hybrid)
SKILLS_IMPORT = 'SKILLS_IMPORT',             // Import from URL
SKILLS_EXPORT = 'SKILLS_EXPORT',             // Export skill as SKILL.md
SKILLS_TRUST = 'SKILLS_TRUST',              // Mark skill as trusted
```

## Agent Integration

The SkillRegistry provides skill metadata to the agent's system prompt builder:

```typescript
/** Generate the skills context block for the system prompt */
buildSkillsSystemPrompt(): string;
// Output format:
// "Available skills:\n- skill-name: description\n- ..."
// Only includes auto-invocable skills (mode=auto|hybrid AND trusted=true)
// Manual-only skills are NOT listed — they are only invokable via /skill-name
```

### Command Registration Flow

When the SkillRegistry initializes:
1. `discover()` loads Level 1 metadata for all skills
2. `registerCommands()` iterates over discovered skills:
   - Skills in `manual` or `hybrid` mode → `commandRegistry.register({ name, description, action })`
   - Skills in `auto` mode → NOT registered (hidden from `/` dropdown)
   - Skills whose name conflicts with an existing command → skipped with warning
3. `buildSkillsSystemPrompt()` generates system prompt for auto/hybrid+trusted skills
4. BrowserxAgent injects the prompt block at session start

### Invocation Mode Change Flow

When a user changes a skill's invocation mode via settings:
1. UI sends `SKILLS_UPDATE_MODE` message with `{ name, mode }`
2. Handler calls `skillRegistry.updateInvocationMode(name, mode)`
3. SkillRegistry updates the stored skill's `invocationMode`
4. Re-syncs CommandRegistry:
   - If new mode is `manual` or `hybrid`: register command (if not already registered)
   - If new mode is `auto`: `commandRegistry.unregister(name)` — skill disappears from `/` dropdown
5. Rebuilds system prompt to include/exclude skill based on new mode
6. Change takes effect immediately — no session restart needed
