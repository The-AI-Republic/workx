<script lang="ts">
  /**
   * Visual Effect Controller
   *
   * Main orchestrator for all visual effects during agent operations.
   * Listens for DomTool events and coordinates cursor animation, ripple effects, and overlay.
   *
   * Architecture:
   * - Fire-and-forget event-driven (no blocking)
   * - Complete error isolation from DomTool
   * - Shadow DOM injection for style isolation
   * - Graceful WebGL degradation
   *
   * @component
   */

  import { onMount, onDestroy } from 'svelte';
  import Overlay from './Overlay.svelte';
  import CursorAnimator from './CursorAnimator.svelte';
  import ControlButtons from './ControlButtons.svelte';
  import {
    overlayState,
    effectQueue,
    visualEffectState,
    animationState,
    resetStores,
    syncVisualEffectState,
  } from './stores';
  import {
    isVisualEffectEvent,
    VISUAL_EFFECT_EVENT_NAME,
    type VisualEffectEvent,
    type AgentActionEvent,
  } from './contracts/domtool-events';
  import {
    getViewportCoordinates,
    getViewportCoordinatesFromRect,
  } from './utils/coordinateCalculator';
  import type {
    VisualEffectConfig,
    VisualEffectState,
    StateChangeCallback,
    CursorUpdateCallback,
    ErrorCallback,
  } from './contracts/visual-effect-controller';
  import { DEFAULT_CONFIG } from './contracts/visual-effect-controller';

  // Component refs
  let cursorAnimatorRef: any = null;
  let mountComplete = false;

  // Water ripple effect instance
  let waterRipple: any = null;

  // Control buttons visibility state
  let showControlButtons = false;
  let takeoverActive = false;

  // Subscribe to overlay state for control buttons visibility
  overlayState.subscribe(state => {
    showControlButtons = state.visible && state.agentSessionActive;
    takeoverActive = state.takeoverActive;
  });

  // Configuration
  let config: VisualEffectConfig = { ...DEFAULT_CONFIG };

  // Callback subscriptions
  const stateChangeCallbacks: StateChangeCallback[] = [];
  const cursorUpdateCallbacks: CursorUpdateCallback[] = [];
  const errorCallbacks: ErrorCallback[] = [];

  // Event listener cleanup
  let eventListenerCleanup: (() => void) | null = null;
  let storeCleanup: (() => void) | null = null;

  onMount(async () => {
    try {
      console.log('[VisualEffectController] Mounting...');

      // Sync stores
      storeCleanup = syncVisualEffectState();

      // Listen for visual effect events
      setupEventListeners();

      // Initialize water ripple effect
      if (config.enableRippleEffects) {
        await initializeWaterRipple();
      }

      // Add viewport resize handler
      window.addEventListener('resize', handleViewportResize);

      mountComplete = true;
      console.log('[VisualEffectController] Mount complete, cursorAnimatorRef:', !!cursorAnimatorRef);
    } catch (error) {
      handleError('Initialization error', error);
    }
  });

  onDestroy(() => {
    // Remove viewport resize handler
    window.removeEventListener('resize', handleViewportResize);

    // Clean up event listeners
    if (eventListenerCleanup) {
      eventListenerCleanup();
    }

    // Clean up store sync
    if (storeCleanup) {
      storeCleanup();
    }

    // Destroy water ripple
    if (waterRipple) {
      try {
        waterRipple.destroy();
      } catch (error) {
        console.debug('[VisualEffectController] Error destroying water ripple:', error);
      }
      waterRipple = null;
    }

    // Reset stores
    resetStores();
  });

  /**
   * Initialize water ripple effect
   *
   * Loads WaterRipple class and instantiates with configuration.
   * Gracefully degrades if WebGL is not supported.
   */
  async function initializeWaterRipple() {
    try {
      // Dynamically import water ripple effect
      const WaterRippleModule = await import('./water_ripple_effect.js');
      const WaterRipple = WaterRippleModule.default;

      waterRipple = new WaterRipple({
        resolution: config.rippleConfig?.resolution ?? 256,
        dropRadius: config.rippleConfig?.radius ?? 20,
        perturbance: config.rippleConfig?.perturbance ?? 0.03,
      });

      // Set z-index to be second highest (below cursor/buttons, above overlay)
      // Ripples are visible through the semi-transparent overlay
      if (waterRipple.canvas) {
        waterRipple.canvas.style.zIndex = '2147483646';
      }

      console.debug('[VisualEffectController] Water ripple effect initialized');
    } catch (error) {
      console.warn('[VisualEffectController] Failed to initialize water ripple (WebGL may not be supported):', error);
      // Graceful degradation - effects continue without ripples
    }
  }

  /**
   * Setup event listeners for DomTool events
   */
  function setupEventListeners() {
    console.log('[VisualEffectController] $$$ Setting up event listeners...');

    // Listen for visual effect events from DomTool
    const visualEffectHandler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const effectEvent = customEvent.detail?.event;

      if (!isVisualEffectEvent(effectEvent)) {
        return;
      }

      handleVisualEffectEvent(effectEvent);
    };

    document.addEventListener(VISUAL_EFFECT_EVENT_NAME, visualEffectHandler);

    // Listen for direct visual effect messages from DomService (CDP-based)
    const directVisualEffectHandler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { type, x, y } = customEvent.detail;

      console.log('[VisualEffectController] Direct visual effect received:', { type, x, y });

      try {
        // Handle different effect types
        if (type === 'ripple') {
          // Ripple effect for click actions - show overlay, animate cursor
          // The ripple will be triggered automatically when cursor arrives at target

          // 1. Ensure overlay is visible for agent actions
          overlayState.update(state => {
            if (!state.agentSessionActive) {
              return {
                ...state,
                visible: true,
                agentSessionActive: true,
                takeoverActive: false,
              };
            }
            return state;
          });

          // 2. Ensure water ripple canvas is visible
          if (waterRipple && config.enableRippleEffects && !waterRipple.visible) {
            waterRipple.turnOn();
          }

          // 3. Animate cursor to target position
          // The cursor will automatically trigger ripple when it arrives via 'browserx:trigger-ripple' event
          if (cursorAnimatorRef && config.enableCursorAnimation && x !== undefined && y !== undefined) {
            console.log('[VisualEffectController] Animating cursor to:', x, y);
            cursorAnimatorRef.animateTo(x, y);
          } else if (!cursorAnimatorRef || !config.enableCursorAnimation) {
            // If cursor animation is disabled, trigger ripple immediately
            if (waterRipple && config.enableRippleEffects) {
              waterRipple.drop(
                x,
                y,
                config.rippleConfig?.radius ?? 20,
                config.rippleConfig?.strength ?? 0.5
              );
            }
          }

          notifyStateChange();
        } else if (type === 'undulate') {
          // Undulate effect (DOM observation/analysis) - no coordinates needed

          // Ensure overlay is visible during DOM analysis
          overlayState.update(state => {
            if (!state.agentSessionActive) {
              return {
                ...state,
                visible: true,
                agentSessionActive: true,
                takeoverActive: false,
              };
            }
            return state;
          });

          // Trigger undulate effect
          if (waterRipple && config.enableRippleEffects) {
            if (!waterRipple.visible) {
              waterRipple.turnOn();
            }
            waterRipple.undulate();
          }

          notifyStateChange();
        }
      } catch (error) {
        handleError(`Direct ${type} effect error`, error);
      }
    };

    document.addEventListener('browserx:show-visual-effect', directVisualEffectHandler);

    // Listen for ripple trigger events from cursor animator
    const rippleHandler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { x, y } = customEvent.detail;

      if (waterRipple && config.enableRippleEffects) {
        try {
          // Ensure canvas is visible before dropping ripple
          if (!waterRipple.visible) {
            waterRipple.turnOn();
          }

          waterRipple.drop(
            x,
            y,
            config.rippleConfig?.radius ?? 20,
            config.rippleConfig?.strength ?? 0.5
          );
        } catch (error) {
          handleError('Ripple effect error', error);
        }
      }
    };

    document.addEventListener('browserx:trigger-ripple', rippleHandler);

    // Listen for stop agent events from control buttons
    const stopAgentHandler = () => {
      handleStopAgentButton();
    };

    document.addEventListener('browserx:stop-agent', stopAgentHandler);

    // T012-T014: Listen for task lifecycle events via DOM custom events
    // UPDATED: Now uses DOM custom events dispatched by content-script.ts (fixes race condition)
    const taskLifecycleHandler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { eventType } = customEvent.detail;

      console.log('[VisualEffectController] $$$ Task lifecycle event:', eventType);

      // Clear visual effects when task ends
      if (eventType === 'TaskComplete' ||
          eventType === 'TaskFailed' ||
          eventType === 'TurnAborted') {
        console.log('[VisualEffectController] $$$ Task ended, calling handleAgentStop:', eventType);
        handleAgentStop();
      }
      // Show visual effects when task starts
      else if (eventType === 'TaskStarted') {
        console.log('[VisualEffectController] $$$ Task started, calling handleAgentStart');
        handleAgentStart();
      }
    };

    document.addEventListener('browserx:task-lifecycle', taskLifecycleHandler);
    console.log('[VisualEffectController] $$$ DOM event listener registered for task lifecycle');

    // Cleanup function
    eventListenerCleanup = () => {
      document.removeEventListener(VISUAL_EFFECT_EVENT_NAME, visualEffectHandler);
      document.removeEventListener('browserx:show-visual-effect', directVisualEffectHandler);
      document.removeEventListener('browserx:trigger-ripple', rippleHandler);
      document.removeEventListener('browserx:stop-agent', stopAgentHandler);
      document.removeEventListener('browserx:task-lifecycle', taskLifecycleHandler);
    };

    console.log('[VisualEffectController] $$$ Event listeners setup complete');
  }

  /**
   * Handle visual effect event from DomTool
   *
   * Routes event to appropriate handler based on type.
   * All errors are caught and logged (fire-and-forget).
   */
  function handleVisualEffectEvent(event: VisualEffectEvent) {
    try {
      switch (event.type) {
        case 'agent-start':
          handleAgentStart();
          break;

        case 'agent-stop':
          handleAgentStop();
          break;

        case 'agent-action':
          handleAgentAction(event as AgentActionEvent);
          break;

        case 'agent-serialize':
          handleAgentSerialize();
          break;

        default:
          console.warn('[VisualEffectController] Unknown event type:', (event as any).type);
      }
    } catch (error) {
      handleError('Event handling error', error);
    }
  }

  /**
   * Handle agent start event
   *
   * Shows overlay and initializes cursor position.
   */
  function handleAgentStart() {
    overlayState.update(state => ({
      ...state,
      visible: true,
      agentSessionActive: true,
      takeoverActive: false,
    }));

    // Turn on water ripple canvas for visual effects
    if (waterRipple) {
      try {
        waterRipple.turnOn();
      } catch (error) {
        handleError('Water ripple turnOn error', error);
      }
    }

    notifyStateChange();
  }

  /**
   * Handle agent stop event
   *
   * Hides overlay and resets state.
   */
  function handleAgentStop() {
    // T028: Add cleanup logging
    console.log('[VisualEffectController] $$$ Clearing visual effects');

    overlayState.update(state => ({
      ...state,
      visible: false,
      agentSessionActive: false,
    }));

    // Turn off water ripple canvas
    if (waterRipple) {
      try {
        waterRipple.turnOff();
      } catch (error) {
        handleError('Water ripple turnOff error', error);
      }
    }

    resetStores();
    notifyStateChange();
  }

  /**
   * Handle agent action event (click, type, keypress)
   *
   * Enqueues event and triggers cursor animation.
   */
  function handleAgentAction(event: AgentActionEvent) {
    console.log('[VisualEffectController] handleAgentAction called:', event.action);

    // Calculate viewport coordinates
    let x: number;
    let y: number;

    if (event.element) {
      const coords = getViewportCoordinates(event.element);
      if (!coords) {
        console.warn('[VisualEffectController] Failed to calculate coordinates for element');
        return;
      }
      x = coords.x;
      y = coords.y;
      console.log('[VisualEffectController] Element coordinates:', x, y);
    } else if (event.boundingBox) {
      const coords = getViewportCoordinatesFromRect(event.boundingBox);
      x = coords.x;
      y = coords.y;
      console.log('[VisualEffectController] BoundingBox coordinates:', x, y);
    } else {
      console.warn('[VisualEffectController] No element or bounding box provided');
      return;
    }

    // Enqueue event
    let queue: any;
    const unsubscribe = effectQueue.subscribe(q => {
      queue = q;
    });
    unsubscribe();

    queue.enqueue(event);

    // Trigger cursor animation
    if (cursorAnimatorRef && config.enableCursorAnimation) {
      const status = queue.getStatus();

      console.log('[VisualEffectController] Triggering animation to:', x, y, 'cursorAnimatorRef exists:', !!cursorAnimatorRef);

      // Skip animation if queue is very deep (>10 events)
      if (status.size > 10) {
        cursorAnimatorRef.skipTo(x, y);
      } else {
        cursorAnimatorRef.animateTo(x, y);
      }
    } else {
      console.warn('[VisualEffectController] Cannot animate:', {
        cursorAnimatorRef: !!cursorAnimatorRef,
        enableCursorAnimation: config.enableCursorAnimation
      });
    }
  }

  /**
   * Handle agent serialize event (DOM analysis)
   *
   * Triggers undulate effect for 3.5 seconds.
   */
  function handleAgentSerialize() {
    if (waterRipple && config.enableRippleEffects) {
      try {
        waterRipple.undulate();
      } catch (error) {
        handleError('Undulate effect error', error);
      }
    }
  }

  /**
   * Handle takeover button click
   *
   * Removes overlay, allows user to interact with page.
   */
  function handleTakeOver() {
    overlayState.update(state => ({
      ...state,
      visible: false,
      takeoverActive: true,
    }));
    notifyStateChange();
  }

  /**
   * Stop agent session (internal handler)
   *
   * Sends message to service worker to abort running tasks (without clearing history).
   */
  function handleStopAgentButton() {
    try {
      // Use ABORT_TASK instead of STOP_AGENT_SESSION to preserve conversation history
      chrome.runtime.sendMessage({
        type: 'ABORT_TASK',
        source: 'content',
        timestamp: Date.now()
      });
    } catch (error) {
      handleError('Stop agent task error', error);
    }

    handleAgentStop();
  }

  /**
   * Handle viewport resize
   *
   * Recalculates coordinate system for ongoing animations.
   * Water ripple canvas will automatically resize via its own resize handler.
   */
  function handleViewportResize() {
    // Cancel ongoing animations since coordinates may be invalid
    if (cursorAnimatorRef) {
      let state: any;
      const unsubscribe = animationState.subscribe(s => {
        state = s;
      });
      unsubscribe();

      if (state.isAnimating) {
        // Skip to target position to avoid animation to wrong coordinates
        if (state.targetPosition) {
          cursorAnimatorRef.skipTo(state.targetPosition.x, state.targetPosition.y);
        }
      }
    }

    // Water ripple effect handles its own canvas resize
    console.debug('[VisualEffectController] Viewport resized, animations adjusted');
  }

  /**
   * Handle error
   *
   * Logs error and notifies error callbacks.
   * Errors never propagate to DomTool.
   */
  function handleError(context: string, error: any) {
    const errorMessage = `[VisualEffectController] ${context}: ${error?.message ?? error}`;
    console.error(errorMessage, error);

    // Update state with error
    visualEffectState.update(state => ({
      ...state,
      lastError: errorMessage,
    }));

    // Notify error callbacks
    errorCallbacks.forEach(callback => {
      try {
        callback(new Error(errorMessage));
      } catch (cbError) {
        console.error('[VisualEffectController] Error in error callback:', cbError);
      }
    });
  }

  /**
   * Notify state change callbacks
   */
  function notifyStateChange() {
    let state: VisualEffectState;
    const unsubscribe = visualEffectState.subscribe(s => {
      state = s;
    });
    unsubscribe();

    stateChangeCallbacks.forEach(callback => {
      try {
        callback(state);
      } catch (error) {
        console.error('[VisualEffectController] Error in state change callback:', error);
      }
    });
  }

  // Public API exports (for imperative usage)
  export function initialize(userConfig?: VisualEffectConfig): Promise<void> {
    config = { ...DEFAULT_CONFIG, ...userConfig };
    return Promise.resolve();
  }

  export function destroy(): void {
    // Handled by onDestroy
  }

  export function getState(): Readonly<VisualEffectState> {
    let state: VisualEffectState;
    const unsubscribe = visualEffectState.subscribe(s => {
      state = s;
    });
    unsubscribe();
    return state!;
  }

  export function startAgentSession(): void {
    handleAgentStart();
  }

  export function stopAgentSession(): void {
    handleAgentStop();
  }

  export function takeOver(): void {
    overlayState.update(state => ({
      ...state,
      visible: false,
      takeoverActive: true,
    }));
    notifyStateChange();
  }

  export function animateAction(action: string, x: number, y: number): void {
    if (cursorAnimatorRef && config.enableCursorAnimation) {
      cursorAnimatorRef.animateTo(x, y);
    }
  }

  export function undulate(): void {
    handleAgentSerialize();
  }

  export function onStateChange(callback: StateChangeCallback): () => void {
    stateChangeCallbacks.push(callback);
    return () => {
      const index = stateChangeCallbacks.indexOf(callback);
      if (index > -1) {
        stateChangeCallbacks.splice(index, 1);
      }
    };
  }

  export function onCursorUpdate(callback: CursorUpdateCallback): () => void {
    cursorUpdateCallbacks.push(callback);
    return () => {
      const index = cursorUpdateCallbacks.indexOf(callback);
      if (index > -1) {
        cursorUpdateCallbacks.splice(index, 1);
      }
    };
  }

  export function onError(callback: ErrorCallback): () => void {
    errorCallbacks.push(callback);
    return () => {
      const index = errorCallbacks.indexOf(callback);
      if (index > -1) {
        errorCallbacks.splice(index, 1);
      }
    };
  }
</script>

<div class="visual-effect-controller" data-testid="visual-effect-controller">
  <Overlay />
  <CursorAnimator bind:this={cursorAnimatorRef} />
  {#if showControlButtons && !takeoverActive}
    <div class="control-buttons-wrapper">
      <ControlButtons
        on:takeover={handleTakeOver}
        on:stopagent={handleStopAgentButton}
      />
    </div>
  {/if}
</div>

<style>
  .visual-effect-controller {
    /* Container for all visual effects */
    position: fixed;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    z-index: 2147483647;
  }

  .control-buttons-wrapper {
    /* Position */
    position: fixed;
    bottom: 32px; /* Spacing from bottom */
    left: 50%;
    transform: translateX(-50%); /* Center horizontally */
    z-index: 2147483647; /* Same as cursor (highest layer) */

    /* Allow pointer events for buttons */
    pointer-events: all;
  }
</style>
