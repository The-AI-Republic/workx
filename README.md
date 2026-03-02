# Pi (Personal AI)

**AI-Powered Personal Assistant — Chrome Extension, Desktop App & Headless Server**

Pi is a privacy-preserving, general-purpose AI personal assistant available as a **Chrome extension (BrowserX)**, a **desktop application (Apple Pi)**, and a **headless server (Pi Server)**. The agent interprets natural language commands and autonomously performs tasks across web browsing, planning, and more.

## Naming Convention

| Name | Usage | Context |
|------|-------|---------|
| **Pi** | Project/repo name | Git repository, package name, internal references |
| **BrowserX** | Chrome extension | Extension store listing, extension UI, browser branding |
| **Apple Pi** | Desktop app | Desktop application UI, window title, installer |
| **Pi Server** | Headless server | Server deployment, Docker, API access |

![Pi UI Screenshot](/src/static/pi_UI.png)

---

## Tri-Platform Architecture

Pi runs on three platforms from a shared core:

| App | Platform | Description | Best For |
|-----|----------|-------------|----------|
| **BrowserX** | Chrome Extension | Browser-based agent with web automation | Quick web tasks, browsing assistance |
| **Apple Pi** | Desktop (Win/Mac/Linux) | Native app with full system access | Terminal commands, file operations, advanced automation |
| **Pi Server** | Headless (Docker/K8s) | WebSocket/HTTP server, no UI | API integration, batch automation, CI/CD pipelines |

### How It Works

All three platforms share a **common core** (`src/core/`) containing the agent runtime, tool system, MCP protocol, and model client. Each platform provides its own implementations for channels, storage, and MCP transport:

```
                     ┌─────────────────────────────┐
                     │         src/core/            │
                     │   PiAgent · ToolRegistry     │
                     │   MCPManager · ApprovalGate  │
                     │   ChannelManager · Models    │
                     └──────┬──────┬──────┬─────────┘
                            │      │      │
              ┌─────────────┘      │      └──────────────┐
              │                    │                      │
     ┌────────▼────────┐ ┌────────▼────────┐  ┌──────────▼──────────┐
     │   Extension      │ │    Desktop      │  │      Server         │
     │   chrome.runtime │ │    Tauri IPC    │  │      WebSocket      │
     │   IndexedDB      │ │    OS Keychain  │  │      SQLite         │
     │   SSE MCP        │ │    Rust MCP     │  │      Node MCP       │
     └─────────────────┘ └─────────────────┘  └─────────────────────┘
```

Platform-specific code is isolated via the `__BUILD_MODE__` compile-time constant (`'extension'` | `'desktop'` | `'server'`). Vite eliminates dead branches at build time, so each output contains only its platform's code.

---

## About AI Republic

