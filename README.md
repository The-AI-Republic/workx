# WorkX

**AI-Powered Personal Assistant — Chrome Extension, Desktop App & Headless Server**

WorkX is a privacy-preserving, general-purpose AI personal assistant available as a **Chrome extension (WorkX)**, a **desktop application (WorkX)**, and a **headless server (WorkX Server)**. The agent interprets natural language commands and autonomously performs tasks across web browsing, planning, and more.

### Naming Convention

| Product | Platform | Identifier |
|---------|----------|------------|
| **WorkX** | Chrome Extension | `workx` |
| **WorkX** | Desktop (Win/Mac/Linux) | `workx` |
| **WorkX Server** | Headless (Docker/K8s) | `workx-server` |

- **Core agent class**: `RepublicAgent` (developed by AI Republic)
- **Internal npm scope**: `@workx`
- **Extension-layer identifiers**: `workx` (events, credentials, tab groups)
- **Shared/core identifiers**: `workx` (DB names, config keys, event prefixes)

All three platforms share a common core (`src/core/`) — see [Architecture](docs/ARCHITECTURE.md) for details.

![UI Screenshot](/src/static/workx_UI.png)

---

## About AI Republic

[AI Republic](https://airepublic.com) is a Seattle-based artificial intelligence startup developing an AI agents marketplace designed specifically for small and medium-sized businesses (SMBs). Our mission is to democratize access to intelligent automation technologies, empowering organizations to enhance productivity and operational efficiency while maintaining full control over their proprietary data and workflows.

---

## Development Status and Usage Restrictions

**Current Status:** Alpha Testing

WorkX is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use.

**Usage Restrictions:**
- Personal evaluation and learning: Allowed
- Internal organizational use: Allowed
- Creating derivative works for public distribution: Not permitted without written authorization
- Commercial use: Not permitted without written authorization

**Important Notice:** This software is provided "as is" without warranty of any kind. Use at your own risk.

---

## Getting Started

### Prerequisites

- Node.js (v18+ for extension/desktop, v22+ for server)
- npm package manager

### Environment Setup

```bash
# Chrome extension
cp .env.example src/extension/.env

# Desktop app
cp .env.example src/desktop/.env

# Server mode — uses env vars or config.json (no .env file needed)
```

OSS WorkX uses model-provider API keys stored locally. OpenAI users may also
connect a ChatGPT subscription through provider OAuth. Product account login,
memberships, and credit-backed routing are distribution-specific and are not
part of this repository.

---

### WorkX (Chrome Extension)

```bash
npm install
npm run build
```

Then load in Chrome:
1. Navigate to `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** and select the `dist/extension/` directory
4. Open the side panel, go to Settings, and enter your API key

---

### WorkX (Desktop App)

#### System Dependencies

**Ubuntu/Linux:**
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget \
    libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**macOS:**
```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Windows:** Visual Studio Build Tools (C++ workload) + [Rust](https://rustup.rs)

#### Development

```bash
npm install
cargo install tauri-cli@^2
cp .env.example src/desktop/.env
npm run tauri:dev
```

#### Linux GPU Issues

If you see `EGL_NOT_INITIALIZED` errors:
```bash
export WEBKIT_DISABLE_COMPOSITING_MODE=1
```

The `npm run tauri:dev` script sets this automatically. See also `WEBKIT_DISABLE_DMABUF_RENDERER=1` for alternative GPU configurations.

#### Production Build

```bash
npm run tauri:build
```

Output: `tauri/target/release/bundle/{deb,appimage,nsis,dmg}/`

#### Local Desktop Package Testing

For a normal desktop package:

```bash
./build.sh --install
```

### WorkX Server (Headless Mode)

WorkX Server runs the agent as a headless WebSocket/HTTP service for server deployments, Docker containers, and Kubernetes.

```bash
npm install
npm run build:server
npm run start:server        # default port 18100
curl http://localhost:18100/health
```

#### Configuration

Configuration priority: **env vars** > **config.json** > **defaults**

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKX_SERVER_PORT` | Server port | `18100` |
| `WORKX_SERVER_BIND` | Bind mode (`loopback`, `lan`, `tailnet`, `auto`) | `auto` |
| `WORKX_SERVER_AUTH_MODE` | Auth (`none`, `token`, `password`, `trusted-proxy`) | `none` |
| `WORKX_SERVER_TOKEN` | Auth token | — |
| `WORKX_DATA_DIR` | Data directory | `~/.workx-server/data` |
| `WORKX_CONFIG_PATH` | Config file path | `~/.workx-server/config.json` |
| `CHROME_BIN` | Chrome binary path | Auto-detected |
| `CHROME_REMOTE_URL` | Remote browser URL | — |

See `src/server/config/server-config.ts` for the full Zod-validated config schema.

#### Docker

```bash
# With bundled Chrome (default)
docker build -t workx-server .

# Slim image (remote browser only)
docker build --build-arg INSTALL_CHROME=false -t workx-server-slim .

# Run
docker run -d -p 18100:18100 -v workx-data:/data \
  -e WORKX_SERVER_AUTH_MODE=token -e WORKX_SERVER_TOKEN=secret workx-server

# Or use Docker Compose
docker compose up -d
```

#### Browser Automation

| Pattern | Env Var | Use Case |
|---------|---------|----------|
| **Bundled** | `CHROME_BIN` (auto) | Single container |
| **Remote HTTP** | `CHROME_REMOTE_URL` | Browserless, sidecar, shared pool |
| **Remote WebSocket** | `CHROME_WS_ENDPOINT` | Direct CDP connection |

If no Chrome is available, the server degrades gracefully — planning and web search still work.

---

## NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Extension dev server |
| `npm run build` | Build extension |
| `npm run tauri:dev` | Desktop dev (Rust + TS) |
| `npm run tauri:build` | Desktop production build |
| `npm run dev:server` | Server dev mode |
| `npm run build:server` | Build server bundle |
| `npm run start:server` | Run built server |
| `npm test` | Run all tests |
| `npm run type-check` | Type-check entire project |
| `npm run lint` | ESLint |

---

## Internationalization (i18n)

WorkX supports 50+ languages via Chrome's `_locales` system, auto-translated using Fireworks AI.

| Function | Usage | Context |
|----------|-------|---------|
| `t("text")` | Non-reactive translation | Script sections, TS files |
| `$_t("text")` | Reactive Svelte store | Svelte templates |

```bash
npm run extract-i18n                              # Extract keys
npm run translate -- --api-key=YOUR_FIREWORKS_KEY  # Auto-translate
```

---

## Contributing and Collaboration

We welcome collaboration from the developer community and business partners.

- Report challenging websites or scenarios where the agent struggles
- Contribute improved tool implementations
- Submit test cases for complex web applications
- Propose and implement new interaction strategies

**Richard Miao** — [ceo@airepublic.com](mailto:ceo@airepublic.com) | [LinkedIn](https://www.linkedin.com/in/rcmiao/)

---

## License

This project is proprietary software. All rights reserved by AI Republic. See [LICENSE](LICENSE) for details.

---

## Disclaimer

This software is provided "as is" during the alpha testing phase. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.
