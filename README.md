# BrowserX

**AI-Powered Personal Assistant — Chrome Extension, Desktop App & Headless Server**

BrowserX is a privacy-preserving, general-purpose AI personal assistant available as a **Chrome extension (BrowserX)**, a **desktop application (Apple Pi)**, and a **headless server (Apple Pi Server)**. The agent interprets natural language commands and autonomously performs tasks across web browsing, planning, and more.

### Naming Convention

| Product | Platform | Identifier |
|---------|----------|------------|
| **BrowserX** | Chrome Extension | `browserx` |
| **Apple Pi** | Desktop (Win/Mac/Linux) | `applepi` |
| **Apple Pi Server** | Headless (Docker/K8s) | `applepi-server` |

- **Core agent class**: `RepublicAgent` (developed by AI Republic)
- **Internal npm scope**: `@applepi`
- **Extension-layer identifiers**: `browserx` (events, credentials, tab groups)
- **Shared/core identifiers**: `applepi` (DB names, config keys, event prefixes)

All three platforms share a common core (`src/core/`) — see [Architecture](docs/ARCHITECTURE.md) for details.

![UI Screenshot](/src/static/applepi_UI.png)

---

## About AI Republic

[AI Republic](https://airepublic.com) is a Seattle-based artificial intelligence startup developing an AI agents marketplace designed specifically for small and medium-sized businesses (SMBs). Our mission is to democratize access to intelligent automation technologies, empowering organizations to enhance productivity and operational efficiency while maintaining full control over their proprietary data and workflows.

---

## Development Status and Usage Restrictions

**Current Status:** Alpha Testing

BrowserX is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use.

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

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_AUTH_BASE_URL` | Optional hosted login/account base URL | `https://auth.example.com` |
| `VITE_BACKEND_API_BASE_URL` | Optional backend API endpoint | `https://api.example.com` |
| `VITE_AUTH_COOKIE_DOMAIN` | Optional cookie domain for hosted auth | `.example.com` |
| `VITE_AUTH_ACCESS_COOKIE_NAME` | Hosted auth access-token cookie name | `access_token` |
| `VITE_AUTH_REFRESH_COOKIE_NAME` | Hosted auth refresh-token cookie name | `refresh_token` |
| `VITE_AUTH_LOGIN_PATH` | Optional hosted login path | `/signin` |
| `VITE_AUTH_PROFILE_PATH` | Optional hosted profile API path | `/profile` |
| `VITE_AUTH_DESKTOP_SESSION_PATH` | Optional desktop session API path | `/desktop/session` |
| `VITE_AUTH_DESKTOP_REFRESH_PATH` | Optional desktop token refresh API path | `/desktop/refresh` |
| `VITE_AUTH_USER_CENTER_PATH` | Optional hosted account path | `/account` |
| `VITE_AUTH_PRICING_PATH` | Optional hosted plan upgrade path | `/plans` |

---

### BrowserX (Chrome Extension)

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

### Apple Pi (Desktop App)

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

For local hosted-login testing:

```bash
VITE_AUTH_BASE_URL=https://auth.example.local ./build.sh --install
```

You can also set `VITE_AUTH_BASE_URL=https://auth.example.local` in
`src/desktop/.env`. The desktop web UI and runtime sidecar read the hosted auth
URL during the build, so changing it requires rebuilding the desktop package.

---

### Apple Pi Server (Headless Mode)

Apple Pi Server runs the agent as a headless WebSocket/HTTP service for server deployments, Docker containers, and Kubernetes.

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
| `APPLEPI_SERVER_PORT` | Server port | `18100` |
| `APPLEPI_SERVER_BIND` | Bind mode (`loopback`, `lan`, `tailnet`, `auto`) | `auto` |
| `APPLEPI_SERVER_AUTH_MODE` | Auth (`none`, `token`, `password`, `trusted-proxy`) | `none` |
| `APPLEPI_SERVER_TOKEN` | Auth token | — |
| `APPLEPI_DATA_DIR` | Data directory | `~/.applepi-server/data` |
| `APPLEPI_CONFIG_PATH` | Config file path | `~/.applepi-server/config.json` |
| `CHROME_BIN` | Chrome binary path | Auto-detected |
| `CHROME_REMOTE_URL` | Remote browser URL | — |

See `src/server/config/server-config.ts` for the full Zod-validated config schema.

#### Docker

```bash
# With bundled Chrome (default)
docker build -t applepi-server .

# Slim image (remote browser only)
docker build --build-arg INSTALL_CHROME=false -t applepi-server-slim .

# Run
docker run -d -p 18100:18100 -v applepi-data:/data \
  -e APPLEPI_SERVER_AUTH_MODE=token -e APPLEPI_SERVER_TOKEN=secret applepi-server

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

BrowserX supports 50+ languages via Chrome's `_locales` system, auto-translated using Fireworks AI.

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
