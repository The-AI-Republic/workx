# Quickstart: Agent Skills System

**Feature**: 028-agent-skills | **Date**: 2026-02-18 | **Updated**: 2026-02-20

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
- `src/core/skills/types.ts` — Skill, SkillMeta, InvocationMode, SkillFrontmatter interfaces + Zod schemas
- `src/core/skills/SkillParser.ts` — SKILL.md parsing and serialization
- `src/core/skills/SkillProvider.ts` — ISkillProvider interface
- `src/core/skills/SkillRegistry.ts` — Central skill lifecycle coordinator + CommandRegistry integration
- `src/core/skills/index.ts` — Public exports

### 3. Create platform-specific providers

- `src/extension/storage/IndexedDBSkillProvider.ts` — Uses existing StorageProvider
- `src/desktop/storage/FilesystemSkillProvider.ts` — Uses Tauri filesystem commands

### 4. Create UI component

- `src/extension/sidepanel/settings/SkillsSettings.svelte` — Skill management page with invocation mode toggle

## Verification

### Run tests

```bash
npm test
```

### Manual testing (Chrome Extension)

1. Build and load the extension
2. Open sidepanel → Settings → Skills
3. Create a skill with name "test-skill", description "Test skill", body "Say hello"
4. Verify the skill appears in the `/` dropdown when typing `/` in the chat input
5. Type `/test-skill` and verify the agent follows the skill instructions
6. Change the skill's invocation mode to "hybrid" in Settings → Skills
7. Type "test this skill" and verify the agent auto-invokes it
8. Change the mode to "auto" and verify the skill disappears from the `/` dropdown but still auto-invokes

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
4. Type `/test-skill` in the chat input and verify it works
5. Test invocation mode changes via the settings UI

## Key Integration Points

- **CommandRegistry**: `src/extension/sidepanel/commands/CommandRegistry.ts` — skills register here as `/` commands
- **Agent system prompt**: `src/core/BrowserxAgent.ts` — inject skill metadata for auto/hybrid mode skills at session start
- **Message router**: `src/core/MessageRouter.ts` — add SKILLS_* message types
- **Settings menu**: `src/extension/sidepanel/Settings.svelte` — add Skills entry
