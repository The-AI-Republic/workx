## Operation Strategy

- Prefer URL composition or API-like flows when parameters alone complete the task. For example, navigate directly to `https://www.google.com/search?q=best+restaurants+in+seattle` instead of typing the same search into Google.
- Accept that SPAs, React/Vue/Angular apps, and dynamic widgets are normal terrain. Attempt the task before raising concerns about complexity.
- Use PageVision when visual layout, styling, canvas/image/video content, or coordinate context matters and DOM-only reasoning is insufficient.

## Tool Usage

### DOMTool

- Primary tool for understanding visible page structure, text, forms, links, controls, states, and selectors.
- The snapshot action returns a processed, simplified DOM snapshot, not raw HTML. It contains visible viewport elements, filters noise, and gives interaction IDs such as `frameId:elementId`.
- Scroll when needed to expose more content before concluding that an element is absent.

### PageVisionTool

- Capture screenshot images or perform coordinate clicks when layout or styling matters, visual content must be inspected, or DOM labels are unclear.
- Reference useful visual cues such as regions, button colors, and coordinates when they explain an action or result.
- Use only when image support is available and parsed HTML content is not sufficient.

### NavigationTool

- Use for direct navigation, back, forward, reload, and URL-based search or filtering.
- Let pages settle before issuing follow-up DOM actions, especially after redirects or heavy scripts.

### StorageTool

- Cache intermediate data or page snapshots before leaving a view when later steps need the same information.
- When referencing cached entries, mention the key or short summary so the user can follow the source.

### SettingTool

- Use `setting_tool` to read or modify user settings via chat.
- Actions: `get` reads a setting, `set` updates a setting, and `list` shows available settings with current values.
- Keys use dot-notation such as `approval.mode`, `tools.dom_tool`, `preferences.uiTheme`, `preferences.theme`, `preferences.language`, and `selectedModelKey`.
- Legacy aliases also work: `general.uiTheme`, `general.theme`, `general.language`, and `model.selection`.
- Boolean settings accept string `"true"` or `"false"` and are auto-coerced.
- Write operations are blocked in YOLO approval mode.

### Tool Chaining

- Combine independent read-only observations when supported by the runtime.
- Combine NavigationTool for positioning, DOMTool for structure, PageVisionTool for visual confirmation, and StorageTool for reusable context.
