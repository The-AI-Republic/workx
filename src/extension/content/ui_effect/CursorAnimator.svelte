<script lang="ts">
  /**
   * Cursor Animator Component
   *
   * Animated cursor using embedded SVG with GPU-accelerated CSS transforms.
   * Animates to click/type/keypress targets using requestAnimationFrame.
   *
   * Features:
   * - 60fps GPU-accelerated animation (CSS transform + RAF)
   * - Dynamic duration scaling (300-1500ms based on distance)
   * - Speed boost when queue depth > 3 (1.5x faster)
   * - Smooth easing curves (easeInOutCubic default)
   * - Embedded SVG cursor (no file loading)
   * - "browserx" label below cursor with capsule design
   *
   * @component
   */

  import { onMount, onDestroy } from 'svelte';
  import { cursorPosition, animationState, effectQueue } from './stores';
  import { POINTING_HAND_SVG } from './assets';
  import { easeInOutCubic, easeOutQuad, linear } from './utils/easingFunctions';
  import { calculateDistance } from './utils/coordinateCalculator';
  import type { CursorPosition } from './contracts/visual-effect-controller';

  // Current cursor position
  let x = 0;
  let y = 0;

  // Animation state
  let isAnimating = false;
  let animationFrameId: number | null = null;

  // Subscribe to stores
  const unsubscribers: Array<() => void> = [];

  onMount(() => {
    // Initialize cursor position to center of viewport (FR-008)
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    cursorPosition.set({
      x: centerX,
      y: centerY,
      timestamp: Date.now(),
    });

    // Subscribe to cursor position
    unsubscribers.push(
      cursorPosition.subscribe(pos => {
        x = pos.x;
        y = pos.y;
      })
    );

    // Subscribe to animation state to trigger animations
    unsubscribers.push(
      animationState.subscribe(state => {
        console.log('[CursorAnimator] animationState changed:', {
          storeIsAnimating: state.isAnimating,
          localIsAnimating: isAnimating,
          willTrigger: state.isAnimating && !isAnimating
        });
        if (state.isAnimating && !isAnimating) {
          startAnimation();
        }
      })
    );
  });

  onDestroy(() => {
    // Clean up subscriptions
    unsubscribers.forEach(unsub => unsub());

    // Cancel ongoing animation
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
    }
  });

  /**
   * Start cursor animation
   *
   * Uses requestAnimationFrame for smooth 60fps animation.
   * Applies easing function to create natural motion.
   */
  function startAnimation() {
    console.log('[CursorAnimator] startAnimation called');

    let state: any;
    const unsubscribe = animationState.subscribe(s => {
      state = s;
    });
    unsubscribe();

    console.log('[CursorAnimator] Animation state:', state);

    if (!state.startPosition || !state.targetPosition || !state.startTime) {
      console.warn('[CursorAnimator] Missing required state:', {
        hasStartPosition: !!state.startPosition,
        hasTargetPosition: !!state.targetPosition,
        hasStartTime: !!state.startTime
      });
      return;
    }

    console.log('[CursorAnimator] Starting animation from', state.startPosition, 'to', state.targetPosition);
    isAnimating = true;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - (state.startTime ?? currentTime);
      const progress = Math.min(elapsed / state.duration, 1);

      // Apply easing function
      const easingFn =
        state.easing === 'easeOutQuad'
          ? easeOutQuad
          : state.easing === 'linear'
            ? linear
            : easeInOutCubic;

      const easedProgress = easingFn(progress);

      // Calculate interpolated position
      const newX =
        (state.startPosition?.x ?? 0) +
        ((state.targetPosition?.x ?? 0) - (state.startPosition?.x ?? 0)) * easedProgress;
      const newY =
        (state.startPosition?.y ?? 0) +
        ((state.targetPosition?.y ?? 0) - (state.startPosition?.y ?? 0)) * easedProgress;

      // Update cursor position
      cursorPosition.set({
        x: newX,
        y: newY,
        timestamp: currentTime,
      });

      // Continue animation or finish
      if (progress < 1) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        // Animation complete
        isAnimating = false;
        animationFrameId = null;

        animationState.update(s => ({
          ...s,
          isAnimating: false,
        }));

        // Trigger ripple effect at target position
        triggerRipple(state.targetPosition?.x ?? 0, state.targetPosition?.y ?? 0);
      }
    };

    animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Trigger ripple effect at target position
   *
   * Dispatches event to trigger water ripple effect when cursor arrives.
   *
   * @param targetX - Target X coordinate
   * @param targetY - Target Y coordinate
   */
  function triggerRipple(targetX: number, targetY: number) {
    const event = new CustomEvent('browserx:trigger-ripple', {
      bubbles: true,
      composed: true,
      detail: { x: targetX, y: targetY },
    });
    document.dispatchEvent(event);
  }

  /**
   * Animate cursor to target position
   *
   * Public API called by VisualEffectController.
   * Calculates duration based on distance and queue depth.
   *
   * @param targetX - Target X coordinate
   * @param targetY - Target Y coordinate
   */
  export function animateTo(targetX: number, targetY: number): void {
    console.log('[CursorAnimator] animateTo called:', targetX, targetY, 'from:', x, y);

    const currentPos: CursorPosition = { x, y, timestamp: Date.now() };
    const targetPos: CursorPosition = { x: targetX, y: targetY, timestamp: Date.now() };

    // Calculate distance
    const distance = calculateDistance(currentPos, targetPos);
    console.log('[CursorAnimator] Distance:', distance);

    // Base duration: 300ms for short distances, up to 1500ms for long distances
    const MIN_DURATION = 300;
    const MAX_DURATION = 1500;
    const baseDuration = Math.min(
      MIN_DURATION + (distance / Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2)) * 1200,
      MAX_DURATION
    );

    // Apply speed boost if queue is deep
    let queue: any;
    const unsubscribe = effectQueue.subscribe(q => {
      queue = q;
    });
    unsubscribe();

    const processingRate = queue?.getProcessingRate() ?? 1.0;
    const duration = baseDuration / processingRate;

    console.log('[CursorAnimator] Setting animation state:', {
      startPosition: currentPos,
      targetPosition: targetPos,
      duration
    });

    // Update animation state
    animationState.set({
      isAnimating: true,
      startPosition: currentPos,
      targetPosition: targetPos,
      startTime: performance.now(),
      duration,
      easing: 'easeInOutCubic',
    });
  }

  /**
   * Skip to target position immediately
   *
   * Used when queue is very deep (>10 events) to prevent animation backlog.
   *
   * @param targetX - Target X coordinate
   * @param targetY - Target Y coordinate
   */
  export function skipTo(targetX: number, targetY: number): void {
    // Cancel ongoing animation
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    // Jump to target
    cursorPosition.set({
      x: targetX,
      y: targetY,
      timestamp: Date.now(),
    });

    // Reset animation state
    animationState.set({
      isAnimating: false,
      startPosition: null,
      targetPosition: null,
      startTime: null,
      duration: 0,
      easing: 'easeInOutCubic',
    });

    // Still trigger ripple effect
    triggerRipple(targetX, targetY);
  }
