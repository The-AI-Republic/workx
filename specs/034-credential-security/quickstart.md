# Quickstart: Chrome Extension Credential Security

**Feature**: 034-credential-security
**Date**: 2026-02-24

## Prerequisites

1. Node.js and npm installed
2. Chrome browser for extension testing
3. Project dependencies installed: `npm install`

## Environment Setup

Add the vault secret to `src/extension/.env`:

```bash
# Generate a 32+ character secret (run once, keep stable across versions)
node -e "console.log('VITE_VAULT_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Add the output line to `src/extension/.env`:
```
VITE_VAULT_SECRET=<your-generated-secret>
```

Also add to `.env.example` (with a placeholder value):
```
VITE_VAULT_SECRET=replace-with-a-32-char-secret-for-credential-encryption
```

## Build & Test

```bash
# Run tests
npm test

# Run tests once (CI mode)
npm run test:all

# Type check
npm run type-check

# Build extension
npm run build

# Load in Chrome:
# 1. Open chrome://extensions
# 2. Enable Developer Mode
# 3. Load unpacked → select dist/ folder
```

## Key Files

| File | Purpose |
| ---- | ------- |
| `src/core/crypto/VaultCrypto.ts` | Low-level crypto operations (AES-GCM, PBKDF2, key wrap) |
| `src/core/crypto/VaultManager.ts` | High-level vault state management |
| `src/core/crypto/types.ts` | TypeScript interfaces for vault entities |
| `src/extension/storage/ChromeCredentialStore.ts` | Updated to use VaultManager |
| `src/extension/background/service-worker.ts` | Vault message handlers |
| `src/webfront/stores/vaultStore.ts` | Svelte store for UI state |
| `src/webfront/settings/SecuritySettings.svelte` | PIN management settings UI |
| `src/webfront/components/vault/PinUnlockOverlay.svelte` | Lock screen overlay |

## Manual Testing Checklist

### Layer 1 (Transparent Encryption)
1. Save an API key for any provider
2. Open Chrome DevTools → Application → Extension Storage
3. Verify stored credential is JSON with `ciphertext`, `iv`, `salt` (not plain text)
4. Verify `browserx-vault-metadata` contains `wrappedKey` (not raw key)
5. Use the extension normally — API calls should work transparently

### Layer 2 (PIN Protection)
1. Go to Settings → Security → Enable PIN Protection
2. Enter a 6-digit PIN and confirm
3. Close and reopen Chrome completely
4. Open BrowserX side panel — should show PIN unlock overlay
5. Enter PIN — extension should unlock and work normally
6. Test wrong PIN 5 times — should show 30-second cooldown

### Migration
1. Before updating, save an API key with the old extension version
2. Update to the new version
3. Use the extension — old API key should work (migrated transparently)
4. Verify in storage that the credential is now in encrypted JSON format
