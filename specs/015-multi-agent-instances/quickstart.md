# Quickstart: Multi-Agent Instances

**Feature**: 015-multi-agent-instances
**Date**: 2026-02-02

## Overview

This guide covers the multi-agent instance architecture that enables parallel execution of scheduled tasks and user sessions.

## Key Concepts

### AgentRegistry

Central registry managing all active agent sessions:

```typescript
import { AgentRegistry } from '@/core/registry/AgentRegistry';

// Get registry instance (singleton in service worker)
const registry = AgentRegistry.getInstance();

// Create a new session
const session = await registry.createSession({
  type: 'primary',
  tabId: currentTabId,
});

// Get existing session
const existing = registry.getSession(sessionId);

// List all sessions
const sessions = registry.listSessions();
```

### AgentSession

Wrapper providing lifecycle management around BrowserxAgent:

```typescript
// Session states: 'initializing' | 'active' | 'idle' | 'terminated'
console.log(session.state); // 'idle'

// Submit operation to session's agent
await session.submit({
  type: 'UserInput',
  items: [{ type: 'text', text: 'Hello' }],
});

// Bind to browser tab
session.bindTab(tabId);

// Terminate when done
await session.terminate();
```

### Session-Aware Messaging

Messages now include optional `sessionId` for routing:

```typescript
// Side panel sends message with session ID
chrome.runtime.sendMessage({
  type: MessageType.SUBMISSION,
  sessionId: 'my-session-id', // NEW: Routes to specific session
  payload: { op: operation },
});

// Without sessionId, routes to primary session (backward compatible)
chrome.runtime.sendMessage({
  type: MessageType.SUBMISSION,
  payload: { op: operation },
});
```

## Common Patterns

### Creating a Scheduled Task Session

```typescript
// In Scheduler.ts
async function executeScheduledTask(task: SchedulerTask): Promise<void> {
  const registry = AgentRegistry.getInstance();

  // Create isolated session for this task
  const session = await registry.createSession({
    type: 'scheduled',
    scheduledTaskId: task.id,
  });

  try {
    // Execute task in isolated session
    await session.submit({
      type: 'UserInput',
      items: [{ type: 'text', text: task.input }],
    });

    // Wait for completion...

  } finally {
    // Always cleanup
    await session.terminate();
  }
}
```

### Handling Session Events

```typescript
// Listen for session lifecycle events
registry.on('session:created', (event) => {
  console.log(`Session ${event.sessionId} created`);
});

registry.on('session:stateChanged', (event) => {
  console.log(`Session ${event.sessionId}: ${event.previousState} → ${event.newState}`);
});

registry.on('session:terminated', (event) => {
  console.log(`Session ${event.sessionId} terminated: ${event.reason}`);
});
```

### Tab Closure Handling

Sessions automatically terminate when their bound tab closes:

```typescript
// This is handled internally by AgentSession
// When tab closes:
// 1. Session receives tab closure event
// 2. Session transitions to 'terminated' state
// 3. Any running task is marked as failed
// 4. Session removed from registry
```

## Lifecycle States

```
┌──────────────┐
│ initializing │ ─── Session being created
└──────┬───────┘
       ▼
┌──────────────┐     (task submitted)    ┌──────────────┐
│     idle     │ ◄─────────────────────► │    active    │
└──────┬───────┘     (task completed)    └──────┬───────┘
       │                                        │
       ▼ (close)                                ▼ (error/tab close)
┌──────────────────────────────────────────────────────────┐
│                       terminated                          │
└──────────────────────────────────────────────────────────┘
```

## Configuration

### Concurrent Session Limit

Default: 3 sessions (1 user + 2 scheduled tasks)

```typescript
// Get current limit
const limit = registry.getMaxConcurrent(); // 3

// Set new limit (requires settings permission)
registry.setMaxConcurrent(5);

// Check if can create new session
if (registry.canCreateSession()) {
  const session = await registry.createSession(config);
}
```

### Session Persistence

Sessions are persisted for resumption after service worker restart:

```typescript
// Persist happens automatically on state changes
// Resume on service worker startup:

const registry = AgentRegistry.getInstance();
await registry.loadPersistedSessions();

// List available sessions
const sessions = registry.listSessions();
for (const meta of sessions) {
  if (meta.type === 'primary') {
    // Resume primary session
    await registry.resumeSession(meta.sessionId);
  }
}
```

## Debugging

### Check Active Sessions

```typescript
console.log('Active sessions:', registry.getActiveCount());
console.log('Sessions:', registry.listSessions());
```

### Session State Inspection

```typescript
const session = registry.getSession(sessionId);
if (session) {
  console.log('State:', session.state);
  console.log('Tab:', session.metadata.tabId);
  console.log('Type:', session.metadata.type);
  console.log('Last activity:', new Date(session.metadata.lastActivityAt));
}
```

## Testing

### Unit Test Example

```typescript
import { AgentRegistry } from '@/core/registry/AgentRegistry';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry({ maxConcurrent: 3 });
  });

  it('creates sessions up to limit', async () => {
    const s1 = await registry.createSession({ type: 'primary' });
    const s2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
    const s3 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't2' });

    expect(registry.getActiveCount()).toBe(3);

    // Should reject 4th session
    await expect(
      registry.createSession({ type: 'scheduled', scheduledTaskId: 't3' })
    ).rejects.toThrow('Max concurrent sessions reached');
  });
});
```

### Integration Test Example

```typescript
describe('Multi-session execution', () => {
  it('runs user session and scheduled task in parallel', async () => {
    // Create primary session
    const userSession = await registry.createSession({ type: 'primary' });

    // Create scheduled task session
    const taskSession = await registry.createSession({
      type: 'scheduled',
      scheduledTaskId: 'task-1',
    });

    // Both should be active
    expect(userSession.state).toBe('idle');
    expect(taskSession.state).toBe('idle');

    // Submit to both simultaneously
    await Promise.all([
      userSession.submit({ type: 'UserInput', items: [...] }),
      taskSession.submit({ type: 'UserInput', items: [...] }),
    ]);

    // Both processing in parallel
    expect(userSession.state).toBe('active');
    expect(taskSession.state).toBe('active');
  });
});
```

## Migration Notes

### Backward Compatibility

- Existing code without `sessionId` in messages continues to work
- Routes to primary session by default
- Single-session behavior preserved for non-scheduler use cases

### Breaking Changes

- None for external APIs
- Internal: `agent` global replaced with registry lookup
