# Data Model: Project Rename — Pi Naming Convention

**Feature Branch**: `022-project-rename-pi`
**Date**: 2026-02-16

## Overview

This feature is a rename/refactoring operation. No new data entities, schemas, or storage changes are introduced. The data model section documents the naming mapping that governs all changes.

## Naming Map Entity

The core "data model" for this feature is the naming convention map:

| Context | Code Name | User-Facing Name | Scope |
|---------|-----------|-------------------|-------|
| Project / Repository | `pi` | Pi | GitHub repo, package.json, README, shared code |
| Chrome Extension | `browserx` | BrowserX | `src/extension/`, `_locales/`, extension prompts, manifests |
| Desktop App | `pi` | Apple Pi | `tauri/`, `src/desktop/`, desktop prompt, desktop HTML |

## Rename Mapping

### Class Renames

| Old Name | New Name | File |
|----------|----------|------|
| `BrowserxAgent` | `PiAgent` | `src/core/PiAgent.ts` (renamed from `BrowserxAgent.ts`) |

### Attribute Renames

| Old Value | New Value | File |
|-----------|-----------|------|
| `data-browserx-injected` | `data-pi-injected` | `src/tools/dom/plugins/GoogleDocPlugin.ts` |

### Config Value Updates

| File | Field | Old Value | New Value |
|------|-------|-----------|-----------|
| `package.json` | `name` | `browserx-chrome` | `pi` |
| `tauri/tauri.conf.json` | `productName` | `Pi` | `Apple Pi` (user sees app name) |
| `tauri/tauri.conf.json` | `title` | `Pi` | `Apple Pi` (user sees title bar) |
| `tauri/tauri.conf.json` | `shortDescription` | `Pi - Personal Assistant` | stays `Pi` (config metadata) |
| `tauri/tauri.conf.json` | `longDescription` | `Pi - AI-powered...` | stays `Pi` (config metadata) |
| `src/desktop/index.html` | `<title>` | `BrowserX Desktop` | `Apple Pi` (user sees page title) |

### File Renames

| Old Path | New Path |
|----------|----------|
| `src/core/BrowserxAgent.ts` | `src/core/PiAgent.ts` |
| `src/static/browserx_UI.png` | `src/static/pi_UI.png` |

### Preserved (No Change)

| Item | Value | Reason |
|------|-------|--------|
| Tauri identifier | `com.airepublic.pi` | Code-level, already correct |
| Cargo package name | `pi` | Code-level, already correct |
| Deep-link scheme | `applepi` | Code-level, already correct |
| Extension manifest name | `BrowserX` | Extension product name |
| CSS custom properties | `--browserx-*` | Extension-specific |
| Custom events | `browserx:*` | Extension-specific |
| Locale message keys | `*browserx*` | Extension-specific (Chrome i18n) |
| Extension prompt files | `default_browserx_agent_prompt.md`, `browserx_intro.md`, `browserx_tools.md` | Extension product name |

## State Transitions

N/A — No state machines or lifecycle changes. This is a static rename operation.

## Validation Rules

- After rename: `grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/` returns zero results
- After rename: `grep -ri "BrowserX" src/extension/` returns results (extension code preserved)
- Both build targets (Chrome extension + Tauri desktop) compile successfully
- All tests pass
