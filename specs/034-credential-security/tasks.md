# Tasks: Chrome Extension Credential Security

**Input**: Design documents from `/specs/034-credential-security/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in the feature specification. Test tasks are not included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environment configuration and type definitions

- [X] T001 Add `VITE_VAULT_SECRET` environment variable to `src/extension/.env` (generate 32+ char base64 secret) and add placeholder to `.env.example`
- [X] T002 [P] Add `VITE_VAULT_SECRET` validation to `scripts/check-env.js` to fail the build if the secret is missing or shorter than 32 characters
- [X] T003 [P] Create vault type definitions (VaultMetadata, EncryptedCredential, VaultSession, VaultState, VaultUnlockResult) in `src/core/crypto/types.ts` per data-model.md
- [X] T004 [P] Create Web Crypto API test mock with `crypto.subtle` stubs (generateKey, deriveKey, wrapKey, unwrapKey, encrypt, decrypt, exportKey, importKey) in `src/__test-utils__/crypto-mock.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core crypto module and vault state management that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 Implement VaultCrypto module in `src/core/crypto/VaultCrypto.ts` with: generateEncryptionKey (AES-256-GCM), deriveWrappingKey (PBKDF2, 100k iterations, SHA-256), wrapKey/unwrapKey (AES-KW), encrypt/decrypt (AES-GCM with random IV + salt), deriveVerificationHash, generateSalt, generateIV, exportKey/importKey — per contracts/vault-api.md IVaultCrypto interface
- [X] T006 Add vault message types (VAULT_STATUS, VAULT_UNLOCK, VAULT_LOCK, PIN_SET, PIN_CHANGE, PIN_REMOVE, PIN_FORGOT) to the MessageRouter enum in `src/core/messaging/MessageRouter.ts` per contracts/vault-api.md
- [X] T007 Implement VaultManager in `src/core/crypto/VaultManager.ts` with: initialize (detect vault state, restore session), getStatus, getEncryptionKey (unwrap on-demand for default mode or from session for PIN mode), encryptCredential, decryptCredential, migrateIfNeeded (legacy btoa+reverse detection), enablePin, changePin, removePin, unlock, lock, reset — per contracts/vault-api.md IVaultManager interface. Uses VaultCrypto internally. Reads `VITE_VAULT_SECRET` via `import.meta.env.VITE_VAULT_SECRET`. Stores/reads VaultMetadata from `chrome.storage.local` and VaultSession from `chrome.storage.session`.

**Checkpoint**: Core crypto and vault state management ready — user story implementation can now begin

---

## Phase 3: User Story 1 - Automatic Transparent Encryption (Priority: P1) MVP

**Goal**: All API keys encrypted transparently at rest with zero user friction. Encryption key always wrapped (never raw in storage). Existing credentials migrated automatically.

**Independent Test**: Save an API key, inspect `chrome.storage.local` — stored value should be JSON with `ciphertext`, `iv`, `salt` fields (not plain text). `browserx-vault-metadata` should contain `wrappedKey` (not a raw key). Extension should work normally with no new prompts.

### Implementation for User Story 1

- [X] T008 [US1] Update `ChromeCredentialStore.set()` in `src/extension/storage/ChromeCredentialStore.ts` to encrypt credential values via VaultManager.encryptCredential() before writing to `chrome.storage.local`. Store the EncryptedCredential JSON object (not plain string) at the existing key format `browserx-credential:{service}:{account}`.
- [X] T009 [US1] Update `ChromeCredentialStore.get()` in `src/extension/storage/ChromeCredentialStore.ts` to: (1) read the stored value, (2) if it's a JSON object with `version` field → decrypt via VaultManager.decryptCredential(), (3) if it's a plain string → call VaultManager.migrateIfNeeded() to detect legacy format, re-encrypt, save back, and return the plaintext.
- [X] T010 [US1] Add VaultManager initialization to the `initialize()` function in `src/extension/background/service-worker.ts`: call `VaultManager.initialize()` after `setCredentialStore()`, add VAULT_STATUS message handler that returns `VaultManager.getStatus()`. Log initialization result.
- [X] T011 [US1] Add `VITE_VAULT_SECRET` type declaration to Vite's `ImportMetaEnv` interface (in `src/vite-env.d.ts` or equivalent) so TypeScript recognizes `import.meta.env.VITE_VAULT_SECRET`.
- [X] T012 [US1] Deprecate `src/utils/encryption.ts` — add `@deprecated` JSDoc to `encryptApiKey` and `decryptApiKey` functions. Do NOT remove yet (needed by migration logic in VaultManager.migrateIfNeeded to detect legacy format).

