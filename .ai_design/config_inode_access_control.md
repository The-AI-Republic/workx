# Config Access Control via Zod Schema

**Date**: 2026-02-27
**Status**: Draft
**Feature**: Replace `settingsAllowlist.ts` with Zod schema-based access control
**Depends on**: PR #134 (SettingTool), approval_config unification (cb4016a)
**Uses**: Zod (already in project — used by protocol, skills, A2A, MCP)

---

## Problem

The SettingTool uses a separate flat allowlist (`settingsAllowlist.ts`) to gate LLM access. This creates:

1. **Triple maintenance** — the allowlist duplicates type/enum/description metadata from `types.ts` and `defaults.ts`. Three places to update when adding a field.
2. **Deny-by-forgetting** — new fields are blocked only because nobody added them to the separate allowlist.

## Core Idea

Borrow from Linux filesystems: **metadata lives on the node itself, not in a separate structure.**

We apply this with Zod: **one schema definition per field** produces runtime validation and LLM access metadata. No separate allowlist. No hand-written validation logic that can drift from the types.

Three properties borrowed from Linux:

1. **Co-located** — access metadata lives on the field definition, not in a separate file
2. **Subtree blocking** — a container without traverse permission blocks everything inside
3. **Default deny** — no access metadata means no access

## Design

### How Zod Replaces Three Separate Definitions

Currently, adding an LLM-accessible field requires updates in three places:

```
types.ts              →  TypeScript interface (hand-written)
defaults.ts           →  Default value
settingsAllowlist.ts  →  LLM access metadata (label, description, enum, type)
```

With Zod, one definition in `configSchema.ts` replaces `settingsAllowlist.ts` and `defaults.ts`:

```ts
uiTheme: configField(
  z.enum(['terminal', 'modern-auto', 'modern-light', 'modern-dark']).default('terminal'),
  { llm_access: { read: true, write: true, label: 'UI Theme', description: '...', category: 'general' } },
),
```

From this single definition:
- **Default value**: `.default('terminal')` → used by `buildRuntimeConfig()`
- **Validation**: `.parse(value)` → type + enum check, replaces `validateValue()`
- **Enum values**: `.options` → `['terminal', 'modern-auto', ...]` at runtime
- **LLM access**: `meta.llm_access.{ read, write, label, description, category }` → replaces allowlist entry

Note: TypeScript interfaces in `types.ts` stay hand-written for Phases 1-2. Migrating types to Zod-derived (`z.infer<>`) is a separate Phase 3 effort — see Migration section.

### No `.value` — Config Stays Plain

The Zod schema is a **separate object that describes the config**. The config itself stays exactly as it is today:

```ts
config.preferences.uiTheme       // → 'terminal'  (plain string, unchanged)
config.preferences.autoSync       // → true         (plain boolean, unchanged)
config.approval.mode              // → 'balanced'   (plain string, unchanged)
```

No wrapping. No hydration/stripping. No call-site changes. The schema is consulted only by the SettingTool when it needs metadata.

### Scope

Only config fields that the LLM needs to access get a `configField()` entry with `meta.llm_access`. Other fields can still be defined in the schema (for validation) but without `meta`, making them LLM-inaccessible.

LLM-accessible fields (~20):
- `selectedModelKey` (root-level)
- `preferences.{uiTheme, theme, language}`
- `tools.*` (~14 boolean toggles)
- `approval.{mode, trustedDomains, blockedDomains}`

### Constraint: Max 2-Level Paths

All LLM-accessible fields are at most 2 segments deep (e.g., `selectedModelKey` or `approval.mode`). The `resolve()` function relies on this — it checks the root, then one container, then one leaf. If deeper paths are needed in the future, `resolve()` must be extended to walk an arbitrary depth.

### LlmAccess

```ts
interface LlmAccess {
  // Container permission
  traverse?: boolean;     // LLM can see children of this container

  // Leaf permissions
  read?: boolean;         // LLM can read this value
  write?: boolean;        // LLM can write this value

  // Metadata (all optional)
  label?: string;         // Human-readable name
  description?: string;   // What this setting controls
  category?: string;      // Grouping key for `list` action
  risk?: number;          // Risk score for this setting (e.g., 50 for mode change)
  alias?: string;         // Legacy key for migration (e.g., 'general.uiTheme')
}
```

