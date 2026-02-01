## Gemini 2.5 Pro Agent Notes

### Overview
- Gemini 2.5 Pro is Google DeepMind's flagship multimodal reasoning model exposed through Google AI Studio.
- The OpenAI-compatible Responses API provides feature parity with the native Gemini API for chat, function calling, and streaming, which lets BrowserX reuse the existing OpenAI client.
- Gemini 2.5 Pro offers multi-million token context windows (up to ~2M tokens) and strong tool-use planning, making it suitable for long-running browser automation sessions.

### Agent-Oriented Capabilities
- **Function / tool calling**: Supports auto tool selection with OpenAI-compatible `tool_choice: "auto"` semantics and structured function schemas. Gemini is tuned to plan multi-step tool sequences when given explicit affordances and examples.
- **Reasoning summaries**: Streams intermediate reasoning traces via `reasoning` deltas. These can be surfaced in BrowserX's reasoning panels or used for debugging.
- **JSON / schema control**: Honors `response_format` JSON schema constraints in the compatibility layer, provided schemas are bounded (< 8kb). Gemini also supports `safety_settings` to dial down hallucination in high-stakes actions.
- **Search grounding**: Built-in Google Search grounding can be enabled with the native Gemini API. In the OpenAI compatibility layer, similar behavior is achieved by exposing BrowserX's web-search tool and asking Gemini to call it explicitly.
- **Media support**: Accepts images and screenshots as inline data parts. For BrowserX this makes screenshot-to-action workflows more reliable compared to text-only reasoning.

### Implementation Notes for BrowserX
- **Base URL**: `https://generativelanguage.googleapis.com` (for native SDK usage). 
- **Client**: BrowserX uses the native `@google/genai` SDK for Gemini 2.5/3.0 to support advanced features like thought signatures and large context windows.
- **Endpoint**: The native SDK automatically handles endpoint construction (e.g., `v1beta/models/...:streamGenerateContent`).
- **Authorization**: Standard `Authorization: Bearer <API_KEY>` or API key passed via SDK options. No project ID is required when using AI Studio keys.
- **Text Accumulation**: BrowserX's `GoogleCompletionClient` manually accumulates text and tool calls to ensure responses appear correctly in conversation history.
- Model ID: `gemini-2.0-flash-exp`, `gemini-2.5-pro`, `gemini-3-pro-preview`. 
- Rate limits: AI Studio keys default to 60 RPM / 6 RPS. BrowserX's queue should respect these values until elevated quotas are granted.
- Prompting tips:
  - Keep system instructions concise (~2-3 paragraphs) and explicitly describe available BrowserX tools so Gemini can plan tool calls.
  - For deterministic UI actions, provide short exemplars of function arguments (e.g., JSON showing `selector`, `action`) because Gemini mirrors the schema reasoning style seen in Google docs.
  - When asking Gemini to browse, mention that DOM snapshots are partial and it should request additional scrapes via tools.
- Safety: AI Studio enforces content safety filters. For automation flows that require broader coverage (e.g., security testing), request Safety Bypass entitlements or catch `SAFETY` blocks and rephrase.

### Limitations & Watchouts
- Native streaming latency can be ~1–2 seconds higher than GPT-4o; prefetch prompts accordingly.
- Tool call arguments may include trailing comments when schemas are loose; enable `strict` schemas to keep JSON parseable.
- Image input currently expects base64-encoded `data:` URIs; large PNGs may need downsampling client-side to stay under the ~20 MB limit.
- Safety blocks can trigger retriable errors; wrap the client with exponential backoff respecting `Retry-After`.
- The compatibility API does not yet expose the full `response_mime_type` options—stick to text/json modes for now.

### Further Reading
- Google AI Studio docs: **Gemini API > OpenAI compatibility** section (overview of endpoints, tooling, and safety).
- Gemini Agent Playbooks (Google I/O 2024) for examples on chaining tools and interpreting structured output.
- BrowserX internal TODO: evaluate whether to surface Gemini reasoning deltas in the side panel once telemetry UX is finalized.
