# Research: Chrome Extension Credential Security

**Feature**: 034-credential-security
**Date**: 2026-02-24

## R1: Encryption Algorithm Selection

**Decision**: AES-256-GCM via Web Crypto API (`crypto.subtle`)

**Rationale**:
- AES-GCM provides authenticated encryption (integrity + confidentiality in one operation)
- 256-bit key length is industry standard for sensitive data
- Web Crypto API is natively available in Chrome extension contexts (service workers, popups, options pages)
- No external dependencies needed — built into the browser
- Returns `ArrayBuffer` — efficient for binary operations

**Alternatives considered**:
- AES-CBC: Lacks built-in authentication; requires separate HMAC. More code, more room for error.
- ChaCha20-Poly1305: Not available in Web Crypto API.
- External libraries (tweetnacl, libsodium.js): Adds bundle size, supply chain risk, unnecessary when native API is available.

## R2: Key Derivation for PIN

**Decision**: PBKDF2 with SHA-256, 100,000 iterations

**Rationale**:
- PBKDF2 is natively available in Web Crypto API
- 100,000 iterations meets OWASP 2023 minimum recommendation for PBKDF2-SHA256
- 6-digit PIN has only 1M combinations, so iteration count is critical for brute-force resistance
- With 100k iterations, ~100 seconds to exhaust keyspace on a modern CPU — sufficient for local-only threat model
- Salt is 16 bytes, randomly generated per operation

**Alternatives considered**:
- Argon2: Strongest option but NOT available in Web Crypto API. Would require WASM library (~100KB+), adding complexity and bundle size.
- scrypt: Also not available in Web Crypto API.
- bcrypt: Not available in Web Crypto API, designed for password hashing not key derivation.
- Higher iteration counts (500k, 1M): Adds latency. 100k takes ~100ms on modern hardware, which is good UX. Higher would degrade unlock experience.

## R3: Key Wrapping Strategy

**Decision**: AES-KW (AES Key Wrap) via `crypto.subtle.wrapKey()` / `unwrapKey()`

**Rationale**:
- Web Crypto API provides native `wrapKey()` and `unwrapKey()` operations
- AES-KW is specifically designed for wrapping cryptographic keys (RFC 3394)
- Wrapping key derived from either build-time secret (PBKDF2) or user PIN (PBKDF2)
- Eliminates manual encrypt/decrypt of raw key bytes — the API handles it correctly
- Wrapped key can be exported as `ArrayBuffer` and stored as base64 in `chrome.storage.local`

**Alternatives considered**:
- Manual AES-GCM encrypt of exported key bytes: Works but reinvents what `wrapKey()` does natively. More error-prone.
- RSA-OAEP wrapping: Overkill for symmetric key wrapping, larger output, slower.

## R4: Build-Time Secret Injection

**Decision**: Vite environment variable `VITE_VAULT_SECRET` in `src/extension/.env`

**Rationale**:
- Project already uses Vite with `envDir: 'src/extension/'` to load `.env` files
- Variables prefixed `VITE_` are automatically available via `import.meta.env.VITE_VAULT_SECRET`
- Baked into the built JS bundle at compile time — available in service worker and all extension contexts
- `.env` files are gitignored; `.env.example` documents required variables
- `scripts/check-env.js` already validates env files before build — can add VITE_VAULT_SECRET check

**Alternatives considered**:
- Vite `define` in `vite.config.mjs`: Works but mixes config with secrets. `.env` is the standard Vite pattern.
- Chrome extension `storage.local` with a seeded value: Would be in the same storage as wrapped keys — defeats purpose.
- Hardcoded constant in source: Visible in git history. `.env` keeps it out of version control.

## R5: Volatile Session Storage

**Decision**: `chrome.storage.session` for caching unwrapped encryption key (PIN mode)

**Rationale**:
- Automatically cleared when browser closes or extension reloads — matches spec requirement
- In-memory only, never written to disk
- 10MB limit is more than sufficient (encryption key is 32 bytes)
- Default access level `TRUSTED_CONTEXTS` restricts to extension code only
- For non-PIN mode, the key is unwrapped on-demand from the build-time secret (no session caching needed)

**Alternatives considered**:
- JavaScript variable in service worker: Lost on service worker restart (which happens frequently in MV3). Would require re-prompting PIN more often than desired.
- `chrome.storage.local` with a separate "session" key: Persists to disk — defeats the purpose.
- IndexedDB: Also persists to disk.

