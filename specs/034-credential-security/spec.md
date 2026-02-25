# Feature Specification: Chrome Extension Credential Security

**Feature Branch**: `034-credential-security`
**Created**: 2026-02-24
**Status**: Draft
**Input**: User description: "Add security protection for API key credentials stored in the Chrome extension using PIN-based encryption"

## Clarifications

### Session 2026-02-24

- Q: Is PIN setup mandatory before saving API keys, or opt-in/skippable? → A: Two-layer approach — Layer 1 (transparent encryption with build-time secret) is automatic with zero friction. Layer 2 (PIN protection) is fully opt-in from security settings.
- Q: How long should the lockout cooldown last after 5 failed PIN attempts? → A: 30 seconds — good balance of security and usability for local-only threat model.
- Q: Should the vault auto-lock after a period of inactivity? → A: No auto-lock. Session persists until browser close. Simpler UX, matches personal device usage.
- Q: Where is the encryption key stored? → A: The encryption key is NEVER stored raw. It is always wrapped — by default using a build-time secret from `.env` (32+ character string), and when the user enables PIN, the wrapping is replaced with their PIN-derived key. This ensures the raw encryption key never appears in storage.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Transparent Encryption (Priority: P1)

A new user installs BrowserX and saves their first API key for any provider. The system automatically generates an encryption key behind the scenes, wraps it using a build-time secret, and encrypts the API key before storing it. The user notices no difference in experience — no prompts, no PIN, no extra steps. Their API keys are encrypted at rest in persistent storage, and the raw encryption key never appears in storage.

**Why this priority**: This is the zero-friction baseline that protects every user automatically. No user action required — encryption happens transparently on every API key save.

**Independent Test**: Can be fully tested by saving an API key, then inspecting `chrome.storage.local` to confirm the stored value is encrypted (not readable as plain text) and that no raw encryption key exists in storage. Delivers baseline credential protection with zero UX impact.

**Acceptance Scenarios**:

1. **Given** a fresh install with no prior configuration, **When** the user saves an API key for any provider, **Then** the key is automatically encrypted before being written to persistent storage with no user prompts
2. **Given** a user has saved encrypted API keys, **When** the extension needs to use an API key for a provider call, **Then** the key is transparently decrypted in memory without any user interaction
3. **Given** a user has existing plain-text or obfuscated API keys from before this feature, **When** the extension is updated, **Then** existing keys are automatically migrated to the encrypted format on first access
4. **Given** a user inspects persistent storage directly, **When** they view the stored credential data and encryption key, **Then** neither the API keys nor the raw encryption key are human-readable — only encrypted ciphertext and a wrapped key blob are visible
5. **Given** a user without PIN protection restarts their browser, **When** they use BrowserX, **Then** no unlock prompt is shown — API keys are available immediately via transparent decryption using the build-time secret

---

### User Story 2 - Enabling Optional PIN Protection (Priority: P2)

A security-conscious user navigates to security settings and chooses to enable PIN protection. They create a 6-digit PIN. The system re-wraps the encryption key — replacing the build-time secret wrapping with the user's PIN-derived key. From this point, API keys can only be decrypted when the user provides their PIN, because the build-time secret can no longer unwrap the encryption key.

**Why this priority**: This adds real security for users who want it. With PIN enabled, even an attacker who knows the build-time secret and has full filesystem access cannot decrypt the API keys — they need the user's PIN.

**Independent Test**: Can be fully tested by enabling PIN protection in settings, restarting the browser, and verifying the unlock prompt appears before API keys are accessible. Delivers the value of user-controlled enhanced security.

**Acceptance Scenarios**:

1. **Given** a user has API keys stored with default encryption, **When** they navigate to security settings and choose "Enable PIN Protection", **Then** they are prompted to create a 6-digit numeric PIN
2. **Given** the PIN creation prompt is shown, **When** the user enters a 6-digit numeric PIN and confirms it, **Then** the system re-wraps the encryption key with the PIN-derived key, replacing the build-time secret wrapping
3. **Given** the PIN creation prompt is shown, **When** the user enters a PIN shorter than 6 digits or with non-numeric characters, **Then** the system shows a validation error
4. **Given** the PIN creation prompt is shown, **When** the user enters a PIN that does not match the confirmation field, **Then** the system shows a mismatch error
5. **Given** PIN protection is enabled, **When** the user saves a new API key, **Then** the key is encrypted using the encryption key that is now only accessible via PIN

---

### User Story 3 - Unlocking the Vault After Browser Restart (Priority: P2)

A user with PIN protection enabled opens their browser after closing it. They navigate to BrowserX and attempt to use an AI provider. The system detects that the PIN session has expired and prompts the user to enter their 6-digit PIN. After entering the correct PIN, the encryption key is unwrapped and all stored API keys become available for the remainder of the browser session.

**Why this priority**: This is the primary recurring interaction for PIN-enabled users. Must be seamless and fast. Only applies to users who opted into PIN protection.

