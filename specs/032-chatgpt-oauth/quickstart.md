# Quickstart: ChatGPT OAuth Subscription Authentication

**Feature**: 032-chatgpt-oauth
**Date**: 2026-02-24

## Prerequisites

- BrowserX desktop app or Chrome extension installed
- A ChatGPT Plus, Pro, Business, or Enterprise subscription
- Node.js and Rust toolchain (for development)

## Development Setup

```bash
# Install dependencies
npm install

# Start desktop dev mode
npm run tauri:dev

# Or start extension dev mode
npm run dev
```

## Testing the Feature

### Desktop Flow

1. Open BrowserX desktop app
2. Navigate to Settings
3. Select an OpenAI model from the model selector
4. In the OpenAI provider section, click **"Sign in with ChatGPT"**
5. A browser window opens — log in with your ChatGPT account
6. After login, the browser tab closes and BrowserX shows **"Connected via ChatGPT"**
7. Send a message to verify the connection works

### Extension Flow

1. Open the BrowserX Chrome extension sidepanel
2. Navigate to Settings
3. Select an OpenAI model
4. Click **"Sign in with ChatGPT"**
5. A new tab opens — log in with your ChatGPT account
6. The tab closes and the extension shows **"Connected via ChatGPT"**
7. Send a message to verify

### Switching Auth Methods

- To switch from OAuth to API key: Enter an API key in the OpenAI provider settings and save
- To switch from API key to OAuth: Click "Sign in with ChatGPT" and complete the flow
- To disconnect OAuth: Click "Disconnect" in the ChatGPT connection status section

## Running Tests

```bash
# Run all unit tests
npm test

# Run only ChatGPT OAuth tests
npx vitest run tests/unit/core/auth/ChatGPTOAuthService.test.ts

# Run lint
npm run lint

# Build desktop app
npm run tauri:build

# Build extension
npm run build
```

## Key Files

| File | Purpose |
|------|---------|
| `src/core/auth/ChatGPTOAuthService.ts` | Core PKCE OAuth logic (platform-agnostic) |
| `src/desktop/auth/ChatGPTOAuthDesktopFlow.ts` | Desktop login flow coordinator |
| `src/desktop/auth/ChatGPTOAuthDesktopStorage.ts` | OS keychain token storage |
| `src/extension/auth/ChatGPTOAuthExtensionFlow.ts` | Extension login flow coordinator |
| `src/extension/auth/ChatGPTOAuthExtensionStorage.ts` | Chrome storage token adapter |
| `tauri/src/oauth_server.rs` | Rust localhost callback server |
| `src/core/models/ModelClientFactory.ts` | Integration point (OAuth token as API key) |
| `src/webfront/settings/ModelSettings.svelte` | Settings UI for sign-in button |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Failed to bind port 1455" | Close any application using port 1455 (e.g., another Codex CLI instance) |
| Browser doesn't open | Check your default browser setting; try opening the URL manually |
| "OAuth callback timed out" | Complete the login within 5 minutes; check browser is not blocked |
| "Connected" but API calls fail | Your subscription tier may not include the selected model; try a different model |
| Token refresh errors | Click "Disconnect" and sign in again |
