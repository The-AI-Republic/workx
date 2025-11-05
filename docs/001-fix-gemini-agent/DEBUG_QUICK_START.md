# Quick Start: Debug Gemini Integration Issue

Three debugging approaches, from quickest to most comprehensive.

---

## 🚀 Option 1: Quick Browser Console Check (30 seconds)

**Best for**: Immediate runtime diagnosis in the actual extension.

### Steps:
1. Open your Chrome extension
2. Open DevTools (F12) on the extension context:
   - For service worker: `chrome://extensions` > "Inspect views: service worker"
   - For sidepanel: Right-click sidepanel > Inspect
3. Copy the entire contents of `BROWSER_DEBUG_SNIPPET.js`
4. Paste into Console and press Enter
5. Send "hi" message to the agent
6. Wait 10 seconds or run: `window.__geminiDebug.report()`

### What you'll see:
```javascript
=== GEMINI DEBUG REPORT ===
Events: 5
Text Deltas: 3 ["H", "i", "!"]
Message Items: 1 ✅ or 0 ❌
Diagnosis: WORKING ✅ or BROKEN ❌
```

### Interpretation:
- **✅ Text deltas AND message items**: Fix is working! Issue elsewhere.
- **❌ Text deltas but NO message items**: Message creation failing.
- **❌ No text deltas**: API not returning content or parsing broken.

---

## 🧪 Option 2: Isolated Node.js Test (2 minutes)

**Best for**: Testing the client in isolation without browser complexity.

### Steps:
```bash
# 1. Set API key
export GOOGLE_AI_STUDIO_API_KEY=your_key_here
export GEMINI_DEBUG=true

# 2. Run debug script
npx tsx debug-gemini.ts
```

### What you'll see:
Color-coded output showing:
- ✅ Client creation
- ✅ State verification (chatCompletionTextContent exists)
- 📝 Each event received
- 💬 Message items created
- 📊 Detailed analysis
- 🏁 Final diagnosis

### Interpretation:
- Script will explicitly tell you what's broken and where to look.
- Exit code 0 = working, exit code 1 = broken.

---

## 📋 Option 3: Full Manual Investigation (30+ minutes)

**Best for**: When Options 1 & 2 don't reveal the issue, or you need deep investigation.

### Steps:
Follow `DEBUG_PLAN.md` systematically:

1. **Phase 1**: Verify code path execution
2. **Phase 2**: Inspect event conversion
3. **Phase 3**: Trace event flow
4. **Phase 4**: Check state reset
5. **Phase 5**: API response validation
6. **Phase 6**: Silent error detection
7. **Phase 7**: Compare OpenAI vs Gemini
8. **Phase 8**: Integration test
9. **Phase 9**: Provider detection
10. **Phase 10**: Build/deployment issues

Each phase has specific logging points and diagnostic commands.

---

## 🎯 Recommended Workflow

### For Initial Diagnosis:
```
Start with Option 1 (Browser Console)
  ↓
If inconclusive → Try Option 2 (Node.js test)
  ↓
If still unclear → Follow Option 3 (Full investigation)
```

### Quick Decision Tree:

```
Does GEMINI_DEBUG show any logs?
  ├─ NO → Problem: Code not executing
  │         Action: Check Phase 1 & 9 (provider detection)
  │
  └─ YES → Are text deltas being accumulated?
           ├─ NO → Problem: API response parsing
           │        Action: Check Phase 2 & 5
           │
           └─ YES → Are message items being created?
                    ├─ NO → Problem: Message creation logic
                    │        Action: Check Phase 2 & 3
                    │
                    └─ YES → Are events reaching TurnManager?
                             ├─ NO → Problem: Event flow
                             │        Action: Check Phase 3
                             │
                             └─ YES → Problem: TurnManager handling
                                      Action: Debug TurnManager
```

---

## 📊 Data to Collect

No matter which option you choose, gather these key data points:

### 1. Provider Configuration
```javascript
// In browser console:
chrome.storage.local.get(['selectedProvider', 'providers'], console.log);
```

Expected: `wire_api: "ChatCompletions"`

### 2. Event Sequence
Record the exact sequence of events received:
- How many OutputTextDelta events?
- Any OutputItemDone events?
- What's in each OutputItemDone item?

### 3. State at Finish
What's in `chatCompletionTextContent` when finish_reason='stop'?
- Empty? → Text not accumulating
- Has text? → Accumulation works, but message item creation fails

### 4. Error Messages
Any errors or warnings in console?
- Silent failures?
- Type errors?
- API errors?

---

## 🐛 Common Issues & Quick Fixes

### Issue 1: "No logs appear"
**Cause**: GeminiLogger not enabled
**Fix**:
```javascript
localStorage.setItem('GEMINI_DEBUG', 'true');
// Reload extension
```

### Issue 2: "Wrong API being called"
**Cause**: Provider wire_api not set to "ChatCompletions"
**Fix**: Update provider configuration in settings

### Issue 3: "Text accumulates but no message item"
**Cause**: finish_reason handler not executing or not yielding
**Fix**: Check line ~785 in OpenAIResponsesClient.ts

### Issue 4: "No text deltas received"
**Cause**: Gemini API response format different than expected
**Fix**: Check Phase 5 (API response validation)

### Issue 5: "Tests pass but production broken"
**Cause**: Stale build or different code path
**Fix**:
```bash
rm -rf dist/ node_modules/.cache/
npm run build
# Reload extension
```

---

## 📝 Report Template

After debugging, fill this out:

```markdown
## Debug Report

**Date**: YYYY-MM-DD
**Method Used**: Browser Console / Node.js / Manual

### Environment
- Chrome Version:
- Extension Version:
- API Key: (present? length?)

### Results
- GEMINI_DEBUG logs visible: YES / NO
- Provider wire_api: _________
- Text deltas received: __ (count)
- Message items created: __ (count)
- Events sequence: [list types]

### Root Cause
[What's actually broken]

### Evidence
[Screenshots, logs, or code snippets]

### Next Steps
[What needs to be fixed]
```

---

## 💡 Pro Tips

1. **Always check provider config first** - 90% of issues are misconfiguration
2. **Enable GEMINI_DEBUG early** - Don't fly blind
3. **Test with simple message ("hi")** - Don't complicate debugging
4. **Compare with working provider** - OpenAI as reference
5. **Clear browser cache** - Stale code can mislead

---

## 🆘 Need Help?

If none of these methods reveal the issue:

1. Capture full console output (with GEMINI_DEBUG=true)
2. Capture network tab showing Gemini API requests/responses
3. Export the debug report using the template above
4. Share findings with team

The issue MUST be in one of these areas:
- Provider configuration ← Start here
- Code not executing ← Check build
- API response parsing ← Check Phase 5
- Message creation logic ← Check Phase 2
- Event flow to TurnManager ← Check Phase 3
- TurnManager handling ← Outside OpenAIResponsesClient

---

**Good luck! 🚀**
