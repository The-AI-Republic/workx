# Data Model: ResponseItem Provider-Agnostic Architecture Audit

**Date**: 2026-02-17
**Feature**: 026-provider-agnostic-audit

## Entity Relationships

This feature is an architectural audit, not a data-driven feature. The entities below document the existing architecture being audited rather than new entities to create.

### ResponseItem (Universal IR)

The core entity under audit. A discriminated union representing conversation history items.

**Variants**:
| Type | Key Fields | Provider-Agnostic? |
|------|-----------|-------------------|
| `message` | role, content (ContentItem[]), reasoning_content?, tool_calls? | Yes |
| `reasoning` | summary, content?, encrypted_content? | Yes |
| `function_call` | name, arguments, call_id | Yes |
| `function_call_output` | call_id, output | Yes |
| `web_search_call` | action (WebSearchAction) | Yes |
| `local_shell_call` | action (LocalShellAction) | Yes |
| `custom_tool_call` | name, input | Yes |

**Metadata Fields**:
| Field | Location | Purpose | Provider-Specific? |
|-------|----------|---------|-------------------|
| `thoughtSignature` | tool_calls[] items | Opaque passthrough for Gemini 3.0+ | No (opaque string) |
| `reasoning_content` | message variant | Reasoning text from thinking models | No (generic string) |
| `encrypted_content` | reasoning variant | Encrypted reasoning for persistence | No (opaque string) |

### ModelClient (Conversion Boundary)

Abstract base class defining the provider-specific conversion boundary.

**Inheritance**:
```
ModelClient (abstract)
├── OpenAIResponsesClient
│   ├── OpenAIChatCompletionClient
│   │   ├── FireworksChatCompletionClient
│   │   └── TogetherChatCompletionClient
│   ├── GroqClient
│   └── FireworksClient
└── GoogleCompletionClient
```

**Conversion Flow**:
```
ResponseItem[] → get_formatted_input() → Client.buildRequestPayload() → Provider API
Provider API → Client.convertSDKEventToResponseEvent() → ResponseEvent → ResponseItem[]
```

### File Boundary Classification

| Classification | Count | Provider Imports Allowed? |
|---------------|-------|--------------------------|
| Type Definitions | 4 | No |
| Client Classes | 7 | Yes (expected) |
| Shared Components | 17 | No |
| Test Files | 20+ | N/A (test mocks) |
