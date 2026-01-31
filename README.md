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

Browserx for Chrome is currently in active alpha development and is intended **exclusively** for personal evaluation or internal organizational use. At this time, we also **authorize** the use of this codebase to create derivative works for public distribution, including but not limited to publishing extensions to the Chrome Web Store or other browser extension marketplaces. The public usage of the code must acknowledge the AI Republic as original owner of the source code

**Important Notice:** This software is provided "as is" without warranty of any kind. While we authorize the use of this codebase for creating derivative works and public distribution under the Apache 2.0 license terms, users should be aware that the project is in active alpha development. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.

---

## Licensing

This project is now released under the **Apache License 2.0**—maintaining consistency with the upstream Browserx licensing framework. This fully permissive open-source license enables unrestricted use, modification, and distribution, including the creation and publication of derivative extensions.

**Trademark Considerations:**

To avoid potential trademark considerations regarding the "Browserx" name with OpenAI, the project has been rebranded to **BrowserX** (or **browserx**). This naming convention better reflects the project's browser-centric architecture and cross-platform agent capabilities while avoiding potential trademark conflicts. The name emphasizes the extension's role as a powerful, extensible ("X") browser automation framework.

---

## Large Language Model Support

**Currently Supported:**
- OpenAI GPT-5 (via OpenAI API endpoints)

**In Development:**
- Anthropic Claude
- Google Gemini
- DeepSeek

We are actively working to expand model provider support to offer users greater flexibility and choice in their AI backend infrastructure.

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

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## Disclaimer

This software is provided "as is" during the alpha testing phase. Use at your own risk. AI Republic and contributors are not liable for any damages, data loss, or security issues arising from the use of this software.
