# Research: Project Rename — Pi Naming Convention

**Feature Branch**: `022-project-rename-pi`
**Date**: 2026-02-16

## Decision 1: Rename Scope Boundary

**Decision**: Only shared/core code renames `browserx` → `pi`. Extension-specific code keeps `browserx`.

**Rationale**: BrowserX is the legitimate Chrome extension product name, not a legacy reference. The `src/extension/`, `_locales/`, and extension prompt files are all specific to the BrowserX product. Shared code (`src/core/`, `src/tools/`, `src/desktop/`, project root) is product-agnostic infrastructure that should use the project name "pi".

**Alternatives considered**:
- Rename everything to `pi` — rejected because it would erase the BrowserX product identity from extension-specific code
- Keep everything as `browserx` — rejected because the project name is changing to Pi

## Decision 2: Exact Files Requiring Changes

**Decision**: Based on codebase scan, the following files require changes organized by category.

### Shared/Core Code (rename `browserx` → `pi`)

| File | Change | Category |
|------|--------|----------|
| `package.json` (line 2) | `"name": "browserx-chrome"` → `"name": "pi"` | Project config |
| `src/core/BrowserxAgent.ts` | Rename file → `PiAgent.ts`, rename class → `PiAgent` | Core class |
| `src/core/Session.ts` | Update comments referencing BrowserxAgent | Core |
| `src/core/AgentTask.ts` | Update comments referencing BrowserxAgent | Core |
| `src/core/PromptLoader.ts` | Update comments referencing BrowserxAgent | Core |
| `src/core/mcp/MCPToolAdapter.ts` | Update comments referencing BrowserxAgent | Core |
| `src/core/registry/AgentSession.ts` | Update browserx references | Core |
| `src/core/registry/types.ts` | Update browserx references | Core |
| `src/desktop/agent/DesktopAgentBootstrap.ts` | Update import + type refs to PiAgent | Desktop |
| `src/desktop/channels/TauriChannel.ts` | Update comments | Desktop |
| `src/desktop/channels/DesktopMessageRouter.ts` | Update comments | Desktop |
| `src/desktop/polyfills/chromePolyfill.ts` | Update comments | Desktop |
| `src/desktop/ui/main.ts` | Update comments | Desktop |
| `src/desktop/storage/KeytarCredentialStore.ts` | Update comments | Desktop |
| `src/desktop/platform/paths.ts` | Update comments | Desktop |
| `src/desktop/hotkeys.ts` | Update comments | Desktop |
| `src/tools/dom/plugins/GoogleDocPlugin.ts` (line 274) | `data-browserx-injected` → `data-pi-injected` | Tools |
| `src/tools/dom/DomService.ts` | Update browserx references | Tools |
| `src/tools/dom/__tests__/actions.test.ts` | Update test references | Tools |
| `src/tools/index.ts` | Update exports | Tools |
| `src/static/browserx_UI.png` | Rename → `pi_UI.png` | Assets |
| `README.md` | Project name, clone URL, headings | Docs |
| `CHANGELOG.md` | Project name | Docs |
| `CLAUDE.md` | Update shared/project-level references | Docs |

### Extension Code (update import paths only, keep `browserx` naming)

| File | Change | Category |
|------|--------|----------|
| `src/extension/background/service-worker.ts` | Update import path: `BrowserxAgent` → `PiAgent` | Import fix |
| `src/extension/background/index.ts` | Update export if referencing BrowserxAgent | Import fix |

### Desktop App (user-facing: "Apple Pi")

| File | Change | Category |
|------|--------|----------|
| `tauri/tauri.conf.json` (line 3) | `"productName": "Pi"` → `"productName": "Apple Pi"` | User-facing (OS app name) |
| `tauri/tauri.conf.json` (line 24) | `"longDescription"` stays "Pi - ..." (config metadata) | No change |
| `tauri/tauri.conf.json` (line 25) | `"shortDescription"` stays "Pi - ..." (config metadata) | No change |
| `tauri/tauri.conf.json` (line 54) | `"title": "Pi"` → `"title": "Apple Pi"` | User-facing (title bar) |
| `src/desktop/index.html` (line 6) | `<title>BrowserX Desktop</title>` → `<title>Apple Pi</title>` | User-facing |
| `src/prompts/default_pi_agent_prompt.md` | Update "You are Pi" → "You are Apple Pi" | User-facing |

### CI/CD

| File | Change | Category |
|------|--------|----------|
| `.github/workflows/sync-to-private.yml` (line 43) | `private-browserx.git` → `private-pi.git` | CI/CD |

### GitHub Repo (admin operation)

| Action | Details |
|--------|---------|
| Rename repo | `The-AI-Republic/browserx` → `The-AI-Republic/pi` via GitHub Settings |
| Update README | Clone URL from `browserx.git` to `pi.git` |

## Decision 3: Extension Cursor Label Capitalization

**Decision**: The cursor label currently shows lowercase "browserx" — update to properly capitalized "BrowserX" per FR-010.

**Rationale**: User-facing text should use the correct product name capitalization.

**File**: `src/extension/content/ui_effect/CursorAnimator.svelte` (line 280)
- Current: `<div class="cursor-label">browserx</div>`
- Target: `<div class="cursor-label">BrowserX</div>`

## Decision 4: Build Configuration

**Decision**: No changes needed to Vite configs (`vite.config.mjs`, `vite.config.content.mjs`, `vite.config.desktop.mts`) — they contain no "browserx" references.

**Rationale**: Build configs use path aliases and generic configuration, not product names.

## Decision 5: Specs Directory

**Decision**: Existing specs in `specs/` that reference "browserx" will NOT be updated. They are historical records.

**Rationale**: Past specs document what was true at the time. Retroactively updating them would misrepresent the history. Only the current spec (022) and active documentation (README, CLAUDE.md) need updating.
