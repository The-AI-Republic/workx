# Track 05: Session Memory - Tasks

## Phase 1: Memory File & Template

- [ ] Define memory file storage path: `${dataDir}/memory/session_memory.md`
- [ ] Define `MemorySection` type: { name, maxTokens, content }
- [ ] Define BrowserX memory template with 8 sections:
  - Current Task, Active Websites, User Preferences, Navigation History
  - Form Data Patterns, Errors and Workarounds, Extracted Data, Workflow State
- [ ] Implement `SessionMemoryTemplate.ts`:
  - parseMemoryFile(content): MemorySection[]
  - renderMemoryFile(sections): string
  - getSectionBudget(sectionName): number
  - isTemplateEmpty(content): boolean (matches default template)
- [ ] Set section budgets (tokens): Current Task 2000, Active Websites 1500, User Preferences 1000, Navigation History 1500, Form Data 1000, Errors 1500, Extracted Data 2000, Workflow 1500
- [ ] Implement memory file read/write utilities
- [ ] Write tests for template parsing and rendering

## Phase 2: Extraction Triggers

- [ ] Define `SessionMemoryConfig` type:
  - minimumTokensToInit: 10000
  - minimumTokensBetweenUpdates: 5000
  - toolCallsBetweenUpdates: 3
- [ ] Implement `shouldExtractMemory()` function:
  - Track tokens at last extraction
  - Track UUID of last processed message
  - Track initialization state (boolean latch)
  - Check token growth AND (tool call threshold OR natural break)
- [ ] Wire extraction check into post-turn processing in TurnManager
- [ ] Add token counting integration from existing TokenUsageStore
- [ ] Add tool call counting since last extraction point
- [ ] Make thresholds configurable via AgentConfig
- [ ] Write tests for threshold logic with various conversation patterns

## Phase 3: Extraction Engine

- [ ] Implement `SessionMemoryExtractor.ts`:
  - Takes current conversation history and existing memory
  - Sends extraction prompt to model (using SummaryGenerator pattern)
  - Returns updated memory sections
- [ ] Create extraction prompt:
  - Include current memory file content
  - Include recent conversation since last extraction
  - Instruct model to update/append sections without exceeding budgets
  - Focus on BrowserX-specific context (websites, selectors, approvals)
- [ ] Implement non-blocking extraction:
  - Run async with configurable timeout (default 15s)
  - On timeout, abandon silently (log warning)
  - On success, write updated memory file
- [ ] Add extraction state tracking: extractionStartedAt, isExtracting flag
- [ ] Prevent concurrent extractions (skip if already in progress)
- [ ] Write tests for extraction with mock model responses

## Phase 4: Injection & Continuity

- [ ] Implement `SessionMemoryInjector.ts`:
  - loadMemory(): Promise<string | null>
  - injectIntoPrompt(systemPrompt, memoryContent): string
- [ ] Load previous session memory on session initialization in RepublicAgent
- [ ] Inject memory content into system prompt (after base instructions, before user context)
- [ ] Add memory content to TurnContext for model access
- [ ] Cap injection at 12,000 tokens (truncate oldest sections first)
- [ ] Add timestamps to memory sections for staleness detection
- [ ] Implement `/memory` command: view current memory file content
- [ ] Implement `/memory clear` command: reset memory file to template
- [ ] Add memory persistence across agent restarts (survives shutdown/startup)
- [ ] Wire memory injection into existing prompt composition in TurnManager
- [ ] Write integration tests for full cycle: conversation → extraction → injection