**Checkpoint**: User Story 1 complete — all API keys encrypted at rest, legacy credentials migrated on access, zero UX change

---

## Phase 4: User Story 2 - Enabling Optional PIN Protection (Priority: P2)

**Goal**: Security-conscious users can enable PIN protection from settings. PIN re-wraps the encryption key, replacing the build-time secret. Build-time secret can no longer decrypt.

**Independent Test**: Navigate to Settings → Security → Enable PIN Protection. Enter a 6-digit PIN. Verify in storage that `browserx-vault-metadata.pinEnabled` is true and `wrappedKey` has changed. API keys should still work in current session.

### Implementation for User Story 2

- [X] T013 [US2] Create vault Svelte store in `src/webfront/stores/vaultStore.ts` with writable store for VaultState (isInitialized, isPinEnabled, isLocked, isLockedOut, lockoutSecondsRemaining). Add `refreshVaultStatus()` function that sends VAULT_STATUS message to service worker and updates the store.
- [X] T014 [P] [US2] Create PinSetupDialog Svelte component in `src/webfront/components/vault/PinSetupDialog.svelte` with: 6-digit numeric PIN input, confirmation input, validation (6 digits, numeric only, match), submit handler that sends PIN_SET message to service worker, error display, dispatches `success`/`cancel` events. Follow existing dialog patterns (UnsavedChangesDialog style).
- [X] T015 [P] [US2] Create SecuritySettings Svelte component in `src/webfront/settings/SecuritySettings.svelte` with: PIN protection toggle (Enable/Disable), status display (PIN enabled/disabled), "Enable PIN Protection" button that opens PinSetupDialog, back navigation. Follow existing settings component patterns (ModelSettings.svelte style with event dispatchers for `back` and `saved`).
- [X] T016 [US2] Add "Security" category (8th item) to the settings menu in `src/webfront/settings/components/SettingsMenu.svelte` and wire it in `src/webfront/pages/settings/Settings.svelte` to render SecuritySettings when selected. Use a lock/shield icon consistent with existing icon style.
- [X] T017 [US2] Add PIN_SET message handler to `src/extension/background/service-worker.ts` that: validates PIN format (6 digits), calls VaultManager.enablePin(pin), returns success/error response per contracts/vault-api.md PIN_SET contract.

**Checkpoint**: User Story 2 complete — users can enable PIN protection from settings, encryption key re-wrapped with PIN

---

## Phase 5: User Story 3 - Unlocking the Vault After Browser Restart (Priority: P2)

**Goal**: PIN-enabled users see unlock overlay on browser restart. Correct PIN restores access. Wrong PIN shows error. 5 failures trigger 30-second cooldown. Non-PIN users see nothing.

**Independent Test**: Enable PIN, close Chrome completely, reopen. BrowserX should show PIN overlay instead of normal UI. Enter PIN → normal UI appears. Close Chrome again, reopen, enter wrong PIN 5 times → 30-second cooldown message.

### Implementation for User Story 3

