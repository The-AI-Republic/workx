# Track 02: Tool Metadata & Concurrency - Tasks

## Phase 1: Type Definitions

- [ ] Define `ToolConcurrencyMetadata` interface in `src/tools/types.ts`
- [ ] Define `ToolProgressData` base type and tool-specific progress types
- [ ] Define `ToolProgressMetadata` interface with onProgress callback
- [ ] Define `ToolResultMetadata` interface with maxResultSizeChars, isSearchOrRead
- [ ] Extend `ToolDefinition` in `BaseTool.ts` with optional concurrency/progress/result fields
- [ ] Add fail-closed defaults in `ToolRegistry.registerTool()`:
  - isConcurrencySafe: () => false
  - isReadOnly: () => false
  - isDestructive: () => false
- [ ] Add `getActivityDescription()` to ToolDefinition (optional, returns string|null)
- [ ] Update `ToolRegistry.execute()` signature to accept optional onProgress callback

## Phase 2: Annotate Existing Tools

- [ ] Add concurrency metadata to `dom_tool`:
  - read/query actions → concurrency-safe, read-only
  - click/type/scroll actions → not concurrent-safe, not read-only
  - remove/clear actions → destructive
- [ ] Add concurrency metadata to `navigation_tool` (not concurrent-safe)
- [ ] Add concurrency metadata to `web_scraping_tool` (concurrent-safe, read-only)
- [ ] Add concurrency metadata to `form_automation_tool` (not concurrent-safe)
- [ ] Add concurrency metadata to `data_extraction_tool` (concurrent-safe, read-only)
- [ ] Add concurrency metadata to `storage_tool`:
  - get/list → concurrent-safe, read-only
  - set/remove → not concurrent-safe
- [ ] Add concurrency metadata to `page_vision_tool` (concurrent-safe, read-only)
- [ ] Add concurrency metadata to `network_intercept_tool` (not concurrent-safe)
- [ ] Add concurrency metadata to `planning_tool` (concurrent-safe, not read-only)
- [ ] Add concurrency metadata to `web_search_tool` (concurrent-safe, read-only)
- [ ] Add concurrency metadata to `setting_tool` (not concurrent-safe)
- [ ] Add `getActivityDescription()` to each tool (human-readable status)
- [ ] Write unit tests for per-input concurrency checks on dom_tool and storage_tool

## Phase 3: Progress Reporting

- [ ] Define `DOMToolProgress` type: { action, selector, status }
- [ ] Define `NavigationProgress` type: { url, status: 'loading'|'loaded'|'failed' }
- [ ] Define `WebScrapingProgress` type: { contentType, bytesExtracted }
- [ ] Define `MCPToolProgress` type: { serverName, toolName, status }
- [ ] Thread `onProgress` callback through `ToolRegistry.execute()`
- [ ] Emit progress in dom_tool during DOM serialization and action execution
- [ ] Emit progress in navigation_tool during page load
- [ ] Emit progress in web_scraping_tool during content extraction
- [ ] Map progress events to existing `EventMsg` protocol types
- [ ] Add ToolProgress event to protocol events (ToolExecutionProgress)
- [ ] Wire progress events to UI (EventDisplay component)

## Phase 4: Result Management

- [ ] Add `maxResultSizeChars` to web_scraping_tool (default: 50,000)
- [ ] Add `maxResultSizeChars` to data_extraction_tool (default: 30,000)
- [ ] Add `maxResultSizeChars` to dom_tool read actions (default: 100,000)
- [ ] Implement `DiskToolOutput` class for persisting oversized results
  - Append-only file writing
  - Session-scoped directory
  - Cleanup on session end
- [ ] Modify `ToolRegistry.execute()` to check result size against maxResultSizeChars
- [ ] When result exceeds max, persist to disk and return reference object
- [ ] Add `inputsEquivalent()` to tools for deduplication (optional)
