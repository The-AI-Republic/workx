# Implementation Plan: ChatGPT OAuth Subscription Authentication

**Branch**: `032-chatgpt-oauth` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/032-chatgpt-oauth/spec.md`
**Design Reference**: [.ai_design/chatgpt_oauth_design.md](../../.ai_design/chatgpt_oauth_design.md)

## Summary

Enable BrowserX users to authenticate with their ChatGPT subscription (Plus/Pro/Business/Enterprise) via OpenAI's Codex OAuth flow, eliminating the need for a separate API key. The implementation adds an Authorization Code + PKCE OAuth flow using OpenAI's public client ID. The OAuth access token is used as a drop-in replacement for API keys (both use `Authorization: Bearer <token>`), requiring no changes to existing OpenAI client code. Desktop uses a temporary Rust localhost server for the OAuth callback; the Chrome extension intercepts the redirect via tab URL monitoring.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (frontend/core), Rust 2021 edition (Tauri backend)
**Primary Dependencies**: Svelte 4.2.20, Tauri 2.x, `openai@6.6.0`, `tokio` (full features)
**Storage**: OS Keychain via `keyring` crate (desktop), `chrome.storage.local` (extension)
**Testing**: Vitest 3.2.4
**Target Platform**: Desktop (macOS, Windows, Linux via Tauri), Chrome Extension
**Project Type**: Dual-mode desktop app + browser extension
**Performance Goals**: OAuth sign-in completes within 2 minutes; token refresh is transparent
**Constraints**: Must use OpenAI's fixed redirect URI `http://localhost:1455/callback`; PKCE required (public client, no secret)
**Scale/Scope**: Single-user local authentication; no server infrastructure required

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution file contains only template placeholders — no project-specific principles defined. No gates to evaluate. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/032-chatgpt-oauth/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── chatgpt-oauth-api.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks)
```

### Source Code (repository root)

```text
# New files
src/core/auth/
├── ChatGPTOAuthService.ts          # Platform-agnostic PKCE OAuth logic

src/desktop/auth/
├── ChatGPTOAuthDesktopStorage.ts   # Keychain token storage adapter
├── ChatGPTOAuthDesktopFlow.ts      # Desktop login flow coordinator

src/extension/auth/
├── ChatGPTOAuthExtensionStorage.ts # chrome.storage token storage adapter
├── ChatGPTOAuthExtensionFlow.ts    # Extension login flow coordinator

tauri/src/
├── oauth_server.rs                 # Rust localhost callback server

# Modified files
src/config/types.ts                 # Add authMethod to IStoredProviderConfig
src/core/models/types/Auth.ts       # Add chatgpt_oauth auth mode + IAuthManager methods
src/core/models/ModelClientFactory.ts # OAuth token injection in loadConfigForProvider()
src/webfront/settings/ModelSettings.svelte  # "Sign in with ChatGPT" UI section
src/desktop/agent/DesktopAgentBootstrap.ts  # OAuth token restoration on startup
tauri/src/main.rs                   # Register start_oauth_callback_server command

# Test files
tests/unit/core/auth/ChatGPTOAuthService.test.ts  # PKCE, token exchange, refresh tests
```

**Structure Decision**: Follows the existing platform-specific directory pattern — `src/core/` for shared logic, `src/desktop/auth/` for Tauri-specific auth, `src/extension/auth/` for Chrome-specific auth. The Rust callback server goes in `tauri/src/` alongside existing command modules.

## Complexity Tracking

No constitution violations to justify — architecture follows existing patterns exactly.
