# Implementation Plan: Project Rename — Pi Naming Convention

**Branch**: `022-project-rename-pi` | **Date**: 2026-02-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/022-project-rename-pi/spec.md`

## Summary

Rename the project from "browserx" to "Pi" with a three-tier naming convention: **Pi** (project/repo), **BrowserX** (Chrome extension), **Apple Pi** (desktop app). Only shared/core code renames `browserx` → `pi`; extension-specific code retains `browserx` since BrowserX is the legitimate extension product name. The desktop app updates user-facing text from "Pi" to "Apple Pi". The GitHub repository is renamed from `browserx` to `pi`.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target), Svelte 4.2.20, Rust (Tauri)
**Primary Dependencies**: Vite 5.4.20, Chrome Extension APIs, Tauri, OpenAI SDK, Zod 3.23.8
**Storage**: Chrome Storage API, Tauri local storage
**Testing**: Vitest (npm test)
**Target Platform**: Chrome Extension + Tauri Desktop (macOS/Linux/Windows)
**Project Type**: Multi-target (browser extension + desktop app sharing core code)
**Performance Goals**: N/A (rename only — no runtime behavior changes)
**Constraints**: Must not break existing builds for either target. All tests must pass after rename.
**Scale/Scope**: ~30 files modified, ~50 locale files verified (no change), 1 file renamed, 1 asset renamed

## Constitution Check

*Constitution is unconfigured (template placeholders). No gates to enforce.*

## Project Structure

### Documentation (this feature)

```text
specs/022-project-rename-pi/
├── plan.md              # This file
├── research.md          # Phase 0 output — file inventory and decisions
├── spec.md              # Feature specification
├── quickstart.md        # Phase 1 output — verification guide
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /rr.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── BrowserxAgent.ts  → PiAgent.ts     # Rename file + class
│   ├── Session.ts                          # Update comments
│   ├── AgentTask.ts                        # Update comments
│   ├── PromptLoader.ts                     # Update comments
│   ├── mcp/MCPToolAdapter.ts               # Update comments
│   └── registry/
│       ├── AgentSession.ts                 # Update references
│       └── types.ts                        # Update references
├── desktop/
│   ├── index.html                          # Title → "Apple Pi"
│   ├── agent/DesktopAgentBootstrap.ts      # Import PiAgent
│   ├── channels/                           # Update comments
│   └── ...                                 # Update comments
├── extension/
│   └── background/service-worker.ts        # Import PiAgent (path change only)
├── tools/
│   └── dom/
│       ├── plugins/GoogleDocPlugin.ts      # data-pi-injected
│       ├── DomService.ts                   # Update references
│       └── __tests__/actions.test.ts       # Update test refs
├── prompts/
│   └── default_pi_agent_prompt.md          # Content → "Apple Pi"
├── static/
│   └── browserx_UI.png → pi_UI.png        # Rename asset
├── models/                                 # Check for references
tauri/
└── tauri.conf.json                         # productName/title → "Apple Pi"
.github/
└── workflows/sync-to-private.yml           # private-browserx → private-pi
```

**Structure Decision**: Existing directory structure is preserved. This is a rename-in-place operation — no structural changes.

## Implementation Phases

### Phase A: Core Class Rename (highest risk, do first)

This is the most impactful change since `BrowserxAgent` is imported across many files.

1. **Rename file**: `src/core/BrowserxAgent.ts` → `src/core/PiAgent.ts`
2. **Rename class**: `BrowserxAgent` → `PiAgent` in the new file
3. **Update all imports** that reference `BrowserxAgent` or the old file path:
   - `src/extension/background/service-worker.ts`
   - `src/extension/background/index.ts`
   - `src/desktop/agent/DesktopAgentBootstrap.ts`
   - Any other importers found via grep
4. **Update type annotations** referencing `BrowserxAgent`
5. **Run `npm test`** to verify nothing breaks

### Phase B: Desktop App User-Facing Updates ("Apple Pi")

"Apple Pi" only appears where users directly see it on screen. All other config stays "Pi"/"pi".

1. **Tauri config** (`tauri/tauri.conf.json`) — UI-visible fields only:
   - `productName`: "Pi" → "Apple Pi" (OS app name)
   - `title`: "Pi" → "Apple Pi" (window title bar)
   - `shortDescription`: stays "Pi - ..." (config metadata, not visible in UI)
   - `longDescription`: stays "Pi - ..." (config metadata, not visible in UI)
2. **Desktop HTML** (`src/desktop/index.html`):
   - `<title>BrowserX Desktop</title>` → `<title>Apple Pi</title>`
3. **Desktop prompt** (`src/prompts/default_pi_agent_prompt.md`):
   - "You are Pi" → "You are Apple Pi" (LLM identity visible to user)
4. **Cargo.toml** (`tauri/Cargo.toml`):
   - `name = "pi"` stays (code-level)
   - Description stays "Pi - ..." (code-level metadata)

### Phase C: Shared Code References

1. **Data attribute** (`src/tools/dom/plugins/GoogleDocPlugin.ts`):
   - `data-browserx-injected` → `data-pi-injected`
2. **DomService** (`src/tools/dom/DomService.ts`):
   - Update any `browserx` references in shared code
3. **Test files** (`src/tools/dom/__tests__/actions.test.ts`):
   - Update test assertions referencing `browserx`
4. **Core module comments**: Update comments in `src/core/` files that reference "Browserx"
5. **Desktop module comments**: Update comments in `src/desktop/` files that reference "Browserx"

### Phase D: Project Configuration

1. **package.json**: `"name": "browserx-chrome"` → `"name": "pi"`
2. **Static asset**: Rename `src/static/browserx_UI.png` → `src/static/pi_UI.png`
3. **README.md**: Update project heading, clone URLs, naming convention explanation
4. **CHANGELOG.md**: Update project name
5. **CLAUDE.md**: Update shared/project-level references (preserve extension-specific `browserx` references)

### Phase E: Chrome Extension Fixes (keep `browserx`, fix capitalization)

1. **Cursor label** (`src/extension/content/ui_effect/CursorAnimator.svelte`):
   - `<div class="cursor-label">browserx</div>` → `<div class="cursor-label">BrowserX</div>`
2. **Verify** all extension-specific `browserx` naming is preserved (no accidental renames)

### Phase F: CI/CD and GitHub

1. **CI/CD** (`.github/workflows/sync-to-private.yml`):
   - `private-browserx.git` → `private-pi.git`
2. **README clone URL**: `browserx.git` → `pi.git`
3. **GitHub repo rename**: Admin operation via GitHub Settings
   - `The-AI-Republic/browserx` → `The-AI-Republic/pi`

### Phase G: Verification

1. Run `npm test` — all tests must pass
2. Run `npm run lint` — no new lint errors
3. Run `npm run build` — Chrome extension builds successfully
4. Grep verification:
   - `grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/` → zero results (excluding import paths that reference extension files)
   - `grep -ri "BrowserX" src/extension/` → still present (correct)
5. Manual spot-check: extension manifest, locale files, Tauri config

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Broken imports after class rename | Medium | High | Run TypeScript compiler check after Phase A |
| Missed `browserx` reference in shared code | Low | Low | Grep verification in Phase G |
| Test failures from renamed class | Medium | Medium | Update test mocks/assertions in Phase A |
| Build failure from renamed asset | Low | Medium | Update all README image references |
| GitHub redirect expiry | Low | Low | Update all docs with new URL immediately |

## Complexity Tracking

No constitution violations to justify.