## R6: PIN Verification Hash Strategy

**Decision**: Separate PBKDF2 derivation with distinct salt, stored alongside wrapped key metadata

**Rationale**:
- Must verify PIN correctness before attempting key unwrap (to provide user-friendly error messages and to count failed attempts)
- Using a **separate** salt + PBKDF2 derivation ensures the verification hash cannot be used to derive the wrapping key
- Stored as: `{ verificationHash: base64, verificationSalt: base64 }` in `chrome.storage.local`
- Comparison: derive hash from entered PIN + stored salt, compare with stored hash

**Alternatives considered**:
- Try-unwrap-and-check: Attempt to unwrap key and check if result is valid. Works but provides poor error handling — `unwrapKey()` throws generic `OperationError`, can't distinguish wrong PIN from corrupted data.
- HMAC of PIN: Simpler but doesn't benefit from key stretching. PBKDF2 adds brute-force resistance.

## R7: Migration Strategy for Existing Credentials

**Decision**: On-demand migration during first credential access after upgrade

**Rationale**:
- Current credentials use `btoa(reversed)` format — easily detectable (valid base64, decodes to reversed API key pattern)
- Migration happens transparently: when `ChromeCredentialStore.get()` is called, detect old format, decrypt with old method, re-encrypt with new method, save back
- No separate migration step needed — lazy migration is simpler and safer
- Marker for migration status: store a `vault-version` key in `chrome.storage.local`

**Alternatives considered**:
- Eager migration on extension update: Runs in service worker `onInstalled` event. Riskier — if migration fails partway, credentials could be corrupted. Lazy migration is safer per-credential.
- Dual-read support forever: Read both old and new formats indefinitely. Adds permanent code complexity.

## R8: Lockout Mechanism

**Decision**: In-memory counter in service worker, 30-second cooldown after 5 failures

**Rationale**:
- Failed attempt counter stored in service worker memory (not persisted)
- If service worker restarts, counter resets to 0 — acceptable because attacker would also lose their automation context
- 30-second cooldown is enforced by timestamp comparison, not `setTimeout` (survives service worker lifecycle)
- Cooldown timestamp stored in `chrome.storage.session` so it survives service worker restarts within a browser session

**Alternatives considered**:
- Persistent counter in `chrome.storage.local`: Could lock out legitimate users across sessions if they forget PIN. In-memory is more forgiving.
- Escalating cooldowns: More complex, marginal benefit for local-only threat model.

## R9: UI Integration Points

**Decision**: Root-level unlock overlay in App.svelte + new SecuritySettings category

**Rationale**:
- **Unlock overlay**: App.svelte wraps Router with conditional — if vault is PIN-locked, show `PinUnlockOverlay` instead of routes. This gates ALL extension functionality.
- **Settings**: Add 8th category "Security" to SettingsMenu.svelte, implemented as `SecuritySettings.svelte`
- **Stores**: New `vaultStore.ts` Svelte store tracks `{ isLocked, isPinEnabled, isInitialized }`
- **Message passing**: New message types in MessageRouter for vault operations (VAULT_UNLOCK, VAULT_STATUS, PIN_SET, PIN_CHANGE, PIN_REMOVE, VAULT_FORGOT_PIN)
- Follows existing patterns: event dispatchers, `settingsConfig.updateConfig()`, `notifyConfigUpdate()`

**Alternatives considered**:
- Popup modal instead of overlay: Less secure — user might dismiss or navigate around it.
- Separate unlock page/route: Adds routing complexity. Overlay is simpler and more secure.

## R10: Web Crypto API in Service Worker Context

**Decision**: All crypto operations run in the service worker via message passing

**Rationale**:
- `crypto.subtle` is fully available in MV3 service workers as `self.crypto.subtle`
- Centralizing crypto in the service worker ensures:
  - Single source of truth for vault state
  - No need to pass keys to the frontend
  - Frontend only sends PIN and receives success/failure
- `CryptoKey` objects are NOT serializable — they stay in the service worker's memory
- The unwrapped `CryptoKey` can be stored in a module-level variable and also backed by `chrome.storage.session` (as exported raw key bytes for service worker restart recovery)

**Alternatives considered**:
- Crypto in the popup/sidepanel: Would require sending raw key material over message passing. Less secure.
- Shared worker: Not available in Chrome extensions.
