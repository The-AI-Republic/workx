# Data Model: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18 | **Updated**: 2026-02-20

## Entities

### Skill

The primary entity representing a user's custom instruction set.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | Max 64 chars, lowercase + hyphens only, no leading/trailing/consecutive hyphens | Unique identifier; becomes `/name` slash command |
| description | string | Yes | Max 1024 chars, non-empty | What the skill does; used for auto-invocation matching and `/` dropdown display |
| body | string | Yes | Max 50KB | Markdown instructions the agent follows when the skill is invoked |
| invocationMode | enum | Yes | "manual" \| "auto" \| "hybrid", default: "manual" | Controls how the skill can be triggered (see Invocation Modes below) |
| trusted | boolean | Yes | Default: true (user-created), false (imported) | Whether the skill is eligible for auto-invocation |
| source | enum | Yes | "user" or "imported" | How the skill was added |
| sourceUrl | string | No | Valid URL | Original URL if imported |
| metadata | Record<string, string> | No | - | Optional key-value pairs (author, version, license, etc.) |
| allowedTools | string[] | No | - | Tool names the skill is pre-approved to use |
| compatibility | string | No | Max 500 chars | Environment requirements |
| createdAt | string | Yes | ISO 8601 | When the skill was created or imported |
| updatedAt | string | Yes | ISO 8601 | When the skill was last modified |

**Identity**: `name` is the unique identifier. No two skills can share the same name.

**Uniqueness rule**: On desktop, if a filesystem skill and an IndexedDB skill share a name, the filesystem skill wins.

### Invocation Modes

| Mode | `/skill-name` in dropdown | LLM auto-invoke | Description in system prompt |
|------|--------------------------|-----------------|------------------------------|
| **manual** (default) | Yes | No | No |
| **auto** | No | Yes (if trusted) | Yes |
| **hybrid** | Yes | Yes (if trusted) | Yes |

**Trust interaction**: Untrusted skills can NEVER auto-invoke, regardless of mode. They can always be manually invoked via `/`.

### SkillMeta (Level 1 — lightweight)

A projection of Skill used for startup discovery. Contains only the fields needed for registration and system prompt.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Skill identifier; becomes `/name` command |
| description | string | What the skill does |
| invocationMode | enum | "manual", "auto", or "hybrid" |
| trusted | boolean | Eligible for auto-invocation |
| source | enum | "user" or "imported" |

### SkillReference (Level 3 — on-demand)

A supporting file referenced by a skill's body.

| Field | Type | Description |
|-------|------|-------------|
| skillName | string | Parent skill identifier |
| path | string | Relative path from skill root (e.g., `references/REFERENCE.md`) |
| content | string | File content (loaded on demand) |

## Relationships

```
Skill (1) ──── has many ──── SkillReference (0..*)
                              └── loaded on demand (Level 3)

SkillMeta ──── projection of ──── Skill
                                   └── Level 1 subset loaded at startup

Skill (manual/hybrid) ──── registered as ──── Command (in CommandRegistry)
                                               └── /skill-name in dropdown
```

## State Transitions

- **invocationMode**: Toggled by user at any time via settings UI. Transitions: manual ↔ auto ↔ hybrid (any direction).
- **trusted**: `false` → `true` (user approves an imported skill). Cannot go `true` → `false` (user-created skills are always trusted).
- **CommandRegistry sync**: When invocationMode changes:
  - To "manual" or "hybrid": Register in CommandRegistry (if not already)
  - To "auto": Unregister from CommandRegistry
  - When trusted changes for auto/hybrid skill: Update system prompt inclusion

## Storage Mapping

### Chrome Extension (IndexedDB via StorageProvider)

- **Collection**: `skills`
- **Key**: `skill.name`
- **Value**: Full `Skill` object serialized as JSON (includes `invocationMode`)
- References stored inline as a `references` field (Record<string, string>)

### Desktop (Filesystem at `~/.airepublic-pi/skills/`)

- **Directory per skill**: `~/.airepublic-pi/skills/{skill-name}/`
- **Main file**: `SKILL.md` (YAML frontmatter + markdown body — standard-compliant)
- **References**: `references/*.md` (separate files)
- **User settings**: Stored in a `.skill-meta.json` sidecar file (contains `invocationMode`, `trusted`, `source`, `sourceUrl`, `createdAt`, `updatedAt`) since the SKILL.md standard format doesn't include these fields

## Validation Rules (via Zod)

- `name`: `z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`
- `description`: `z.string().min(1).max(1024)`
- `body`: `z.string().max(51200)` (50KB)
- `invocationMode`: `z.enum(['manual', 'auto', 'hybrid']).default('manual')`
- `trusted`: `z.boolean().default(true)`
- `source`: `z.enum(['user', 'imported'])`
- `sourceUrl`: `z.string().url().optional()`
- `metadata`: `z.record(z.string(), z.string()).optional()`
- `allowedTools`: `z.array(z.string()).optional()`