### ConfigMeta

Wraps `llm_access` and is extensible for future consumers:

```ts
interface ConfigMeta {
  llm_access?: LlmAccess;
  // extensible: ui?: {...}, export?: {...}, etc.
}
```

### configField Helper

Pairs a Zod schema with optional metadata:

```ts
function configField<T extends z.ZodTypeAny>(schema: T, meta?: ConfigMeta) {
  return { schema, meta };
}
```

A field with `meta.llm_access` = LLM-accessible. A field without `meta` = blocked (default deny).

### toolToggle Helper

Reduces repetition for the ~14 identical boolean tool toggles:

```ts
function toolToggle(label: string, description: string) {
  return configField(
    z.boolean().default(true),
    { llm_access: { read: true, write: true, label, description, category: 'tools' } },
  );
}
```

### Schema Definition

```ts
// src/config/configSchema.ts (new file, replaces settingsAllowlist.ts)

import { z } from 'zod';

// ── Sections ────────────────────────────────────────────────────
// Each section combines container metadata + field definitions.
// Absent sections (providers, cache, extension) are blocked.

type ConfigFieldDef = { schema: z.ZodTypeAny; meta?: ConfigMeta };

interface Section {
  traverse: boolean;
  label: string;
  description: string;
  category: string;
  fields: Record<string, ConfigFieldDef>;
}

const SECTIONS: Record<string, Section> = {

  // ── Root ─────────────────────────────────────────────────────
  '': {
    traverse: true,
    label: 'Root',
    description: 'Config root',
    category: '',
    fields: {
      selectedModelKey: configField(
        z.string(),
        { llm_access: { read: true, write: true, label: 'Model Selection',
          description: 'Active AI model (provider:modelKey format)', category: 'model',
          alias: 'model.selection' } },
      ),
    },
  },

  // ── Preferences ──────────────────────────────────────────────
  'preferences': {
    traverse: true,
    label: 'User Preferences',
    description: 'User preference settings',
    category: 'general',
    fields: {
      // LLM-accessible:
      uiTheme: configField(
        z.enum(['terminal', 'modern-auto', 'modern-light', 'modern-dark']).default('terminal'),
        { llm_access: { read: true, write: true, label: 'UI Theme',
          description: 'Visual theme: terminal (retro) or modern variants', category: 'general',
          alias: 'general.uiTheme' } },
      ),
      theme: configField(
        z.enum(['light', 'dark', 'system']).default('system'),
        { llm_access: { read: true, write: true, label: 'Color Theme',
          description: 'System color scheme', category: 'general',
          alias: 'general.theme' } },
      ),
      language: configField(
        z.string().default('en'),
        { llm_access: { read: true, write: true, label: 'Language',
          description: 'Preferred interface language (e.g., en, es, zh)', category: 'general',
          alias: 'general.language' } },
      ),
      // Plain fields — no meta, LLM can't access:
      autoSync: configField(z.boolean().default(true)),
      telemetryEnabled: configField(z.boolean().default(false)),
      useOwnApiKey: configField(z.boolean().default(false)),
      showTokenUsage: configField(z.boolean().default(false)),
      maxConcurrentSessions: configField(z.number().min(1).max(10).default(3)),
      autoStartEnabled: configField(z.boolean().default(false)),
      shortcuts: configField(z.record(z.string(), z.string()).default({})),
      experimental: configField(z.record(z.string(), z.boolean()).default({})),
    },
  },

  // ── Tools ────────────────────────────────────────────────────
  'tools': {
    traverse: true,
    label: 'Tool Configuration',
    description: 'Tool toggle settings',
    category: 'tools',
    fields: {
      enable_all_tools: configField(
        z.boolean().default(false),
        { llm_access: { read: true, write: true, label: 'Enable All Tools',
          description: 'Master toggle to enable all browser tools', category: 'tools' } },
      ),
      dom_tool: toolToggle('DOM Tool', 'Enable DOM manipulation and interaction'),
      storage_tool: toolToggle('Storage Tool', 'Enable browser storage inspection'),
      tab_tool: toolToggle('Tab Tool', 'Enable browser tab management'),
      web_scraping_tool: toolToggle('Web Scraping Tool', 'Enable web page scraping'),
      form_automation_tool: toolToggle('Form Automation Tool', 'Enable form filling and automation'),
      navigation_tool: toolToggle('Navigation Tool', 'Enable page navigation'),
      network_intercept_tool: toolToggle('Network Intercept Tool', 'Enable network request interception'),
      data_extraction_tool: toolToggle('Data Extraction Tool', 'Enable structured data extraction'),
      page_action_tool: toolToggle('Page Action Tool', 'Enable page action automation'),
      page_vision_tool: toolToggle('Page Vision Tool', 'Enable visual page analysis'),
      execCommand: toolToggle('Command Execution', 'Enable shell command execution'),
      webSearch: toolToggle('Web Search', 'Enable web search capabilities'),
      fileOperations: toolToggle('File Operations', 'Enable file read/write operations'),
      mcpTools: toolToggle('MCP Tools', 'Enable Model Context Protocol tools'),
    },
  },

  // ── Approval ─────────────────────────────────────────────────
  'approval': {
    traverse: true,
    label: 'Approval Settings',
    description: 'Approval system settings',
    category: 'approval',
    fields: {
      // LLM-accessible:
      mode: configField(
        z.enum(['balanced', 'high_speed', 'yolo']).default('balanced'),
        { llm_access: { read: true, write: true, label: 'Approval Mode',
          description: 'Controls tool call approval thresholds', category: 'approval',
          risk: 50 } },
      ),
      trustedDomains: configField(
        z.array(z.string()).default([]),
        { llm_access: { read: true, write: true, label: 'Trusted Domains',
          description: 'Domains trusted for automatic tool approval', category: 'approval' } },
      ),
      blockedDomains: configField(
        z.array(z.string()).default([]),
        { llm_access: { read: true, write: true, label: 'Blocked Domains',
          description: 'Domains blocked from tool execution', category: 'approval' } },
      ),
      // Plain fields:
      version: configField(z.string().default('1.0.0')),
      userRules: configField(z.array(z.any()).default([])),
    },
  },

  // providers, cache, extension — absent from SECTIONS = blocked
};
```

