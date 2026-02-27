# Feature Specification: ResponseItem Provider-Agnostic Architecture Audit

**Feature Branch**: `026-provider-agnostic-audit`
**Created**: 2026-02-17
**Status**: Draft
**Input**: User description: "Inspect if ResponseItem is platform/provider agnostic and if clients properly handle conversion to LLM provider-compatible formats. Identify any improvements needed."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verify ResponseItem Contains No Provider-Specific Concerns (Priority: P1)

As a developer maintaining multi-provider support, I want to confirm that the ResponseItem type definition contains no provider-specific types, imports, or logic so that conversation history remains a universal intermediate representation regardless of which LLM provider is used.

**Why this priority**: ResponseItem is the foundation of the entire conversation history system. If it leaks provider-specific concerns, every component that touches conversation history becomes coupled to specific providers, making it impossible to cleanly add new providers or swap existing ones.

**Independent Test**: Can be fully tested by reviewing the ResponseItem type definition and its imports in `src/core/protocol/types.ts`, confirming zero references to any provider SDK or provider-specific type.

**Acceptance Scenarios**:

1. **Given** the ResponseItem type definition in `src/core/protocol/types.ts`, **When** all imports and type references are analyzed, **Then** no imports from provider SDKs (OpenAI, Anthropic, Google, Groq, etc.) exist
2. **Given** the ResponseItem discriminated union, **When** each variant's fields are inspected, **Then** all field names are generic (e.g., `role`, `content`, `tool_calls`) rather than provider-specific (e.g., no `openai_message_id`, no `gemini_content`)
3. **Given** any metadata fields on ResponseItem (e.g., `thoughtSignature` on tool_calls), **When** their usage is traced, **Then** they carry opaque data only and contain no provider-specific logic within the type definition itself

---

### User Story 2 - Verify Client Classes Own All Provider-Specific Conversion (Priority: P1)

As a developer adding a new LLM provider, I want to confirm that all provider-specific conversion logic lives exclusively within client classes so that I only need to implement a new client subclass without modifying ResponseItem or shared components.

**Why this priority**: If conversion logic leaks outside of client classes (e.g., into PromptHelpers, EventMapping, or TurnManager), adding a new provider would require changes across multiple unrelated files, increasing coupling and risk.

**Independent Test**: Can be fully tested by tracing the data flow from ResponseItem storage through client conversion to API call, confirming all provider-specific transformations happen exclusively within `ModelClient` subclasses.

**Acceptance Scenarios**:

1. **Given** `OpenAIChatCompletionClient`, **When** its ResponseItem-to-request conversion is inspected, **Then** all OpenAI Chat Completions format transformations (role mapping, content structure, tool call normalization) occur within this class
2. **Given** `GoogleCompletionClient`, **When** its ResponseItem-to-request conversion is inspected, **Then** all Gemini-specific transformations (role 'assistant' to 'model', image format to `inlineData`, `thoughtSignature` preservation) occur within this class
3. **Given** `OpenAIResponsesClient`, **When** its ResponseItem-to-request conversion is inspected, **Then** all Responses API-specific behavior (Azure detection, xAI `store` parameter, encrypted reasoning content) occurs within this class
4. **Given** shared components (`PromptHelpers.ts`, `EventMapping.ts`, `CompactService.ts`, `TurnManager.ts`), **When** their code is analyzed, **Then** they work exclusively with generic ResponseItem types and contain zero provider-specific branching

---

### User Story 3 - Verify Event Reverse-Mapping Is Provider-Agnostic (Priority: P2)

As a developer working on UI rendering, I want to confirm that the conversion from provider API responses back to ResponseItem (and then to UI EventMsg) is also cleanly separated so that the UI layer never needs to know which provider generated a response.

**Why this priority**: The reverse path (provider response to ResponseItem to UI) must also be provider-agnostic to maintain the clean architecture. If the UI layer contains provider-specific handling, it creates a maintenance burden as providers change their response formats.

**Independent Test**: Can be fully tested by reviewing `EventMapping.ts` and confirming it handles all ResponseItem variants generically without provider-specific conditional logic.

**Acceptance Scenarios**:

1. **Given** the `mapResponseItemToEventMessages` function in `EventMapping.ts`, **When** its logic is analyzed, **Then** it handles all ResponseItem types generically with no provider-specific code paths
2. **Given** each client's `convertSDKEventToResponseEvent` method, **When** provider-specific response events are converted, **Then** the output conforms to the generic ResponseEvent/ResponseItem format before leaving the client class

---

### Edge Cases