- [X] T018 [US3] Create PinUnlockOverlay Svelte component in `src/webfront/components/vault/PinUnlockOverlay.svelte` with: full-screen overlay that blocks all interaction, 6-digit PIN input field, submit button, error message display (wrong PIN, lockout), lockout countdown timer (30-second visual countdown), "Forgot PIN?" link. Sends VAULT_UNLOCK message on submit. Dispatches `unlocked` event on success. Styled consistently with existing theme (terminal/chatgpt theme support via CSS variables).
- [X] T019 [US3] Update `src/webfront/App.svelte` to: import vaultStore, call refreshVaultStatus() on mount, conditionally render PinUnlockOverlay when `$vaultStore.isLocked === true` instead of the Router. On `unlocked` event, refresh vault status and show Router.
- [X] T020 [US3] Add VAULT_UNLOCK message handler to `src/extension/background/service-worker.ts` that: checks lockout status (if lockoutUntil > now, return locked_out with seconds remaining), verifies PIN via VaultManager.unlock(pin), on success returns `{ success: true, data: { isLocked: false } }`, on failure increments failedAttempts, if failedAttempts >= 5 sets lockoutUntil to now + 30s in VaultSession, returns error response per contracts/vault-api.md.
- [X] T021 [US3] Add VAULT_LOCK message handler to `src/extension/background/service-worker.ts` that calls VaultManager.lock() and returns success.

**Checkpoint**: User Story 3 complete — PIN unlock flow works end-to-end with lockout protection

---

## Phase 6: User Story 4 - Changing the PIN (Priority: P3)

**Goal**: Users can change their existing PIN. Old PIN required for verification. Encryption key re-wrapped with new PIN.

**Independent Test**: Go to Settings → Security → Change PIN. Enter current PIN, then new PIN. Restart browser. Old PIN should fail. New PIN should unlock.

### Implementation for User Story 4

- [X] T022 [US4] Add "Change PIN" section to `src/webfront/settings/SecuritySettings.svelte` (visible when PIN is enabled): current PIN input, new PIN input, confirm new PIN input, validation, submit handler that sends PIN_CHANGE message. Show success/error feedback.
- [X] T023 [US4] Add PIN_CHANGE message handler to `src/extension/background/service-worker.ts` that: validates new PIN format, calls VaultManager.changePin(currentPin, newPin), returns success/error response per contracts/vault-api.md PIN_CHANGE contract.

**Checkpoint**: User Story 4 complete — PIN change works with re-wrapping

---

## Phase 7: User Story 5 - Removing PIN Protection & Forgot PIN (Priority: P3)

**Goal**: Users can remove PIN protection (reverts to build-time secret wrapping). Forgot PIN flow clears all credentials and regenerates fresh vault.

**Independent Test**: (Remove) Enable PIN → Remove PIN → Restart browser → No unlock prompt, API keys work. (Forgot) Enable PIN → Restart → Click "Forgot PIN?" → Confirm → All credentials cleared, vault resets to default.

### Implementation for User Story 5

- [X] T024 [US5] Add "Remove PIN Protection" button to `src/webfront/settings/SecuritySettings.svelte` (visible when PIN is enabled): confirmation prompt requiring current PIN, sends PIN_REMOVE message, updates UI to show PIN disabled state.
- [X] T025 [US5] Add PIN_REMOVE message handler to `src/extension/background/service-worker.ts` that: verifies current PIN, calls VaultManager.removePin(pin), returns success/error response per contracts/vault-api.md PIN_REMOVE contract.
- [X] T026 [US5] Add "Forgot PIN?" flow to `src/webfront/components/vault/PinUnlockOverlay.svelte`: clicking "Forgot PIN?" shows confirmation dialog warning that all API keys will be cleared, on confirm sends PIN_FORGOT message.
- [X] T027 [US5] Add PIN_FORGOT message handler to `src/extension/background/service-worker.ts` that: calls VaultManager.reset() (clears all `browserx-credential:*` keys from storage, clears vault metadata, generates fresh encryption key wrapped with build-time secret), returns success response per contracts/vault-api.md PIN_FORGOT contract.

**Checkpoint**: User Story 5 complete — full PIN lifecycle (enable, change, remove, forgot) works end-to-end

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, edge cases, and hardening

