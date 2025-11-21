/**
 * Test file to demonstrate scroll verification functionality
 *
 * This shows how the scroll action now returns detailed information about:
 * - Previous scroll position
 * - Current scroll position
 * - Actual scroll delta (how much actually scrolled)
 * - Whether scroll limit was reached
 */

import type { ActionResult } from './src/types/domTool';

// Example response when scroll is successful
const successfulScroll: ActionResult = {
  success: true,
  duration: 523,
  changes: {
    navigationOccurred: false,
    domMutations: 1,
    scrollChanged: true,
    previousScrollPosition: { x: 0, y: 0 },
    currentScrollPosition: { x: 0, y: 800 },
    actualScrollDelta: { x: 0, y: 800 },
    scrollLimitReached: false,
    valueChanged: false
  },
  nodeId: -1,
  actionType: 'scroll',
  timestamp: new Date().toISOString()
};

// Example response when already at bottom (scroll failed)
const scrollAtBottom: ActionResult = {
  success: true,
  duration: 520,
  changes: {
    navigationOccurred: false,
    domMutations: 0,
    scrollChanged: false, // ← No change occurred
    previousScrollPosition: { x: 0, y: 2400 },
    currentScrollPosition: { x: 0, y: 2400 },
    actualScrollDelta: { x: 0, y: 0 }, // ← Zero delta
    scrollLimitReached: true, // ← Hit the limit
    valueChanged: false
  },
  nodeId: -1,
  actionType: 'scroll',
  timestamp: new Date().toISOString()
};

// Example response when scrolling up from middle of page
const scrollUpSuccess: ActionResult = {
  success: true,
  duration: 515,
  changes: {
    navigationOccurred: false,
    domMutations: 1,
    scrollChanged: true,
    previousScrollPosition: { x: 0, y: 1200 },
    currentScrollPosition: { x: 0, y: 600 },
    actualScrollDelta: { x: 0, y: -600 }, // ← Negative delta (scrolled up)
    scrollLimitReached: false,
    valueChanged: false
  },
  nodeId: -1,
  actionType: 'scroll',
  timestamp: new Date().toISOString()
};

// Helper function to interpret scroll result
function interpretScrollResult(result: ActionResult): string {
  if (!result.changes.scrollChanged) {
    if (result.changes.scrollLimitReached) {
      return 'Scroll failed: Already at the limit (top/bottom/left/right)';
    }
    return 'Scroll failed: Position did not change';
  }

  const delta = result.changes.actualScrollDelta!;
  const direction = delta.y > 0 ? 'down' : delta.y < 0 ? 'up' : 'horizontally';
  const amount = Math.abs(delta.y || delta.x);

  let message = `Scrolled ${direction} by ${amount}px`;

  if (result.changes.scrollLimitReached) {
    message += ' (reached scroll limit)';
  }

  return message;
}

// Test interpretations
console.log('Test 1:', interpretScrollResult(successfulScroll));
// Output: "Scrolled down by 800px"

console.log('Test 2:', interpretScrollResult(scrollAtBottom));
// Output: "Scroll failed: Already at the limit (top/bottom/left/right)"

console.log('Test 3:', interpretScrollResult(scrollUpSuccess));
// Output: "Scrolled up by 600px"