**Independent Test**: Can be fully tested by enabling PIN protection, closing and reopening the browser, then verifying the unlock prompt appears and correctly restores access to all stored API keys.

**Acceptance Scenarios**:

1. **Given** a user has PIN protection enabled and restarts their browser, **When** they try to use BrowserX, **Then** they are prompted to enter their PIN before any API calls can be made
2. **Given** the unlock prompt is displayed, **When** the user enters the correct PIN, **Then** all stored API keys become available and remain accessible until the browser closes or the extension reloads
3. **Given** the unlock prompt is displayed, **When** the user enters an incorrect PIN, **Then** the system shows an error and does not decrypt the keys
4. **Given** a user enters incorrect PINs repeatedly, **When** they reach 5 consecutive failed attempts, **Then** the system enforces a 30-second cooldown before allowing more attempts. The counter resets after a successful unlock.
5. **Given** a user without PIN protection restarts their browser, **When** they use BrowserX, **Then** no unlock prompt is shown — API keys are available immediately via the build-time secret

---

### User Story 4 - Changing the PIN (Priority: P3)

A user wants to change their existing PIN. They navigate to security settings, enter their current PIN for verification, then enter and confirm a new 6-digit PIN. The encryption key is unwrapped with the old PIN and re-wrapped with the new PIN.

**Why this priority**: Important for security hygiene but not required for initial use.

**Independent Test**: Can be fully tested by changing the PIN, restarting the browser, and unlocking with the new PIN to verify all keys are still accessible.

**Acceptance Scenarios**:

1. **Given** a user has PIN protection enabled, **When** they select "Change PIN" in security settings, **Then** they are prompted to enter their current PIN first
2. **Given** the current PIN is verified, **When** the user enters and confirms a new 6-digit PIN, **Then** the encryption key is re-wrapped with the new PIN-derived key
3. **Given** the PIN change is complete, **When** the user restarts the browser and unlocks with the old PIN, **Then** the unlock fails
4. **Given** the PIN change is complete, **When** the user restarts the browser and unlocks with the new PIN, **Then** all stored credentials are accessible

---

### User Story 5 - Removing PIN Protection (Priority: P3)

A user decides they no longer want PIN protection. They enter their current PIN for verification and choose to disable it. The system unwraps the encryption key with the PIN and re-wraps it with the build-time secret, reverting to Layer 1 behavior. No unlock prompt is shown on future browser restarts.

**Why this priority**: Provides an opt-out path for users who find PIN entry disruptive. Credentials remain protected by Layer 1 (build-time secret wrapping).

**Independent Test**: Can be fully tested by removing PIN protection and verifying that API keys work without unlock prompts after a browser restart.

**Acceptance Scenarios**:

1. **Given** a user has PIN protection enabled, **When** they choose to remove it and enter their current PIN, **Then** the encryption key is re-wrapped with the build-time secret, reverting to default protection
2. **Given** PIN protection has been removed, **When** the user restarts the browser, **Then** no unlock prompt is shown and API keys work immediately

---

### Edge Cases

