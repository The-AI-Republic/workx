# Data Model: File-Based LLM-Powered Memory

## Entities

### DailyMemoryFile

A date-named markdown file containing all facts extracted on a single day.

| Field | Type | Description |
|-------|------|-------------|
| filename | string | `YYYY-MM-DD.md` format |
| date | Date | The calendar date this file represents |
| entries | MemoryEntry[] | Ordered list of fact entries |

**Location**: `{memoryDir}/memory/YYYY-MM-DD.md`

**Lifecycle**:
- Created: automatically when the first fact is extracted on a new day
- Updated: facts appended throughout the day
- Deleted: manually by user, or by future retention policy

---

### MemoryEntry

An individual fact within a daily file. Represented as a markdown section.

| Field | Type | Description |
|-------|------|-------------|
| time | string | `HH:MM` format (24h) |
| category | MemoryCategory | One of: preference, personal, professional, project, behavior, instruction, general |
| text | string | The extracted fact text |
| sourceDate | string | `YYYY-MM-DD` (derived from parent file) |

**Markdown Format**:
```markdown
## HH:MM | category
Fact text here
```

**Validation**:
- Time must be valid 24h format
- Category must be one of the allowed values
- Text must be non-empty

---

### CoreMemory

The always-inject markdown file containing user preferences, instructions, and behaviors. **Unchanged from current implementation.**

| Field | Type | Description |
|-------|------|-------------|
| filePath | string | `{memoryDir}/core-memory.md` |
| content | string | Markdown with headings: User Profile, Preferences, Instructions, Behavior |

**Categories routed here**: `preference`, `instruction`, `behavior`

---

### MemorySearchResult

A fact returned from the search pipeline.

| Field | Type | Description |
|-------|------|-------------|
| fact | string | The fact text |
| category | MemoryCategory | Fact category |
| sourceDate | string | `YYYY-MM-DD` — which day the fact was recorded |
| relevance | number | 0.0-1.0 score assigned by cheap LLM during filtering |

---

## Category Routing

| Category | Storage | Retrieval |
|----------|---------|-----------|
| preference | core-memory.md | Always injected into system prompt |
| instruction | core-memory.md | Always injected into system prompt |
| behavior | core-memory.md | Always injected into system prompt |
| personal | daily files | On-demand via search_memory tool |
| professional | daily files | On-demand via search_memory tool |
| project | daily files | On-demand via search_memory tool |
| general | daily files | On-demand via search_memory tool |

## File Structure

```
~/.airepublic-pi/
├── storage/
│   └── core-memory.md          # Always-inject (existing path, unchanged)
└── memory/
    ├── 2026-03-15.md
    ├── 2026-03-16.md
    └── 2026-03-17.md
```

## State Transitions

### Memory System Lifecycle
```
Disabled → Enabled (user toggles in settings)
  → Initialize: ensure memory/ directory exists
  → Per-turn: extract facts → route → append to daily file or merge to core-memory.md
  → On search: grep daily files → LLM filter → return results
Enabled → Disabled (user toggles off)
  → Stop extraction and search
  → Files remain on disk (not deleted)
```

### Fact Lifecycle
```
Conversation message
  → FactExtractor extracts atomic facts
  → Cheap LLM checks recent files for duplicates
  → If new: append to today's daily file
  → If update: cheap LLM notes the update in today's file (old fact stays in its original daily file)
  → If duplicate: skip
```