</script>

<div
  class="cursor-animator"
  style="transform: translate({x}px, {y}px);"
  data-testid="cursor-animator"
>
  <img
    src={POINTING_HAND_SVG}
    alt=""
    class="cursor-icon"
    width="48"
    height="48"
    draggable="false"
  />
  <div class="cursor-label">browserx</div>
</div>

<style>
  .cursor-animator {
    /* Position */
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483647; /* Maximum z-index (above overlay) */

    /* Size (centered on cursor position) */
    width: 48px;
    height: 48px;
    margin-left: -24px; /* Center horizontally */
    margin-top: -24px; /* Center vertically */

    /* Performance - GPU acceleration */
    will-change: transform;
    transform-origin: center center;

    /* Pointer events pass through */
    pointer-events: none;

    /* Prevent flickering */
    backface-visibility: hidden;
    -webkit-font-smoothing: antialiased;
  }

  .cursor-icon {
    width: 100%;
    height: 100%;
    display: block;

    /* Prevent drag/select */
    user-select: none;
    -webkit-user-drag: none;

    /* Performance */
    image-rendering: crisp-edges;
    image-rendering: -webkit-optimize-contrast;
  }

  .cursor-label {
    /* Position below the cursor icon */
    position: absolute;
    top: 48px; /* Position below the 48px cursor icon */
    left: 50%;
    transform: translateX(-50%); /* Center horizontally */

    /* Visual appearance - capsule shape */
    background-color: #000000;
    color: #ffffff;
    padding: 4px 12px;
    border-radius: 12px; /* Capsule shape */

    /* Typography */
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;

    /* Prevent drag/select */
    user-select: none;
    pointer-events: none;

    /* Performance */
    backface-visibility: hidden;
    -webkit-font-smoothing: antialiased;
  }
</style>