[AI Republic](https://airepublic.com) is a Seattle-based artificial intelligence startup developing an AI agents marketplace designed specifically for small and medium-sized businesses (SMBs). Our mission is to democratize access to intelligent automation technologies, empowering organizations to enhance productivity and operational efficiency while maintaining full control over their proprietary data and workflows.

---

## Development Status and Usage Restrictions

**Current Status:** Alpha Testing

Pi is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use. The source code is publicly available for transparency and educational purposes, but this project is **not open source** at this time.

**Usage Restrictions:**
- Personal evaluation and learning: Allowed
- Internal organizational use: Allowed
- Creating derivative works for public distribution: Not permitted without written authorization
- Commercial use: Not permitted without written authorization

**Important Notice:** This software is provided "as is" without warranty of any kind. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.

---

## Licensing

This project's source code is **publicly viewable** but **proprietary**. All rights are reserved by AI Republic. The code is made available for transparency, security review, and educational purposes only.

For licensing inquiries, commercial use, or permission to create derivative works, please contact [ceo@airepublic.com](mailto:ceo@airepublic.com).

---

## Large Language Model Support

We support state-of-the-art LLMs from leading providers.

---

## Environment Configuration

Each platform requires its own environment configuration. The `.env.example` file in the project root serves as a template.

### Setup

```bash
# Chrome extension
cp .env.example src/extension/.env

# Desktop app
cp .env.example src/desktop/.env

# Server mode — uses env vars or config.json (no .env file needed)
```

### Configuration Files

| File | Purpose |
|------|---------|
| `.env.example` | Template with all required keys (committed to repo) |
| `src/extension/.env` | Extension-specific configuration (not committed) |
| `src/desktop/.env` | Desktop app-specific configuration (not committed) |
| `config.json` | Server mode configuration (optional, see Server section) |

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_HOME_PAGE_BASE_URL` | Base URL for AI Republic home page | `https://airepublic.com` |
| `VITE_BACKEND_API_BASE_URL` | Backend API endpoint | `https://api.airepublic.com` |
| `VITE_COOKIE_DOMAIN` | Cookie domain for auth | `.airepublic.com` |

**Note:** Build and dev commands will abort if the required `.env` file is missing for extension and desktop builds.

---

## Getting Started

### BrowserX (Chrome Extension)

#### Prerequisites
- Node.js (v18 or higher)
- npm package manager
- Google Chrome browser
- API key (OpenAI, xAI, or Groq)

#### Installation Steps

1. **Clone the repository:**
   ```bash
   git clone git@github.com:The-AI-Republic/pi.git
   cd pi
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example src/extension/.env
   # Edit src/extension/.env with your configuration values
   ```

4. **Build the extension:**
   ```bash
   npm run build
   ```

5. **Load in Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable **Developer Mode** (toggle in the top-right corner)
   - Click **Load unpacked**
   - Select the `dist/extension/` directory

6. **Configure API credentials:**
   - Open the extension side panel
   - Navigate to Settings
   - Enter your API key (supports OpenAI, xAI, or Groq)
   - Click **Test Connection** to verify

---

### Apple Pi (Desktop App)

#### Prerequisites (Ubuntu/Linux)
```bash
# Install system dependencies
sudo apt update

# Ubuntu 22.04+
sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

#### Prerequisites (macOS)
```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

#### Prerequisites (Windows)
- Visual Studio Build Tools (with C++ workload)
- WebView2 (pre-installed on Windows 10/11)
- Rust: https://rustup.rs

#### Development

```bash
# Install all dependencies (includes Tauri v2 packages)
npm install

# Install Tauri CLI v2
cargo install tauri-cli@^2

# Configure environment
cp .env.example src/desktop/.env
# Edit src/desktop/.env with your configuration values

# Run in development mode (hot-reload)
npm run tauri:dev
```

This will start the Vite frontend server and launch the Apple Pi desktop window with hot-reload enabled.

#### Environment Variables (Linux)

On Linux systems, WebKit may fail to initialize GPU compositing, resulting in errors like:
```
Could not create GBM EGL display: EGL_NOT_INITIALIZED. Aborting...
```

The `npm run tauri:dev` script automatically sets the required environment variable to work around this issue. If you need to run Tauri commands directly, use one of these methods:

**Method 1: Inline (per command)**
```bash
cd tauri && WEBKIT_DISABLE_COMPOSITING_MODE=1 cargo tauri dev
```

**Method 2: Export for current terminal session**
```bash
export WEBKIT_DISABLE_COMPOSITING_MODE=1
cd tauri && cargo tauri dev
```

**Method 3: Add to shell profile (permanent)**

For bash users, add to `~/.bashrc`:
```bash
echo 'export WEBKIT_DISABLE_COMPOSITING_MODE=1' >> ~/.bashrc
source ~/.bashrc
```

For zsh users, add to `~/.zshrc`:
```bash
echo 'export WEBKIT_DISABLE_COMPOSITING_MODE=1' >> ~/.zshrc
source ~/.zshrc
```

#### Common Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | Disables GPU compositing (fixes EGL errors on Linux) | Not set |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | Alternative fix for some GPU configurations | Not set |
| `TAURI_DEBUG=1` | Enable verbose Tauri debug logging | Not set |
| `RUST_BACKTRACE=1` | Show Rust stack traces on errors | Not set |
| `RUST_LOG=debug` | Set Rust logging level (error/warn/info/debug/trace) | error |

#### Troubleshooting Linux GPU Issues

If you still encounter GPU-related errors after setting `WEBKIT_DISABLE_COMPOSITING_MODE=1`:

1. **Try the DMA-BUF workaround:**
   ```bash
   cd tauri && WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 cargo tauri dev
   ```

2. **Update your GPU drivers:**
   ```bash
   # For NVIDIA
   sudo ubuntu-drivers autoinstall

   # For AMD/Intel
   sudo apt update && sudo apt upgrade
   ```

3. **Check if running in a VM or container:**
   Virtual machines often lack proper GPU passthrough. The software rendering workaround should work in most cases.

4. **Verify WebKit installation:**
   ```bash
   dpkg -l | grep webkit
   # Should show libwebkit2gtk-4.1-dev installed
   ```

#### Production Build

```bash
# Using npm script (from project root)
npm run tauri:build

# Or directly with cargo
cd tauri && cargo tauri build
```

**Output locations:**
- **Ubuntu:** `tauri/target/release/bundle/deb/pi_*.deb`
- **Linux (AppImage):** `tauri/target/release/bundle/appimage/pi_*.AppImage`
- **Windows:** `tauri/target/release/bundle/nsis/Pi_*-setup.exe`
- **macOS:** `tauri/target/release/bundle/dmg/Pi_*.dmg`

**Note:** The environment variables (like `WEBKIT_DISABLE_COMPOSITING_MODE`) are only needed during development. Production builds create standalone applications that users can run normally. End users experiencing GPU issues should launch the app with the environment variable:
```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./pi
```

---

### Pi Server (Headless Mode)

Pi Server runs the agent as a headless WebSocket/HTTP service — no browser or desktop UI required. It's designed for server deployments, Docker containers, and Kubernetes clusters.

#### Prerequisites
- Node.js 22+
- npm package manager
- Chrome/Chromium (optional, for browser automation)

#### Quick Start

```bash
# Install dependencies
npm install

# Build the server
npm run build:server

# Start the server (default port 18100)
npm run start:server
```

The server starts on port `18100` by default. Verify with:
```bash
curl http://localhost:18100/health
```

#### Development

```bash
# Dev mode with hot reload
npm run dev:server

# Type-check server code only
npm run type-check:server
```

#### Configuration

Server configuration is loaded from three sources (highest priority first):

1. **Environment variables** — override any setting
2. **Config file** (`~/.pi-server/config.json` or `PI_CONFIG_PATH`)
3. **Defaults** — sensible production defaults

##### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_SERVER_PORT` | Server port | `18100` |
| `PI_SERVER_BIND` | Bind mode: `loopback`, `lan`, `tailnet`, `auto` | `auto` |
| `PI_SERVER_AUTH_MODE` | Auth mode: `none`, `token`, `password`, `trusted-proxy` | `none` |
| `PI_SERVER_TOKEN` | Auth token (when mode is `token`) | — |
| `PI_SERVER_PASSWORD` | Auth password (when mode is `password`) | — |
| `PI_DATA_DIR` | Data directory for sessions, transcripts, SQLite DBs | `~/.pi-server/data` |
| `PI_CONFIG_PATH` | Path to config.json | `~/.pi-server/config.json` |
| `CHROME_BIN` | Path to Chrome/Chromium binary | Auto-detected |
| `CHROME_REMOTE_URL` | Remote browser URL (e.g., `http://browserless:3000`) | — |
| `CHROME_WS_ENDPOINT` | Remote browser WebSocket URL | — |

##### Config File Example

```json
{
  "server": {
    "port": 18100,
    "bind": "auto",
    "auth": {
      "mode": "token",
      "token": "your-secret-token"
    },
    "tls": {
      "enabled": false,
      "certFile": "/path/to/cert.pem",
      "keyFile": "/path/to/key.pem"
    },
    "limits": {
      "maxConcurrentRuns": 4,
      "maxConnections": 50,
      "maxPayloadBytes": 26214400,
      "maxSessions": 1000,
      "sessionRetentionDays": 30
    },
    "exec": {
      "approvalPolicy": "dangerous",
      "approvalTimeoutMs": 300000
    },
    "backup": {
      "schedule": "0 3 * * *",
      "retention": 7
    }
  }
}
```

The config file supports hot-reload — changes are picked up without restarting the server.

#### Docker

Build and run with Docker:

```bash
# Build with bundled Chrome (default, adds ~300MB)
docker build -t pi-server .

# Build slim image (no Chrome — use with remote browser)
docker build --build-arg INSTALL_CHROME=false -t pi-server-slim .
```

Run the container:

```bash
# Standalone with bundled Chrome
docker run -d \
  -p 18100:18100 \
  -v pi-data:/data \
  -e PI_SERVER_AUTH_MODE=token \
  -e PI_SERVER_TOKEN=your-secret \
  pi-server

# Slim image with remote browser
docker run -d \
  -p 18100:18100 \
  -v pi-data:/data \
  -e CHROME_REMOTE_URL=http://browserless:3000 \
  pi-server-slim
```

Or use Docker Compose:

```bash
docker compose up -d
```

#### Browser Automation in Server Mode

Pi Server supports three Chrome deployment patterns:

| Pattern | Env Var | Use Case |
|---------|---------|----------|
| **Bundled** | `CHROME_BIN` (auto-detected) | Single container, simplest setup |
| **Remote HTTP** | `CHROME_REMOTE_URL=http://host:port` | Browserless, Chrome sidecar, shared pool |
| **Remote WebSocket** | `CHROME_WS_ENDPOINT=ws://host:port` | Direct CDP WebSocket connection |

If no Chrome is available, the server gracefully degrades — planning and web search tools remain functional, only browser automation is disabled.

#### WebSocket Protocol

Clients connect via WebSocket and communicate using JSON frames:

```
ws://localhost:18100
```

**Connection flow:**
1. Client connects via WebSocket
2. Server sends HMAC-SHA256 challenge (if auth enabled)
3. Client responds with signed challenge
4. Bidirectional JSON messaging begins

**Available methods:** `chat.send`, `session.list`, `session.get`, `session.delete`, `tools.list`, `config.get`, `config.set`, `health.get`, `exec.approve`, `logs.subscribe`

#### Server Architecture

```
src/server/
├── index.ts                 # HTTP/WS server entry point
├── agent/                   # Agent lifecycle (bootstrap, shutdown)
├── auth/                    # Authorization & roles
├── channels/                # ServerChannel (WebSocket adapter)
├── config/                  # Zod-validated config with hot-reload
├── connection/              # Handshake, watchdog, rate limiting
├── exec/                    # Tool approval queue
├── handlers/                # Method handlers (chat, sessions, tools, ...)
├── health/                  # CPU/memory/event-loop monitoring
├── limits/                  # Connection & payload enforcement
├── mcp/                     # NodeMCPBridge (stdio MCP transport)
├── persistence/             # SessionIndex, TranscriptStore (SQLite)
├── plugins/                 # Plugin discovery & registration
├── protocol/                # Frame schemas, method dispatch, errors
├── storage/                 # FileConfigStorageProvider
├── streaming/               # Chat streaming, agent event conversion
└── tools/                   # Server tool registration
```

---

## NPM Scripts Reference

### Extension
| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server for extension |
| `npm run build` | Build extension for production |
| `npm run build:watch` | Build extension in watch mode |

### Desktop
| Command | Description |
|---------|-------------|
| `npm run dev:desktop` | Start Vite dev server for desktop |
| `npm run tauri:dev` | Full Tauri dev mode (Rust + TS, hot-reload) |
| `npm run tauri:build` | Production build (includes sidecar) |
| `npm run build:desktop` | Build desktop frontend only |

### Server
| Command | Description |
|---------|-------------|
| `npm run dev:server` | Dev mode with ts-node ESM loader |
| `npm run build:server` | Build server bundle via Vite |
| `npm run start:server` | Run built server (`dist/server/index.mjs`) |
| `npm run type-check:server` | Type-check server code only |

### Shared
| Command | Description |
|---------|-------------|
| `npm test` | Run all tests (Rust + Vitest) |
| `npm run type-check` | Type-check entire project |
| `npm run lint` | Run ESLint on src/ |
| `npm run format` | Format code with Prettier |

---

## Internationalization (i18n)

Pi supports 50+ languages via Chrome's `_locales` system. All user-facing strings are wrapped in translation functions and auto-translated using a Fireworks AI-powered pipeline.

### How It Works

1. **Wrap strings** in source code using `t()` or `$_t()`
2. **Extract keys** from source into locale files
3. **Auto-translate** missing translations via LLM

### Translation Functions

| Function | Usage | Context |
|----------|-------|---------|
| `t("text")` | Non-reactive translation | Script sections, TS files |
| `$_t("text")` | Reactive Svelte store | Svelte template sections |

**With substitutions:**
```typescript
// Script
t('Hello $1$', { substitutions: [userName] })

// Template
{$_t('$1$ items remaining', { substitutions: [count.toString()] })}
```

**Import:**
```typescript
// Svelte components
import { t, _t } from '../lib/i18n';

// TypeScript files (using path alias)
import { t } from '@/extension/sidepanel/lib/i18n';
```

### Adding New Translatable Strings

1. Wrap the string with `t()` (script) or `$_t()` (template)
2. Run extraction to generate keys:
   ```bash
   npm run extract-i18n
   ```
3. Run translation to fill in all locales:
   ```bash
   # Via CLI argument
   npm run translate -- --api-key=YOUR_FIREWORKS_API_KEY

   # Or via environment variable
   FIREWORKS_API_KEY=YOUR_FIREWORKS_API_KEY npm run translate
   ```

### i18n Scripts

| Command | Description |
|---------|-------------|
| `npm run extract-i18n` | Scan source for `t()`/`$_t()` calls, update `key_map.json` and all locale `messages.json` files |
| `npm run translate -- --api-key=KEY` | Auto-translate missing entries across all 50+ locales using Fireworks AI |
| `npm run translate-validate` | Validate existing translations for consistency |

### File Structure

```
src/
  extension/
    _locales/
      supported_languages.json   # List of 50+ supported locales
      key_map.json               # Text-to-key mappings (auto-generated)
      en/messages.json           # English (source of truth)
      zh_CN/messages.json        # Simplified Chinese
      ja_JP/messages.json        # Japanese
      ...                        # 47+ more locales
    sidepanel/lib/i18n/
      index.ts                   # i18n module (t, _t exports)
scripts/
  extract-i18n.js               # Key extraction script
  translate-i18n.js              # Auto-translation script
```

---

## Tool Testing Framework

For developers working on browser tool integrations, we provide a standalone testing extension.

### Building and Using the Test Harness

1. **Build the testing extension:**
   ```bash
   npm run build:testtool
   ```

2. **Load the test extension:**
   - Navigate to `chrome://extensions/`
   - Enable **Developer Mode**
   - Click **Load unpacked**
   - Select the `tests/tools/e2e` directory

3. **Execute tool tests:**
   - Use the testing interface to simulate function calls
   - Validate tool behavior without full LLM integration

---

## Project Structure

```
src/
├── core/                    # Shared agent runtime (all platforms)
│   ├── PiAgent.ts           # Main agent class
│   ├── Session.ts           # Conversation session
│   ├── TurnManager.ts       # Multi-turn reasoning
│   ├── approval/            # Approval gate & policy engine
│   ├── channels/            # Channel abstraction
│   ├── mcp/                 # MCP manager, adapters, config
│   ├── models/              # Model client factory & implementations
│   ├── storage/             # Storage interfaces
│   └── tools/               # Tool registry & runner
│
├── extension/               # Chrome extension
│   ├── background/          # Service worker
│   ├── content/             # Content scripts
│   ├── storage/             # ChromeConfigStorage, ChromeCredentialStore
│   └── _locales/            # Internationalization
│
├── desktop/                 # Desktop app (Tauri)
│   ├── agent/               # DesktopAgentBootstrap
│   ├── storage/             # TauriConfigStorage, KeytarCredentialStore
│   └── tools/               # Desktop-specific tools
│
├── server/                  # Headless server
│   ├── agent/               # ServerAgentBootstrap
│   ├── channels/            # ServerChannel (WebSocket)
│   ├── config/              # Zod-validated server config
│   ├── connection/          # Handshake, watchdog, rate limiting
│   ├── handlers/            # Method handlers
│   ├── health/              # Health monitoring
│   ├── mcp/                 # NodeMCPBridge
│   ├── persistence/         # SQLite session/transcript storage
│   ├── plugins/             # Plugin system
│   ├── protocol/            # Frame schemas, method dispatch
│   ├── storage/             # FileConfigStorageProvider
│   └── tools/               # Server tool registration
│
├── storage/                 # Shared storage (rollout recording)
├── tools/                   # Shared tool implementations
├── prompts/                 # LLM system prompts
├── webfront/                # Web UI (Svelte components)
├── config/                  # AgentConfig, constants
├── types/                   # Global type declarations
└── utils/                   # Utilities

tauri/                       # Tauri Rust backend
scripts/                     # Build & i18n scripts
tests/                       # E2E tests
```

---

## Contributing and Collaboration

We welcome collaboration from the developer community and business partners.

### Areas of Interest
- **Investment opportunities:** Strategic partnerships and funding discussions
- **Enterprise adoption:** Integrating BrowserX/Apple Pi into organizational workflows
- **Collaboration:** Bug reports, feature suggestions, and feedback

### How You Can Help
- Report challenging websites or scenarios where the agent struggles
- Contribute improved tool implementations
- Submit test cases for complex web applications
- Propose and implement new interaction strategies

### Contact Information

**Richard Miao**
- Email: [ceo@airepublic.com](mailto:ceo@airepublic.com)
- LinkedIn: [linkedin.com/in/rcmiao](https://www.linkedin.com/in/rcmiao/)

---

## License

This project is proprietary software. All rights reserved by AI Republic. See the [LICENSE](LICENSE) file for details.

---

## Disclaimer

This software is provided "as is" during the alpha testing phase. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.