- What happens when a provider returns data that has no ResponseItem equivalent (e.g., a provider-specific metadata field)? Verify the client either maps it to a generic field or discards it cleanly.
- What happens when a ResponseItem variant is not supported by a particular provider's API? Verify the client handles unsupported types gracefully (skip or error) rather than crashing.
- What happens when tool call arguments are malformed JSON? Verify normalization happens only in the client layer, not in ResponseItem.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: ResponseItem type definition MUST contain zero imports from any provider SDK or provider-specific type library
- **FR-002**: ResponseItem field names MUST use generic, provider-neutral terminology (e.g., `role`, `content`, `tool_calls` rather than provider-specific names)
- **FR-003**: All provider-specific request format transformations (role mapping, content structure conversion, image format conversion, parameter handling) MUST occur exclusively within the corresponding `ModelClient` subclass
- **FR-004**: All non-client files that import or reference ResponseItem MUST operate on generic ResponseItem types without provider-specific branching
- **FR-005**: Each client class MUST convert provider-specific API responses back to generic ResponseItem format before the data leaves the client boundary
- **FR-006**: When a ResponseItem variant is not supported by a provider, the client MUST handle it gracefully (skip silently or log a warning) rather than passing invalid data to the provider API
- **FR-007**: Any opaque metadata fields stored on ResponseItem (e.g., `thoughtSignature`) MUST be treated as passthrough data with no provider-specific logic in the type definition itself
- **FR-008**: Any violations discovered during the audit MUST be fixed within this same spec scope, not deferred to a separate follow-up
- **FR-009**: Audit findings (both passing and failing items) MUST be documented as part of the deliverable
- **FR-010**: Architectural guard-rail tests MUST be added to prevent future regressions (e.g., tests that fail if provider-specific imports appear in ResponseItem or shared components)
- **FR-011**: The audit scope MUST cover ALL files that import or reference ResponseItem, including client subclasses, to verify consistency of conversion patterns across providers

### Key Entities

- **ResponseItem**: The universal intermediate representation for conversation history. A discriminated union with 7+ variants (message, reasoning, function_call, function_call_output, web_search_call, local_shell_call, custom_tool_call). Stored in conversation history and used by all components.
- **ModelClient**: Abstract base class for LLM provider integrations. Subclasses own all provider-specific conversion logic. Current implementations: OpenAIResponsesClient, OpenAIChatCompletionClient, GoogleCompletionClient, GroqClient, FireworksClient, FireworksChatCompletionClient, TogetherChatCompletionClient.
- **ContentItem**: Nested type within ResponseItem messages representing individual content pieces (text, images). Must also be provider-agnostic.
- **ResponseEvent**: The streaming event format emitted by clients during API calls. Converted from provider-specific SSE/streaming events within the client boundary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero provider-specific imports or type references found in the ResponseItem type definition file
- **SC-002**: Zero provider-specific conditional logic found in shared components (PromptHelpers, EventMapping, CompactService, TurnManager)
- **SC-003**: 100% of provider-specific format transformations are traceable to a specific ModelClient subclass
- **SC-004**: All existing unit tests pass after any refactoring changes (if improvements are needed)
- **SC-005**: Adding a hypothetical new provider requires changes only in a new client subclass file and the ModelClientFactory registration, with zero changes to ResponseItem or shared components
- **SC-006**: Architectural guard-rail tests exist and pass, preventing future introduction of provider-specific concerns into ResponseItem or shared components
- **SC-007**: All client subclasses follow a consistent conversion pattern when transforming ResponseItem to/from their provider-specific format

## Clarifications

### Session 2026-02-17

- Q: Should this spec cover only the audit (findings report) or also implement fixes? → A: Audit + fix + tests - document findings, implement any necessary fixes, and add architectural guard-rail tests within this same spec.
- Q: Should the audit scope cover only the 4 listed shared components or all files that import ResponseItem? → A: All importers + clients - audit every file that imports ResponseItem, including client subclasses, to verify consistency of conversion patterns.

## Assumptions

- The existing `thoughtSignature` field on tool_calls is acceptable as opaque metadata stored on ResponseItem, since it carries no provider-specific logic in the type definition itself. Clients that need it (GoogleCompletionClient) read it during conversion; others ignore it.
- The OpenAI Responses API format being structurally similar to ResponseItem is by design (ResponseItem was likely modeled after this API), and this alignment is acceptable rather than being a provider coupling concern.
- The listed provider 'anthropic' in ModelClientFactory has no implementation yet. This is a known gap but is not a violation of the provider-agnostic architecture since the factory simply maps provider names to client classes.
- Minor provider-specific workarounds in client classes (e.g., Azure URL detection in OpenAIResponsesClient, Moonshot usage location in OpenAIChatCompletionClient) are acceptable since they are fully contained within their respective client classes.
