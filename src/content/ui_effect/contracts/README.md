# API Contracts: DomTool Visual Effects

This directory contains TypeScript interface definitions and contracts for the visual effects system.

## Overview

The visual effects system uses a **fire-and-forget** event-driven architecture:

1. **DomTool** emits events when agent performs actions
2. **VisualEffectController** listens for events and orchestrates visual feedback
3. No blocking, no waiting, complete error isolation

## Contracts

### 1. `domtool-events.ts`

Defines the event emission contract for DomTool.

**Key Exports**:
- `VisualEffectEvent` - Union type of all event types
- `AgentActionEvent` - Event for click/type/keypress actions
- `AgentSerializeEvent` - Event for DOM serialization
- `IDomToolEventEmitter` - Interface DomTool must implement
- `dispatchVisualEffectEvent()` - Helper to dispatch events
- `isVisualEffectEvent()` - Type guard for validation

**Usage**:
```typescript
import { IDomToolEventEmitter, dispatchVisualEffectEvent } from './contracts/domtool-events';

class DomToolImpl implements IDomToolEventEmitter {
  emitAgentAction(action, element, boundingBox) {
    dispatchVisualEffectEvent({
      type: 'agent-action',
      action,
      element,
      boundingBox,
      timestamp: Date.now()
    });
  }
}
```

### 2. `visual-effect-controller.ts`

Defines the public API for the VisualEffectController.

**Key Exports**:
- `IVisualEffectController` - Public interface for controller
- `VisualEffectConfig` - Configuration options
- `VisualEffectState` - Current system state
- `DEFAULT_CONFIG` - Default configuration values
- State change/cursor update/error callbacks

**Usage**:
```typescript
import { createVisualEffectController } from './visual-effect-controller';

const controller = createVisualEffectController();
await controller.initialize({
  enableCursorAnimation: true,
  enableRippleEffects: true,
});

controller.onStateChange((state) => {
  console.log('Agent active:', state.agentSessionActive);
});
```

## Event Flow

```
┌──────────────┐
│   DomTool    │
│              │
│ - executeClick()
│ - executeType()
│ - get_serialized_dom()
└──────┬───────┘
       │
       │ emitAgentAction() / emitAgentSerialize()
       │ (fire-and-forget, no await)
       ▼
┌──────────────────────────┐
│  CustomEvent Dispatch    │
│                          │
│  type: 'browserx:visual-effect'
│  detail: { event: {...} }
└──────┬───────────────────┘
       │
       │ document.addEventListener()
       ▼
┌──────────────────────────┐
│ VisualEffectController   │
│                          │
│ - Queue event            │
│ - Process async          │
│ - Animate cursor         │
│ - Trigger ripple         │
└──────────────────────────┘
```

## Type Safety

All contracts are fully typed with TypeScript. Use type guards for runtime validation:

```typescript
import { isVisualEffectEvent } from './contracts/domtool-events';

document.addEventListener('browserx:visual-effect', (event) => {
  const detail = (event as CustomEvent).detail;

  if (isVisualEffectEvent(detail.event)) {
    // Type-safe access to event properties
    console.log(detail.event.type, detail.event.timestamp);
  }
});
```

## Error Handling

Per FR-017 and FR-018:
- All visual effect errors are caught and logged
- No errors propagate to DomTool
- Failed effects automatically reinitialize on next event

```typescript
controller.onError((error) => {
  console.error('[VisualEffects] Error:', error);
  // Error tracking, logging, telemetry, etc.
});
```

## Testing

Contract interfaces enable easy mocking for tests:

```typescript
import { IDomToolEventEmitter } from './contracts/domtool-events';

class MockDomTool implements IDomToolEventEmitter {
  emitAgentAction(action, element, boundingBox) {
    // Test implementation
  }

  // ... other methods
}

const mockTool = new MockDomTool();
// Test visual effects with mock
```

## Performance Constraints

From `visual-effect-controller.ts`:

- **Target FPS**: 60fps for cursor animations
- **Speed Boost**: 1.5x when queue > 3 events
- **Memory Budget**: <5MB total for all state

## Validation Rules

See `EVENT_CONSTRAINTS` in `domtool-events.ts`:

- Events older than 5 seconds may be dropped
- All event types must be from valid set
- AgentActionEvent must have element OR boundingBox

## Integration

1. **DomTool Integration**: Implement `IDomToolEventEmitter`
2. **Controller Setup**: Instantiate and initialize controller in content script
3. **Event Listening**: Controller automatically listens for events
4. **Cleanup**: Call `controller.destroy()` on unload

See `quickstart.md` for detailed integration guide.

## Version

Current version: **1.0.0**

Breaking changes will increment major version.
