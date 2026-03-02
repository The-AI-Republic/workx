# Internal API Contracts: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18

These are internal TypeScript interfaces — not external REST/GraphQL APIs. The skills system is entirely client-side.

## Core Types (`src/core/skills/types.ts`)

```typescript
/** Full skill record */
export interface Skill {
  name: string;
  description: string;
  body: string;
  trusted: boolean;
  source: 'user' | 'imported';
  sourceUrl?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  compatibility?: string;
  disableModelInvocation?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Level 1 metadata — loaded at startup for all skills */
export interface SkillMeta {
  name: string;
  description: string;
  trusted: boolean;
  disableModelInvocation: boolean;
  source: 'user' | 'imported';
}

/** Result of parsing a SKILL.md file */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** YAML frontmatter fields from SKILL.md */
export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  compatibility?: string;
  'disable-model-invocation'?: boolean;
}

/** Skill with resolved references (Level 3) */
export interface SkillWithReferences extends Skill {
  references: Record<string, string>;
}
```

## SkillProvider Interface (`src/core/skills/SkillProvider.ts`)

```typescript
/** Platform-agnostic skill storage interface */
export interface ISkillProvider {
  /** Initialize the provider (create directories, open connections) */
  initialize(): Promise<void>;

  /** List all skill metadata (Level 1 — name + description only) */
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

  /** Export a skill as SKILL.md content */
  exportAsSkillMd(name: string): Promise<string | null>;
}
```

### IndexedDBSkillProvider (`src/extension/storage/IndexedDBSkillProvider.ts`)

```typescript
/**
 * Implements ISkillProvider using the existing StorageProvider (IndexedDB).
 * Collection: 'skills', Key: skill.name, Value: Skill object.
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
 * Trust metadata stored in ~/.airepublic-pi/skills/{name}/.skill-meta.json
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

/** Serialize a Skill back to SKILL.md format */
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
  constructor(provider: ISkillProvider);

  /** Discover all skills and load Level 1 metadata */
  discover(): Promise<SkillMeta[]>;

  /** Get all skill metadata (cached from last discover()) */
  getSkillMetas(): SkillMeta[];

  /** Get auto-invocable skills (trusted + not disable-model-invocation) */
  getAutoInvocableSkills(): SkillMeta[];

  /** Load full skill content (Level 2) and perform variable substitution */
  invoke(name: string, args?: string[]): Promise<string | null>;

  /** Load a referenced file (Level 3) */
  loadReference(skillName: string, refPath: string): Promise<string | null>;

  /** Import a skill from URL, flagged as untrusted */
  importFromUrl(url: string): Promise<Skill>;

  /** Mark an imported skill as trusted */
  trustSkill(name: string): Promise<void>;

  /** Save a new or updated skill */
  save(skill: Skill): Promise<void>;

  /** Delete a skill */
  delete(name: string): Promise<void>;

  /** Export a skill as SKILL.md */
  export(name: string): Promise<string | null>;

  /** Re-run discovery (for filesystem change detection on desktop) */
  refresh(): Promise<SkillMeta[]>;
}
```

## UI Messaging (Extension ↔ Background)

New message types for the MessageRouter:

```typescript
// Add to existing MessageType enum
SKILLS_LIST = 'SKILLS_LIST',           // Request skill metadata list
SKILLS_LOAD = 'SKILLS_LOAD',           // Load full skill by name
SKILLS_SAVE = 'SKILLS_SAVE',           // Save skill (create/update)
SKILLS_DELETE = 'SKILLS_DELETE',       // Delete skill
SKILLS_IMPORT = 'SKILLS_IMPORT',       // Import from URL
SKILLS_EXPORT = 'SKILLS_EXPORT',       // Export skill as SKILL.md
SKILLS_TRUST = 'SKILLS_TRUST',        // Mark skill as trusted
```

## Agent Integration

The SkillRegistry provides skill metadata to the agent's system prompt builder:

```typescript
/** Generate the skills context block for the system prompt */
export function buildSkillsSystemPrompt(skills: SkillMeta[]): string;
// Output format:
// "Available skills:\n- skill-name: description\n- ..."
// Only includes auto-invocable skills (trusted + not disabled)
```

When the agent decides to invoke a skill:
1. Agent outputs a structured response indicating skill invocation (skill name + args)
2. System calls `registry.invoke(name, args)` to get substituted body
3. Body is injected into the conversation as a system message
4. Agent continues processing with the skill instructions in context
