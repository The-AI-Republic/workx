# BrowserX

**AI-Powered Personal Assistant - Chrome Extension & Desktop App**

BrowserX is a privacy-preserving, general-purpose AI personal assistant available as both a **Chrome extension (BrowserX)** and a **desktop application (Pi)**. The agent operates entirely within the user's local environment, interpreting natural language commands and autonomously performing tasks across web browsing, file management, and more. All interactions occur client-side, ensuring that sensitive data never leaves your machine.

![BrowserX UI Screenshot](/src/static/browserx_UI.png)

---

## Dual-Mode Architecture

| App | Platform | Description | Best For |
|-----|----------|-------------|----------|
| **BrowserX** | Chrome Extension | Browser-based agent with web automation | Quick web tasks, browsing assistance |
| **Pi** | Desktop (Win/Mac/Linux) | Native application with full system access | Terminal commands, file operations, advanced automation |

---

## About AI Republic

[AI Republic](https://airepublic.com) is a Seattle-based artificial intelligence startup developing an AI agents marketplace designed specifically for small and medium-sized businesses (SMBs). Our mission is to democratize access to intelligent automation technologies, empowering organizations to enhance productivity and operational efficiency while maintaining full control over their proprietary data and workflows.

---

## Development Status and Usage Restrictions

**Current Status:** Alpha Testing

BrowserX is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use. The source code is publicly available for transparency and educational purposes, but this project is **not open source** at this time.

**Usage Restrictions:**
- Personal evaluation and learning: ✅ Allowed
- Internal organizational use: ✅ Allowed
- Creating derivative works for public distribution: ❌ Not permitted without written authorization
- Commercial use: ❌ Not permitted without written authorization

**Important Notice:** This software is provided "as is" without warranty of any kind. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.

---

## Licensing

This project's source code is **publicly viewable** but **proprietary**. All rights are reserved by AI Republic. The code is made available for transparency, security review, and educational purposes only.

For licensing inquiries, commercial use, or permission to create derivative works, please contact [ceo@airepublic.com](mailto:ceo@airepublic.com).

---

## Large Language Model Support

We support state-of-the-art LLMs from leading providers.

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
   git clone git@github.com:The-AI-Republic/browserx.git
   cd browserx
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load in Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable **Developer Mode** (toggle in the top-right corner)
   - Click **Load unpacked**
   - Select the `dist/extension/` directory

5. **Configure API credentials:**
   - Open the extension side panel
   - Navigate to Settings
   - Enter your API key (supports OpenAI, xAI, or Groq)
   - Click **Test Connection** to verify

---

### Pi (Desktop App)

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

# Run in development mode (hot-reload)
npm run tauri:dev
```

This will start the Vite frontend server and launch the Pi desktop window with hot-reload enabled.

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
# The variable persists for all commands in this terminal session
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

**Method 4: Create a .env file (project-specific)**

Create a file at the project root named `.env.local`:
```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1
```

Then source it before running:
```bash
source .env.local && cd tauri && cargo tauri dev
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

## Contributing and Collaboration

We welcome collaboration from the developer community and business partners.

### Areas of Interest
- **Investment opportunities:** Strategic partnerships and funding discussions
- **Enterprise adoption:** Integrating BrowserX/Pi into organizational workflows
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
