# Track 06: Multi-Agent Coordination - Tasks

## Phase 1: Coordinator Mode Foundation

- [ ] Define `CoordinatorMode` flag in AgentConfig (boolean, default: false)
- [ ] Implement `isCoordinatorMode()` check function
- [ ] Create coordinator system prompt in `CoordinatorMode.ts`:
  - Role: orchestrator that delegates to workers
  - Directive: self-contained prompts (workers have no conversation context)
  - Directive: synthesize results (don't pass through raw worker output)
  - Directive: verify results (prove, don't rubber-stamp)
- [ ] Define `WorkerContext` type: { workerId, tabId, allowedTools, parentSessionId, role }
- [ ] Define worker roles: 'research' | 'automation' | 'analysis' | 'general'
- [ ] Define tool restriction sets per role (using function-definition names):
  - research: `web_scraping`, `data_extraction`, `page_vision`, `planning_tool`
  - automation: `browser_dom`, `browser_navigation`, `form_automation`, `web_scraping`
  - analysis: `data_extraction`, `web_scraping`, `planning_tool`
  - general: all tools
- [ ] Add coordinator mode entry command: `/coordinate`
- [ ] Write tests for coordinator mode activation and tool restriction

## Phase 2: Worker Spawning

- [ ] Implement `WorkerSpawner.ts`:
  - createWorker(prompt, role, options): Promise<WorkerContext>
  - Opens dedicated browser tab for worker
  - Registers worker in AgentRegistry
  - Sets up restricted ToolRegistry for worker
- [ ] Register `SpawnWorkerTool` in coordinator's ToolRegistry:
  - Input: { prompt, description, role?, run_in_background? }
  - Creates worker, returns workerId
- [ ] Wire worker lifecycle into AgentRegistry:
  - Worker sessions tracked as AgentSession
  - Status transitions: created → running → completed/failed
- [ ] Implement worker cleanup on completion:
  - Close dedicated tab
  - Release ToolRegistry resources
  - Remove from AgentRegistry
- [ ] Add concurrent worker limit (configurable, default: 3)
- [ ] Add AbortController per worker for cancellation
- [ ] Write tests for worker spawning, tab allocation, and cleanup

## Phase 3: Cross-Agent Messaging

- [ ] Implement `CrossAgentMessaging.ts`:
  - sendMessage(workerId, message): void
  - getMessages(workerId): string[]
- [ ] Register `SendMessageTool` in coordinator's ToolRegistry:
  - Input: { to: workerId, message: string }
  - Queues message in worker's pendingMessages
- [ ] Register `StopWorkerTool` in coordinator's ToolRegistry:
  - Input: { workerId: string, reason?: string }
  - Triggers worker AbortController
- [ ] Register `ListWorkersTool` in coordinator's ToolRegistry:
  - Returns: active workers with status, role, tab URL, progress
- [ ] Add `pendingMessages` queue in WorkerContext
- [ ] Implement message drain at tool-round boundaries in worker's TurnManager
- [ ] Write tests for message queueing and delivery

## Phase 4: Task Notifications

- [ ] Define `TaskNotification` type:
  - taskId, status, summary, result, usage (tokens, toolUses, durationMs)
- [ ] Implement `TaskNotificationPipeline.ts`:
  - onWorkerComplete(workerId, result): void
  - Formats notification as structured message
  - Injects into coordinator's conversation as system message
- [ ] Add atomic notification guard (notified flag, prevent duplicates)
- [ ] Wire worker completion to notification pipeline
- [ ] Add notification to coordinator's conversation context
- [ ] Implement result synthesis: coordinator model sees notifications and produces user-facing answer
- [ ] Add notification events to protocol: WorkerNotification
- [ ] Optional: implement `SharedScratchpad.ts` for cross-worker knowledge sharing
  - Key-value store accessible by all workers
  - Coordinator can pre-populate with shared context
- [ ] Write tests for notification delivery and deduplication
