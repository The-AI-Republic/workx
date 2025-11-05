/**
 * Browser Console Debug Snippet for Gemini Integration
 *
 * USAGE:
 * 1. Open Chrome DevTools (F12) in your extension's context
 *    - For service worker: chrome://extensions > "Inspect views: service worker"
 *    - For sidepanel: Right-click sidepanel > Inspect
 * 2. Copy and paste this entire script into the Console
 * 3. Press Enter to run
 * 4. Try sending "hi" to the agent
 * 5. Check the console for detailed debug output
 *
 * The script will:
 * - Enable GEMINI_DEBUG logging
 * - Intercept OpenAIResponsesClient method calls
 * - Monitor event flow
 * - Report diagnostic information
 */

(function() {
  console.log('%c=== GEMINI DEBUG SNIPPET ACTIVATED ===', 'color: cyan; font-size: 14px; font-weight: bold');

  // Enable debug logging
  try {
    localStorage.setItem('GEMINI_DEBUG', 'true');
    console.log('%c✅ GEMINI_DEBUG enabled', 'color: green');
  } catch (e) {
    console.warn('Could not set localStorage:', e);
  }

  // Track events
  window.__geminiDebug = {
    events: [],
    textDeltas: [],
    messageItems: [],
    startTime: null,
    endTime: null,
  };

  console.log('%c📊 Event tracker initialized at window.__geminiDebug', 'color: blue');

  // Helper to log with timestamp
  function debugLog(color, label, ...args) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    console.log(`%c[${timestamp}] ${label}`, `color: ${color}`, ...args);
  }

  // Try to intercept the OpenAIResponsesClient if accessible
  function tryInterceptClient() {
    // This might not work if the client is in a different context
    // But we can still monitor console logs

    debugLog('yellow', '🔍 Attempting to find OpenAIResponsesClient...');

    // Check if we can access the client through window
    if (window.OpenAIResponsesClient) {
      debugLog('green', '✅ Found OpenAIResponsesClient on window');

      const originalStreamCompletion = window.OpenAIResponsesClient.prototype.streamCompletion;

      window.OpenAIResponsesClient.prototype.streamCompletion = async function* (...args) {
        debugLog('cyan', '🎬 streamCompletion called');
        window.__geminiDebug.startTime = Date.now();

        const stream = originalStreamCompletion.apply(this, args);

        for await (const event of stream) {
          // Track event
          window.__geminiDebug.events.push({
            type: event.type,
            timestamp: Date.now(),
            data: event,
          });

          // Track specific types
          if (event.type === 'OutputTextDelta') {
            window.__geminiDebug.textDeltas.push(event.delta);
            debugLog('cyan', `📝 TextDelta: "${event.delta}"`);
          } else if (event.type === 'OutputItemDone') {
            debugLog('green', `✅ OutputItemDone: ${event.item?.type}`);
            if (event.item?.type === 'message') {
              window.__geminiDebug.messageItems.push(event.item);
              debugLog('green', `💬 Message: "${event.item.content[0]?.text}"`);
            }
          } else if (event.type === 'Completed') {
            window.__geminiDebug.endTime = Date.now();
            debugLog('blue', '🏁 Completed');
          } else {
            debugLog('gray', `📦 ${event.type}`);
          }

          yield event;
        }

        debugLog('yellow', '⏹️ Stream finished');
      };

      debugLog('green', '✅ Successfully intercepted streamCompletion');
    } else {
      debugLog('yellow', '⚠️ OpenAIResponsesClient not found on window');
      debugLog('yellow', '   Will monitor console logs instead');
    }
  }

  tryInterceptClient();

  // Monitor console.log for Gemini debug output
  const originalLog = console.log;
  console.log = function(...args) {
    // Check if this is a Gemini log
    const firstArg = args[0];
    if (typeof firstArg === 'string' && firstArg.includes('[Gemini]')) {
      // Parse and enhance Gemini logs
      if (firstArg.includes('Text accumulated')) {
        const match = firstArg.match(/total: (\d+) chars/);
        if (match) {
          debugLog('cyan', `📝 Text accumulated: ${match[1]} chars`);
        }
      } else if (firstArg.includes('Emitting OutputItemDone: message')) {
        const match = firstArg.match(/\((\d+) chars\)/);
        debugLog('green', `✅ Message item emitted: ${match ? match[1] + ' chars' : 'unknown'}`);
      } else if (firstArg.includes('Finish reason')) {
        debugLog('yellow', '🏁 Finish reason:', firstArg);
      }
    }

    originalLog.apply(console, args);
  };

  debugLog('green', '✅ Console monitoring active');

  // Add helper commands
  window.__geminiDebug.report = function() {
    console.log('%c=== GEMINI DEBUG REPORT ===', 'color: cyan; font-size: 14px; font-weight: bold');

    const data = window.__geminiDebug;
    const duration = data.endTime ? (data.endTime - data.startTime) : null;

    console.log('%cEvents:', 'color: blue; font-weight: bold');
    console.log(`  Total: ${data.events.length}`);
    console.log(`  By type:`, data.events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {}));

    console.log('%cText Deltas:', 'color: blue; font-weight: bold');
    console.log(`  Count: ${data.textDeltas.length}`);
    console.log(`  Content: "${data.textDeltas.join('')}"`);

    console.log('%cMessage Items:', 'color: blue; font-weight: bold');
    console.log(`  Count: ${data.messageItems.length}`);
    data.messageItems.forEach((item, i) => {
      console.log(`  Message ${i + 1}:`, item.content[0]?.text);
    });

    console.log('%cTiming:', 'color: blue; font-weight: bold');
    if (duration) {
      console.log(`  Duration: ${duration}ms`);
    } else {
      console.log('  Not completed yet');
    }

    console.log('%cDiagnosis:', 'color: blue; font-weight: bold');
    if (data.textDeltas.length > 0 && data.messageItems.length > 0) {
      console.log('%c  ✅ WORKING: Text deltas and message items present', 'color: green');
    } else if (data.textDeltas.length > 0 && data.messageItems.length === 0) {
      console.log('%c  ❌ BROKEN: Text deltas present but NO message items', 'color: red');
      console.log('%c     Problem: Message item creation failing', 'color: yellow');
    } else if (data.textDeltas.length === 0) {
      console.log('%c  ❌ BROKEN: No text deltas received', 'color: red');
      console.log('%c     Problem: API not returning content or parsing failing', 'color: yellow');
    }

    console.log('\nTo see full event details: window.__geminiDebug.events');
    console.log('To reset: window.__geminiDebug.reset()');
  };

  window.__geminiDebug.reset = function() {
    window.__geminiDebug.events = [];
    window.__geminiDebug.textDeltas = [];
    window.__geminiDebug.messageItems = [];
    window.__geminiDebug.startTime = null;
    window.__geminiDebug.endTime = null;
    debugLog('green', '✅ Debug data reset');
  };

  // Instructions
  console.log('\n%c📖 INSTRUCTIONS:', 'color: yellow; font-weight: bold');
  console.log('1. Send a message to the agent (e.g., "hi")');
  console.log('2. Watch the console for debug output');
  console.log('3. Run: %cwindow.__geminiDebug.report()%c to see summary', 'color: cyan', 'color: default');
  console.log('4. Run: %cwindow.__geminiDebug.reset()%c to clear data', 'color: cyan', 'color: default');
  console.log('\n%c✅ Ready to debug!', 'color: green; font-size: 14px; font-weight: bold');

  // Auto-report after 10 seconds if events were captured
  setTimeout(() => {
    if (window.__geminiDebug.events.length > 0) {
      console.log('\n%c📊 Auto-generating report (10s elapsed):', 'color: blue');
      window.__geminiDebug.report();
    }
  }, 10000);

})();
