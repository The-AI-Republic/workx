# Browserx for Chrome

**An In-Browser AI Agent for Web Automation**

Browserx for Chrome is a privacy-preserving, general-purpose AI agent implemented as a Chrome extension. The agent operates entirely within the user's local browser environment, interpreting natural language commands and autonomously interacting with web pages to fulfill user requests. All large language model inference occurs client-side, ensuring that sensitive data never leaves the user's machine and eliminating the need for backend infrastructure.

![Browserx UI Screenshot](/src/static/browserx_UI.png)

---

## About AI Republic

[AI Republic](https://airepublic.com) is a Seattle-based artificial intelligence startup developing an AI agents marketplace designed specifically for small and medium-sized businesses (SMBs). Our mission is to democratize access to intelligent automation technologies, empowering organizations to enhance productivity and operational efficiency while maintaining full control over their proprietary data and workflows.

---

## Project Origin and Acknowledgments

This project is derived from OpenAI's open-source Browserx reference implementation, available at [github.com/openai/browserx](https://github.com/openai/browserx). We express our profound gratitude to the OpenAI team ([@openai](https://github.com/openai)) for releasing browserx under an open-source license, which has enabled our development of this privacy-focused, browser-native AI agent implementations.

---

## Development Status and Usage Restrictions

**Current Status:** Alpha Testing

Browserx for Chrome is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use. The source code remains publicly available for transparency and community review.

**Usage Restrictions:**

- ✅ **Permitted:** Internal enterprise deployment and usage within your organization
- ✅ **Permitted:** Personal evaluation and testing
- ❌ **Restricted:** Any form of public redistribution, including but not limited to:
  - Publishing this extension or derivatives to the Chrome Web Store or other browser extension marketplaces
  - Incorporating any portion of the code (including individual tools like DOM utilities) into publicly distributed applications
  - Rewriting or forking the project for public distribution

**Prior written permission from AI Republic is required for any public redistribution or commercial use.**

**Important Notice:** This software is provided "as is" without warranty of any kind. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.

---

## Licensing

**Proprietary License with Source Availability**

This project is **licensed under its own public license agreement**. While the source code remains publicly available for transparency and review, all rights are reserved by AI Republic.

**License Terms:**

- **Source Code Visibility:** The code is publicly accessible for educational purposes, security auditing, and internal enterprise evaluation
- **Permitted Use:** Internal enterprise deployment and personal evaluation only
- **Restricted Activities:** Any public redistribution, commercial use, or derivative works require prior written permission from AI Republic
- **No Warranty:** The software is provided "as is" without any warranties or guarantees

For licensing inquiries or permission requests, please contact [ceo@airepublic.com](mailto:ceo@airepublic.com).

**Trademark Considerations:**

The project name **BrowserX** (or **browserx**) is a trademark used by AI Republic. This naming convention better reflects the project's browser-centric architecture and cross-platform agent capabilities while avoiding potential trademark conflicts. The name emphasizes the extension's role as a powerful, extensible ("X") browser automation framework.

---

## Large Language Model Support

BrowserX supports multiple LLM providers and models with varying capabilities. Below are the currently supported providers:

### OpenAI
- **GPT-5.1** - Latest flagship model with advanced reasoning capabilities
- **GPT-5** - Powerful reasoning model with extended context window
- Context: 200K tokens | Output: 16K tokens | Supports: Reasoning, Images, Verbosity Control

### xAI
- **Grok 4 Fast Reasoning** - High-performance reasoning model
- Context: 131K tokens | Output: 16K tokens | Supports: Reasoning (5 effort levels), Images

### Google AI Studio
- **Gemini 3 Pro Preview** - Next-generation preview model with massive context
- **Gemini 2.5 Pro** - Production-ready model with extensive capabilities
- Context: 1M tokens | Output: 8K tokens | Supports: Reasoning, Images

### Moonshot AI
- **Kimi K2 Thinking** - Advanced reasoning model with cache optimization
- **Kimi K2 Thinking Turbo** - Fast variant for quicker responses
- Context: 262K tokens | Output: 16K tokens | Supports: Reasoning (3 effort levels)

### Fireworks AI
- **Kimi K2 Thinking** - Hosted version of Moonshot's reasoning model
- Context: 262K tokens | Output: 16K tokens | Supports: Reasoning (3 effort levels)

**Additional Providers:** Groq integration available (models can be configured)

All models support function calling for browser tool integration. Reasoning-capable models provide enhanced decision-making for complex web automation tasks.

---

## Web Page Tool Improvement

**Challenge: Complex Web Applications**

Modern web applications, particularly Single-Page Applications (SPAs), present significant challenges for AI agent automation. These applications feature dynamically generated DOM structures, shadow DOM elements, framework-specific rendering patterns (React, Vue, Angular), and complex state management systems that make reliable element identification and interaction difficult for language models.

**Our Ongoing Efforts:**

We are continuously enhancing our browser tool suite to handle increasingly sophisticated web interactions, including:

- **Improved element selection strategies** for dynamic and framework-rendered content
- **Enhanced DOM traversal algorithms** to handle shadow DOM and nested iframe contexts
- **Robust state detection mechanisms** for asynchronous UI updates and lazy-loaded content
- **Intelligent retry and fallback logic** for handling transient DOM states
- **Advanced selector generation** using accessibility attributes, data attributes, and semantic markup

**Community Contribution Opportunity:**

This area of the project **requires substantial open-source community support**. The diversity and complexity of modern web applications make it impossible for a single team to address all edge cases and framework-specific patterns. We welcome contributions from developers who have:

- Experience with specific JavaScript frameworks and their DOM manipulation patterns
- Expertise in web accessibility and ARIA attribute usage for reliable element targeting
- Knowledge of browser automation testing tools and best practices
- Interest in AI agent reliability and robustness improvements

**How You Can Help:**

- Report challenging websites or SPAs where the agent struggles
- Contribute improved tool implementations for specific use cases
- Submit test cases and fixtures for complex web application scenarios
- Propose and implement new DOM interaction strategies

Together, we can build a more capable and reliable browser automation agent that handles the full spectrum of modern web applications.

---

## Getting Started: Local Installation

Follow these steps to build and run Browserx for Chrome in your local development environment:

### Prerequisites
- Node.js (v16 or higher recommended)
- npm package manager
- Google Chrome browser
- OpenAI API key ([obtain here](https://platform.openai.com/api-keys))

### Installation Steps

1. **Clone the repository:**
   ```bash
   git clone git@github.com:The-AI-Republic/browserx.git
   ```

2. **Navigate to the project directory:**
   ```bash
   cd browserx
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Build the extension:**
   ```bash
   npm run build
   ```
   This generates the production-ready extension in the `dist/` directory.

5. **Load the extension in Chrome:**
   - Navigate to `chrome://extensions/` in your browser
   - Enable **Developer Mode** (toggle in the top-right corner)
   - Click **Load unpacked**
   - Select the `dist/` directory from your project

6. **Configure API credentials:**
   - Open the extension side panel
   - Navigate to the Settings page
   - Enter your OpenAI API key
   - Click **Test Connection** to verify API connectivity

7. **Verify installation:**
   - Once the connection test succeeds, the agent is ready for use
   - Begin issuing natural language commands through the side panel interface

**You're all set!** The agent can now interact with web pages on your behalf.

---

## Tool Testing Framework

For developers working on browser tool integrations, we provide a standalone testing extension that simulates LLM function calling to individual browser tools.

### Building and Using the Test Harness

1. **Build the testing extension:**
   ```bash
   npm run build:testtool
   ```

2. **Load the test extension:**
   - Navigate to `chrome://extensions/`
   - Ensure **Developer Mode** is enabled
   - Click **Load unpacked**
   - Select the `tests/tools/e2e` directory

3. **Execute tool tests:**
   - Use the testing extension interface to simulate function calls to specific browser tools
   - Validate tool behavior, response formats, and error handling
   - This allows isolated testing without requiring full LLM integration

---

## Contributing and Collaboration

We welcome collaboration from the developer community and business partners interested in advancing privacy-preserving AI agent technologies.

### Areas of Interest
- **Investment opportunities:** Strategic partnerships and funding discussions
- **Enterprise adoption:** Integrating Browserx for Chrome into organizational workflows
- **Open-source contributions:** Code improvements, bug fixes, documentation enhancements, and feature development

### Contact Information

For all collaboration inquiries, please contact:

**Richard Miao**
Email: [mrc@airepublic.com](mailto:mrc@airepublic.com)
LinkedIn: [linkedin.com/in/rcmiao](https://www.linkedin.com/in/rcmiao/)

We look forward to building the future of in-browser AI agents together.

---

## License

All rights reserved. Copyright © 2025 AI Republic. This source code is publicly available for review and internal enterprise use only. Any public redistribution or commercial use requires prior written permission from AI Republic.

---

## Disclaimer

This software is provided "as is" during the alpha testing phase. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.
