# Implementation Plan: Chrome Extension Credential Security

**Branch**: `034-credential-security` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/034-credential-security/spec.md`

## Summary

Replace the current weak obfuscation (`btoa(reversed)`) in the Chrome extension's credential storage with a two-layer encryption system:

- **Layer 1 (automatic)**: AES-256-GCM encryption with key wrapping via a build-time secret from `.env`. Zero user friction — all API keys encrypted transparently at rest.
- **Layer 2 (opt-in)**: User sets a 6-digit PIN that replaces the build-time secret as the key wrapper via PBKDF2 derivation. Provides real protection against filesystem-level attackers.

The encryption key is **never stored raw** — always wrapped by either the build-time secret or the user's PIN.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Web Crypto API (`crypto.subtle`), `chrome.storage.local`, `chrome.storage.session`, Svelte 4.2.20, Vite 5.4.20
**Storage**: `chrome.storage.local` (persistent encrypted credentials + wrapped key), `chrome.storage.session` (volatile unwrapped key for PIN sessions)
**Testing**: Vitest 3.2.4 with jsdom + Chrome API mocks (`src/__test-utils__/setup.ts`)
**Target Platform**: Chrome Extension (Manifest V3), service worker background
**Project Type**: Browser extension (Svelte frontend + service worker backend)
**Performance Goals**: Encrypt/decrypt < 50ms per operation, unlock < 100ms after PIN entry
**Constraints**: Web Crypto API only (no native modules), `chrome.storage.session` 10MB limit, service worker lifecycle (may restart)
**Scale/Scope**: 1-10 API keys per user, single user per browser profile

## Constitution Check

*GATE: No constitution configured (template only). No gates to enforce. Proceeding.*

## Project Structure

### Documentation (this feature)

```text
specs/034-credential-security/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── vault-api.md     # Internal API contracts
└── tasks.md             # Phase 2 output (/rr.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── crypto/
│   │   ├── VaultCrypto.ts           # AES-GCM encrypt/decrypt, PBKDF2, key wrap/unwrap
│   │   ├── VaultManager.ts          # High-level vault state: init, unlock, lock, PIN ops
│   │   ├── types.ts                 # Vault-related types and interfaces
│   │   └── __tests__/
│   │       ├── VaultCrypto.test.ts
│   │       └── VaultManager.test.ts
│   ├── storage/
│   │   ├── CredentialStore.ts       # Existing interface (unchanged)
│   │   └── __tests__/
│   │       └── CredentialStore.test.ts  # Existing (update)
│   └── messaging/
│       └── MessageRouter.ts         # Add vault message types
├── extension/
│   ├── storage/
│   │   └── ChromeCredentialStore.ts # Update: integrate VaultManager for encrypt/decrypt
│   ├── background/
│   │   └── service-worker.ts        # Update: initialize VaultManager, handle vault messages
│   └── .env                         # Add VITE_VAULT_SECRET
├── config/
│   └── AgentConfig.ts               # Update: migration logic for existing credentials
├── utils/
│   └── encryption.ts                # Deprecated, replaced by VaultCrypto
├── webfront/
│   ├── stores/
│   │   └── vaultStore.ts            # New: vault locked/unlocked state
│   ├── settings/
│   │   └── SecuritySettings.svelte  # New: PIN enable/disable/change UI
│   ├── components/
│   │   └── vault/
│   │       ├── PinUnlockOverlay.svelte  # Full-screen PIN entry when locked
│   │       └── PinSetupDialog.svelte    # PIN creation/change dialog
│   ├── pages/settings/
│   │   └── Settings.svelte          # Update: add Security category
│   └── App.svelte                   # Update: gate on vault lock state
└── __test-utils__/
    └── crypto-mock.ts               # Web Crypto API mock for tests
```

**Structure Decision**: Follows existing project conventions — core logic in `src/core/`, extension-specific in `src/extension/`, UI in `src/webfront/`. New `crypto/` module under `core/` for platform-agnostic encryption logic. New `vault/` component directory for lock/unlock UI.
