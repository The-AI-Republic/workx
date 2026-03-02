# Data Model: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18

## Entities

### Skill

The primary entity representing a user's custom instruction set.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | Max 64 chars, lowercase + hyphens only, no leading/trailing/consecutive hyphens | Unique identifier for the skill |
| description | string | Yes | Max 1024 chars, non-empty | What the skill does and when to use it; used for auto-invocation matching |
| body | string | Yes | Max 50KB | Markdown instructions the agent follows when the skill is invoked |
| trusted | boolean | Yes | Default: true (user-created), false (imported) | Whether the skill is eligible for auto-invocation |
| source | enum | Yes | "user" or "imported" | How the skill was added |
| sourceUrl | string | No | Valid URL | Original URL if imported |
| metadata | Record<string, string> | No | - | Optional key-value pairs (author, version, license, etc.) |
| allowedTools | string[] | No | - | Tool names the skill is pre-approved to use |
| compatibility | string | No | Max 500 chars | Environment requirements |
| disableModelInvocation | boolean | No | Default: false | If true, only manual invocation allowed (overrides trusted) |
| createdAt | string | Yes | ISO 8601 | When the skill was created or imported |
| updatedAt | string | Yes | ISO 8601 | When the skill was last modified |

**Identity**: `name` is the unique identifier. No two skills can share the same name.

**Uniqueness rule**: On desktop, if a filesystem skill and an IndexedDB skill share a name, the filesystem skill wins.

### SkillMeta (Level 1 — lightweight)

A projection of Skill used for startup discovery. Contains only the fields needed for the agent's system prompt.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Skill identifier |
| description | string | What the skill does |
| trusted | boolean | Eligible for auto-invocation |
| disableModelInvocation | boolean | Blocks auto-invocation regardless of trust |
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
```

## State Transitions

Skills have no explicit state machine. The relevant behavioral flags are:

- **trusted**: `false` → `true` (user approves an imported skill). Cannot go `true` → `false` (user-created skills are always trusted).
- **disableModelInvocation**: Toggled by user at any time via frontmatter edit or UI.

## Storage Mapping

### Chrome Extension (IndexedDB via StorageProvider)

- **Collection**: `skills`
- **Key**: `skill.name`
- **Value**: Full `Skill` object serialized as JSON
- References stored inline as a `references` field (Record<string, string>)

### Desktop (Filesystem at `~/.airepublic-pi/skills/`)

- **Directory per skill**: `~/.airepublic-pi/skills/{skill-name}/`
- **Main file**: `SKILL.md` (YAML frontmatter + markdown body)
- **References**: `references/*.md` (separate files)
- **Trust metadata**: Stored in a `.skill-meta.json` sidecar file (contains `trusted`, `source`, `sourceUrl`, `createdAt`, `updatedAt`) since the SKILL.md standard format doesn't include these fields

## Validation Rules (via Zod)

- `name`: `z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`
- `description`: `z.string().min(1).max(1024)`
- `body`: `z.string().max(51200)` (50KB)
- `trusted`: `z.boolean().default(true)`
- `source`: `z.enum(['user', 'imported'])`
- `sourceUrl`: `z.string().url().optional()`
- `metadata`: `z.record(z.string(), z.string()).optional()`
- `allowedTools`: `z.array(z.string()).optional()`