### Access Resolution

The SettingTool resolves a path like `"approval.mode"` by walking the sections:

```
resolve("approval.mode", action='read'):

  1. SECTIONS['']?.traverse?                              → true, continue
  2. SECTIONS['approval']?.traverse?                      → true, continue
  3. approval.fields.mode.meta?.llm_access?.read?         → true, ALLOW

resolve("providers.openai.apiKey", action='read'):

  1. SECTIONS['']?.traverse?                              → true, continue
  2. SECTIONS['providers']?                               → absent, DENY
     "Setting 'providers.openai.apiKey' is not accessible"

resolve("preferences.autoSync", action='read'):

  1. SECTIONS['']?.traverse?                              → true, continue
  2. SECTIONS['preferences']?.traverse?                   → true, continue
  3. preferences.fields.autoSync.meta?.llm_access?        → undefined, DENY
     "Setting 'preferences.autoSync' is not accessible"
```

Implementation:

```ts
function resolve(path: string, action: 'read' | 'write'):
  | { llm_access: LlmAccess; schema: z.ZodTypeAny }
  | { denied: string }
{
  // Check root traverse
  const root = SECTIONS[''];
  if (!root?.traverse) return { denied: 'root not traversable' };

  const segments = path.split('.');

  if (segments.length === 1) {
    // Root-level field (e.g., 'selectedModelKey')
    const field = root.fields[segments[0]];
    const llm = field?.meta?.llm_access;
    if (!llm) return { denied: `'${segments[0]}' is not accessible` };
    if (action === 'read' && !llm.read) return { denied: 'read not permitted' };
    if (action === 'write' && !llm.write) return { denied: 'write not permitted' };
    return { llm_access: llm, schema: field.schema };
  }

  // Multi-segment path (e.g., 'approval.mode')
  // Constraint: max 2 segments (container.field)
  const [container, fieldName] = segments;

  const section = SECTIONS[container];
  if (!section?.traverse) return { denied: `'${container}' is not accessible` };

  const field = section.fields[fieldName];
  const llm = field?.meta?.llm_access;
  if (!llm) return { denied: `'${path}' is not accessible` };
  if (action === 'read' && !llm.read) return { denied: 'read not permitted' };
  if (action === 'write' && !llm.write) return { denied: 'write not permitted' };

  return { llm_access: llm, schema: field.schema };
}
```