- What happens when the user forgets their PIN? Since there is no server-side recovery, the user must use the "Forgot PIN" flow which clears all stored credentials and reverts to a fresh state with a new encryption key wrapped by the build-time secret. The user then re-enters their API keys from provider dashboards.
- What happens if the extension is updated while credentials are encrypted? Encrypted credentials must survive extension updates since persistent storage is preserved across updates. The encryption format includes a version identifier for forward compatibility.
- What happens if the build-time secret changes between extension versions? A new version with a different build-time secret would be unable to unwrap keys from the old version. The build-time secret must remain stable across versions, or a migration path must handle re-wrapping.
- What happens if the user has multiple browser profiles? Each profile has its own isolated extension storage, so each profile has its own independent encryption key (wrapped by the same build-time secret or by that profile's PIN).
- What happens during PIN setup if the browser crashes mid-process? The system should only replace the wrapping after all operations complete successfully, falling back to the build-time secret wrapping on failure.
- What happens when the volatile session storage is cleared unexpectedly (e.g., service worker restart)? For default users: the encryption key is re-derived from the build-time secret automatically with no user impact. For PIN-enabled users: the user is prompted to re-enter their PIN.
- What happens if a user saves an API key while PIN protection is enabled but the session is locked? The system prompts for PIN unlock before allowing the save operation.

## Requirements *(mandatory)*

### Functional Requirements

**Layer 1 — Default Encryption (automatic, zero friction)**

- **FR-001**: System MUST automatically generate a strong encryption key on first use and encrypt all API keys before writing them to persistent storage, with no user interaction required
- **FR-002**: System MUST wrap the encryption key using a build-time secret (32+ character string configured via `.env`) so the raw encryption key is never stored in persistent storage
- **FR-003**: System MUST decrypt API keys transparently in memory when needed for provider API calls, by unwrapping the encryption key with the build-time secret, with no user interaction required
- **FR-004**: System MUST use industry-standard authenticated encryption (256-bit keys) for all credential encryption
- **FR-005**: System MUST generate a unique random salt and initialization vector per encryption operation and store them alongside the encrypted data
- **FR-006**: System MUST automatically migrate existing plain-text or obfuscated credentials to the encrypted format on first access after upgrade
- **FR-007**: The build-time secret MUST remain stable across extension version updates to ensure backward compatibility with previously wrapped encryption keys

**Layer 2 — PIN Protection (opt-in)**

- **FR-008**: System MUST provide an "Enable PIN Protection" option in security settings that allows users to create a 6-digit numeric PIN
- **FR-009**: When PIN protection is enabled, system MUST re-wrap the encryption key with a key derived from the user's PIN using industry-standard key derivation (minimum 100,000 iterations), replacing the build-time secret wrapping
- **FR-010**: System MUST store the unwrapped encryption key only in volatile session storage that is automatically cleared when the browser closes or the extension reloads
- **FR-011**: System MUST prompt PIN-enabled users to enter their PIN to unlock credentials after any session expiration (browser restart, extension reload)
- **FR-012**: System MUST validate PIN entries and enforce a 30-second lockout cooldown after 5 consecutive failed unlock attempts. The failed attempt counter resets after a successful unlock.
- **FR-013**: System MUST never store the PIN itself — only a verification hash (derived separately from the key-wrapping derivation) to confirm correctness
- **FR-014**: System MUST allow users to change their PIN by unwrapping with the old PIN and re-wrapping with the new PIN
- **FR-015**: System MUST allow users to remove PIN protection by unwrapping with the PIN and re-wrapping with the build-time secret
- **FR-016**: System MUST provide a "Forgot PIN" path that clears all stored credentials and generates a fresh encryption key wrapped with the build-time secret

**Scope**

- **FR-017**: System MUST only apply to the Chrome extension credential store — the desktop app credential handling via OS keychain is out of scope

### Key Entities

- **Build-Time Secret**: A 32+ character string configured in the project's `.env` file, baked into the extension at build time. Used as the default wrapping key for the encryption key. Same for all users of a given extension build. Provides baseline protection by ensuring the raw encryption key never appears in storage.
- **Extension Encryption Key**: An auto-generated strong encryption key created on first use. Used to encrypt/decrypt all API keys. Never stored raw — always wrapped, either by the build-time secret (default) or by the user's PIN-derived key (when PIN is enabled).
- **Encrypted Credential**: An API key that has been encrypted using the extension encryption key. Stored alongside its salt, initialization vector, and version identifier.
- **Vault PIN**: A 6-digit numeric code chosen by the user (opt-in). Used to derive a key-wrapping key that replaces the build-time secret as the wrapper for the encryption key. Never stored directly — only a verification hash is persisted.
- **PIN Verification Hash**: A separately derived hash (using a distinct salt from the key-wrapping derivation) stored in persistent storage, used solely to verify that the user entered the correct PIN before attempting to unwrap the encryption key.
- **PIN Session**: A temporary runtime state where the unwrapped encryption key is held in volatile memory, enabling decrypt operations without re-prompting for the PIN. Expires on browser close or extension reload. Does not exist for default (non-PIN) users — for those users the encryption key is unwrapped on demand using the build-time secret.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All API keys saved after upgrade are automatically encrypted at rest with zero additional user interaction — verified by direct storage inspection showing only encrypted data and a wrapped (not raw) encryption key
- **SC-002**: Users who enable PIN protection can complete setup in under 60 seconds
- **SC-003**: PIN-enabled users can unlock their credential vault within 10 seconds of entering their PIN after a browser restart
- **SC-004**: All existing API keys are automatically migrated to encrypted format within 5 seconds of extension upgrade
- **SC-005**: Users who forget their PIN can reset and re-enter their API keys within 3 minutes
- **SC-006**: 100% of encryption operations use unique salts and initialization vectors, preventing identical keys from producing identical ciphertext
- **SC-007**: The raw encryption key never appears in persistent storage under any configuration — verified by storage inspection showing only wrapped key blobs

## Assumptions

- The browser's built-in cryptographic APIs are available and fully functional in the extension context (service workers, popups, options pages)
- Volatile session storage is available and reliably clears data on browser close and extension reload
- The build-time secret provides a meaningful defense-in-depth layer: an attacker needs both filesystem access to storage AND access to the extension source code (or built bundle) to decrypt credentials without a PIN
- The build-time secret must be managed carefully — it should not change between extension versions to avoid breaking existing encrypted credentials
- Browser restarts are the natural session boundary for PIN-enabled users — they accept re-entering their PIN after closing and reopening the browser
- The Credential Management API (`navigator.credentials`) is NOT suitable for this use case due to unreliable behavior in extension contexts and conflicts with third-party password managers
- Desktop app already uses OS-level keychain and is out of scope for this feature
- Key derivation with 100,000+ iterations provides sufficient key stretching for a 6-digit numeric PIN against brute-force attacks given that the encrypted data is local-only
- No auto-lock on inactivity — session persists until browser close, matching personal device usage patterns