- [X] T028 Verify `AgentConfig.getProviderApiKey()` and `setProviderApiKey()` in `src/config/AgentConfig.ts` work correctly with the updated ChromeCredentialStore (encrypted values). Ensure the `[SECURED]` marker pattern in IProviderConfig still works as expected.
- [X] T029 [P] Handle service worker restart recovery in `src/core/crypto/VaultManager.ts`: on initialize(), check `chrome.storage.session` for existing VaultSession with encryptionKeyRaw. If found, re-import the CryptoKey from raw bytes to restore session without PIN re-entry.
- [X] T030 [P] Add version identifier check to VaultManager.decryptCredential() in `src/core/crypto/VaultManager.ts` for forward compatibility: if EncryptedCredential.version > supported version, throw descriptive error instead of silent failure.
- [X] T031 Run quickstart.md manual testing checklist (Layer 1 transparent encryption, Layer 2 PIN protection, migration) to validate end-to-end behavior.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001-T004) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational (T005-T007) — MVP target
- **US2 (Phase 4)**: Depends on US1 (Phase 3) — needs working encrypt/decrypt
- **US3 (Phase 5)**: Depends on US2 (Phase 4) — needs PIN to be settable
- **US4 (Phase 6)**: Depends on US2 (Phase 4) — needs PIN to be enabled
- **US5 (Phase 7)**: Depends on US2 (Phase 4) — needs PIN to be enabled
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Standalone after Foundational — no dependency on other stories
- **US2 (P2)**: Depends on US1 (encrypted credential store must work)
- **US3 (P2)**: Depends on US2 (PIN must be settable to test unlock)
- **US4 (P3)**: Depends on US2 only (can run in parallel with US3)
- **US5 (P3)**: Depends on US2 only (can run in parallel with US3 and US4)

### Within Each User Story

- Backend (service worker handlers) before frontend (Svelte components)
- VaultManager integration before UI
- Core functionality before error handling / edge cases

### Parallel Opportunities

- T002, T003, T004 can all run in parallel (different files, no dependencies)
- T014 and T015 can run in parallel (PinSetupDialog and SecuritySettings are separate files)
- US4, US5 can run in parallel after US2 completes (independent PIN operations)
- T029 and T030 can run in parallel (independent polish tasks)

---

## Parallel Example: Phase 1 Setup

```text
# Launch in parallel (all different files):
Task T002: "Add VITE_VAULT_SECRET validation to scripts/check-env.js"
Task T003: "Create vault type definitions in src/core/crypto/types.ts"
Task T004: "Create Web Crypto API test mock in src/__test-utils__/crypto-mock.ts"
```

## Parallel Example: User Story 2

```text
# Launch in parallel (separate Svelte components):
Task T014: "Create PinSetupDialog in src/webfront/components/vault/PinSetupDialog.svelte"
Task T015: "Create SecuritySettings in src/webfront/settings/SecuritySettings.svelte"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 2: Foundational (T005-T007)
3. Complete Phase 3: User Story 1 (T008-T012)
4. **STOP and VALIDATE**: Save API key, inspect storage — confirm encrypted JSON format, confirm wrapped key, confirm API calls still work
5. Deploy/demo if ready — all users get transparent encryption with zero friction

### Incremental Delivery

1. Setup + Foundational → Core crypto ready
2. Add US1 → Transparent encryption works → **MVP ship-ready**
3. Add US2 → PIN can be enabled from settings
4. Add US3 → Locked vault shows unlock overlay
5. Add US4 + US5 (parallel) → Full PIN lifecycle
6. Polish → Edge cases, recovery, hardening

### Story Point Estimates

| Phase | Tasks | Complexity |
| ----- | ----- | ---------- |
| Setup | 4 | Low |
| Foundational | 3 | High (crypto implementation) |
| US1 (MVP) | 5 | Medium |
| US2 | 5 | Medium |
| US3 | 4 | Medium |
| US4 | 2 | Low |
| US5 | 4 | Low-Medium |
| Polish | 4 | Low |
| **Total** | **31** | |

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks in the same phase
- [Story] label maps task to specific user story for traceability
- All crypto operations are in the service worker — frontend never handles raw keys
- The `VITE_VAULT_SECRET` must remain stable across extension versions (FR-007)
- Existing `encryption.ts` is deprecated but kept for migration detection logic
- `chrome.storage.session` is the only volatile storage option in MV3 — critical for PIN session