### Validation

Zod replaces the hand-written `validateValue()` in `settingsAllowlist.ts`:

```ts
// Old: manual type checking + allowedValues checking
validateValue(entry, value)

// New: Zod does it all
const result = resolve(path, 'write');
if ('denied' in result) return error;
const parsed = result.schema.safeParse(value);
if (!parsed.success) return { error: parsed.error.message };
// Value is valid and correctly typed
```

### Listing Settings

```ts
// Collect all LLM-accessible fields with their metadata
function listAccessibleFields(): { path: string; llm_access: LlmAccess }[] {
  const result: { path: string; llm_access: LlmAccess }[] = [];
  for (const [sectionName, section] of Object.entries(SECTIONS)) {
    if (!section.traverse) continue;
    for (const [name, field] of Object.entries(section.fields)) {
      const llm = field.meta?.llm_access;
      if (llm) {
        const path = sectionName ? `${sectionName}.${name}` : name;
        result.push({ path, llm_access: llm });
      }
    }
  }
  return result;
}

// Filter by category
function listByCategory(category: string) {
  return listAccessibleFields().filter(f => f.llm_access.category === category);
}
```

### What This Replaces

| Current (`settingsAllowlist.ts`) | New (`configSchema.ts`) |
|---|---|
| `SETTINGS_ALLOWLIST` flat array | `SECTIONS` map |
| `AllowlistEntry` with duplicated metadata | `configField()` — single source of truth |
| `isAllowlisted(key)` | `resolve(path, action)` succeeds (checks `meta.llm_access` & `alias`) |
| `getEntry(key)` returns separate object | `resolve()` returns `{ llm_access, schema }` |
| `validateValue(entry, value)` | `schema.safeParse(value)` (Zod) |
| `storageKey` + `configPath` per entry | Not needed — config is one tree (`agent_config`) |
| `getByCategory(cat)` | `listByCategory(cat)` |
| Manual type/enum validation | Zod `.parse()` / `.safeParse()` |

### What Stays Unchanged

- **Config values in `chrome.storage.local`** — still plain JSON, no metadata
- **Config access pattern** — still `config.preferences.uiTheme` (no `.value`)
- **`buildRuntimeConfig()` / `extractStoredConfig()`** — same logic, no hydration/stripping needed
- **Blocked subtrees** (providers, cache, extension) — not in SECTIONS, automatically denied
- **All existing call sites** — no code changes needed outside SettingTool
- **TypeScript interfaces in `types.ts`** — stay hand-written for Phases 1-2

## Migration

### Phase 1: Create `configSchema.ts`
- Create `src/config/configSchema.ts` with:
  - `LlmAccess` interface, `ConfigMeta` interface, `Section` interface
  - `configField()` helper, `toolToggle()` helper
  - `SECTIONS` map with all sections and their fields
  - `resolve()`, `listAccessibleFields()`, `listByCategory()`
- Existing code unchanged — this is purely additive

### Phase 2: Switch SettingTool to use schema
- Import `resolve()`, `listAccessibleFields()`, `listByCategory()` from `configSchema.ts`
- Replace `isAllowlisted`/`getEntry`/`validateValue` calls with `resolve()` + `schema.safeParse()`
- Replace `getByCategory()` with `listByCategory()`
- Support `alias` lookup: if `resolve(path)` fails, scan `listAccessibleFields()` for a matching `alias`
- Delete `settingsAllowlist.ts`
- Update SettingTool tests

### Phase 3: Migrate types to Zod-derived (optional, incremental)
- Build Zod `z.object()` schemas with explicit keys per section to preserve type information:
  ```ts
  const PreferencesSchema = z.object({
    uiTheme: SECTIONS['preferences'].fields.uiTheme.schema,
    theme: SECTIONS['preferences'].fields.theme.schema,
    // ... all fields
  });
  type IUserPreferences = z.infer<typeof PreferencesSchema>;
  ```
- This requires the schema to cover **all** fields in each section, not just LLM-accessible ones. Sections with missing fields must be completed first.
- Replace hand-written interfaces in `types.ts` with `z.infer<>` exports
- Start with preferences, tools, approval — leave providers, cache, extension as hand-written
