# Quickstart: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18

## Prerequisites

- Node.js 18+ with npm
- Existing browserx development environment
- For desktop testing: Tauri development setup (Rust toolchain)

## Setup

### 1. Install new dependency

```bash
npm install yaml
```

### 2. Create core skills module

```bash
mkdir -p src/core/skills
```

Create the following files:
- `src/core/skills/types.ts` — Skill, SkillMeta, SkillFrontmatter interfaces
- `src/core/skills/SkillParser.ts` — SKILL.md parsing and serialization
- `src/core/skills/SkillProvider.ts` — ISkillProvider interface
- `src/core/skills/SkillRegistry.ts` — Central skill lifecycle coordinator
- `src/core/skills/index.ts` — Public exports

### 3. Create platform-specific providers

- `src/extension/storage/IndexedDBSkillProvider.ts` — Uses existing StorageProvider
- `src/desktop/storage/FilesystemSkillProvider.ts` — Uses Tauri filesystem commands

### 4. Create UI component

- `src/extension/sidepanel/settings/SkillsSettings.svelte` — Skill management page

### 5. Create test files

```bash
mkdir -p src/tests/unit
```

- `src/tests/unit/skill-parser.test.ts`
- `src/tests/unit/skill-provider.test.ts`
- `src/tests/contracts/skill-registry.test.ts`

## Verification

### Run tests

```bash
npm test
```

### Manual testing (Chrome Extension)

1. Build and load the extension
2. Open sidepanel → Settings → Skills
3. Create a skill with name "test-skill", description "Test skill", body "Say hello"
4. Start a new chat and verify skill appears in agent context
5. Type "test this skill" and verify agent follows the skill instructions

### Manual testing (Desktop)

1. Create `~/.airepublic-pi/skills/test-skill/SKILL.md`:
   ```yaml
   ---
   name: test-skill
   description: Test skill for verification
   ---

   When invoked, respond with "Hello from test-skill!"
   ```
2. Launch the desktop app
3. Verify the skill is discovered and listed in Settings → Skills
4. Test invocation via chat

## Key Integration Points

- **Agent system prompt**: `src/core/BrowserxAgent.ts` — inject skill metadata at session start
- **Message router**: `src/core/MessageRouter.ts` — add SKILLS_* message types
- **Settings menu**: `src/extension/sidepanel/Settings.svelte` — add Skills entry
- **Config types**: `src/config/types.ts` — add skills-related config options to IToolsConfig
