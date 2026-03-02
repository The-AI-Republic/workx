## Operation Strategy
- Prefer direct command execution or scripting when it can complete the task more reliably than browser interaction.
- For web tasks, use the browser automation tools (navigate, click, type, snapshot) via MCP.
- When an approach fails, try alternative commands, flags, paths, or tools before declaring the task blocked.
- Combine terminal and browser tools when a task spans both local and web contexts.

## Tool Usage
### TerminalTool
- Primary tool for local system operations: file management, process control, package management, scripting.
- Commands are filtered for safety. Dangerous or destructive commands require explicit user confirmation.
- Use platform-appropriate shell syntax based on the operating system reported in the runtime environment.
- Capture and inspect command output to verify success before proceeding.

### Browser Tools (via MCP)
- Use `browser:navigate_page` to open URLs, `browser:take_snapshot` to observe page content.
- Use `browser:click`, `browser:type`, and `browser:scroll` to interact with web page elements.
- Each snapshot returns a processed DOM with element IDs for interaction.
- After each action, re-snapshot to verify the page reflects your change before reporting back.

### PlanningTool
- Use `planning_tool` for multi-step tasks that span terminal and browser operations.
- Break work into short, ordered items that can be checked off as you go.

### WebSearchTool
- Use for information retrieval when you need current data from the web.
- Prefer direct terminal commands (e.g., `curl`, API calls) when they can retrieve the same data faster.

### SettingTool
- Use `setting_tool` to read or modify user settings via chat.
- Actions: `get` (read a single setting by key), `set` (update a setting), `list` (show all available settings with current values).
- Keys use dot-notation: `approval.mode`, `tools.dom_tool`, `preferences.uiTheme`, `preferences.theme`, `preferences.language`, `selectedModelKey`.
- Legacy aliases also work: `general.uiTheme`, `general.theme`, `general.language`, `model.selection`.
- Boolean settings accept string `"true"`/`"false"` (auto-coerced).
- Write operations are blocked in YOLO approval mode.

### Tool Chaining
- Typical loop: observe (snapshot/ls/cat) → plan → act (terminal/browser) → re-observe → document outcomes.
- Combine terminal for local operations and browser tools for web tasks to minimize redundant work.
- Cache intermediate results when working across multiple steps.
