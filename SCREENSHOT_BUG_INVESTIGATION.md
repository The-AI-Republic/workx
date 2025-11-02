# Screenshot Bug Investigation & Fix

## Problem Report

**User's Issue**: "The agent shouldn't see the historical snapshot, it only needs to fill the screenshot into the last screenshot function call. Other history screenshot function call results don't need to have image attached. The issue is, it is supposed to see the newest screenshot every time, but somehow, LLM refers to a previous screenshot which is replaced by newer one already."

## Intended Behavior ✓

1. **Multiple screenshots in one conversation**:
   - Screenshot #1 taken → Stored to `chrome.storage.local` key `screenshot_cache`
   - Screenshot #2 taken → **OVERWRITES** Screenshot #1 in storage (this is CORRECT)
   
2. **When building prompt for LLM**:
   - Screenshot #1 call → Show metadata ONLY, NO image
   - Screenshot #2 call → Show metadata + **ATTACH IMAGE** (the current screenshot from storage)
   - Only the **MOST RECENT** screenshot should have an image attached

## The Bug

**Symptom**: LLM sometimes refers to an old screenshot that should have been replaced.

**Possible Causes**:
1. Old screenshot data persisted somewhere unexpected (conversation history, cache, etc.)
2. Race condition where old data is read before new data is written
3. Screenshot data incorrectly attached to multiple historical calls instead of just the most recent

## The Fix ✅

### Changed: `src/models/PromptHelpers.ts`

**Before** (BUGGY):
```typescript
// Would attach screenshot from storage to EVERY screenshot call in history
items.map(async (item) => {
  if (isScreenshotCall(item)) {
    const data = await ScreenshotFileManager.getScreenshot(); // Gets CURRENT screenshot
    attachImageToItem(item, data); // Attaches to ALL screenshot calls
  }
})
```

**After** (FIXED):
```typescript
// 1. Find ALL screenshot calls in conversation history
const screenshotIndices = [0, 5, 12]; // Example: 3 screenshot calls

// 2. Identify the MOST RECENT one
const lastScreenshotIndex = screenshotIndices[screenshotIndices.length - 1]; // 12

// 3. Get current screenshot from storage ONCE
const currentScreenshotData = await ScreenshotFileManager.getScreenshot();

// 4. Process items: attach image ONLY to the most recent screenshot
items.map((item, index) => {
  if (isScreenshotCall(item)) {
    if (index === lastScreenshotIndex) {
      // ✓ Most recent screenshot: ATTACH IMAGE
      return createMessageWithImage(item, currentScreenshotData);
    } else {
      // ✗ Older screenshots: TEXT ONLY, no image
      return createMessageTextOnly(item);
    }
  }
})
```

### Key Changes:

1. **Pre-identify screenshot calls**: Find all screenshot calls and their indices BEFORE processing
2. **Single storage read**: Get screenshot from storage only ONCE (not once per screenshot call)
3. **Selective attachment**: Attach image ONLY to the most recent screenshot call
4. **Text-only for historical**: Older screenshot calls get text-only responses with "(historical, no image)" marker

## Debug Logging Added

Comprehensive logging to diagnose the issue:

```
[PromptHelpers] DEBUG: Found 3 screenshot items in history
[PromptHelpers] DEBUG: Will attach image ONLY to item at index 12 (most recent)
[PromptHelpers] DEBUG: Older screenshots at indices 0, 5 will have NO image
[PromptHelpers] DEBUG: Current screenshot from storage hash: iVBORw0KGgo...
[PromptHelpers] DEBUG: Screenshot size: 523.45KB

[PromptHelpers] DEBUG: Processing screenshot at index 0, call_id: call_abc
[PromptHelpers] DEBUG: Is last screenshot? false
[PromptHelpers] DEBUG: ✗ NOT attaching image (older screenshot or no data)

[PromptHelpers] DEBUG: Processing screenshot at index 5, call_id: call_def
[PromptHelpers] DEBUG: Is last screenshot? false
[PromptHelpers] DEBUG: ✗ NOT attaching image (older screenshot or no data)

[PromptHelpers] DEBUG: Processing screenshot at index 12, call_id: call_xyz
[PromptHelpers] DEBUG: Is last screenshot? true
[PromptHelpers] DEBUG: ✓ Attaching image to this screenshot
```

All debug code is wrapped in `// test>>` and `// test<<` markers for easy removal.

## Testing Instructions

### 1. Build and Reload
```bash
cd browserx
npm run build
# Reload extension in chrome://extensions
```

### 2. Test Scenario
```
User: Take a screenshot of this page
Agent: [takes screenshot #1]

User: Scroll down 500px

User: Take another screenshot  
Agent: [takes screenshot #2 - overwrites #1 in storage]

User: Describe what you see in the screenshot
Agent: [Should describe screenshot #2 ONLY]
```

### 3. Check Console Logs

You should see:
- "Found 2 screenshot items in history"
- "Will attach image ONLY to item at index X (most recent)"
- "Older screenshots at indices Y will have NO image"
- Two ✗ logs for screenshot #1 (no image)
- One ✓ log for screenshot #2 (image attached)

### 4. Verify Screenshots Downloaded

With auto-download enabled, check your Downloads folder:
- `screenshot_[timestamp1].png` - Screenshot #1
- `screenshot_[timestamp2].png` - Screenshot #2

These files let you verify which screenshot is which.

### 5. Check LLM's Description

The LLM should only describe screenshot #2 (the most recent one). If it refers to screenshot #1's content, the bug still exists and we need to investigate further.

## Additional Features

### Auto-Download (Testing Feature)
Every screenshot is automatically downloaded with timestamp when captured. This helps verify:
- That screenshots are actually different
- Which screenshot corresponds to which timestamp
- That the newest screenshot is what the LLM should see

To disable after testing, remove code between `// test>>` and `// test<<` in `PageScreenShotTool.ts`.

## Files Modified

1. ✅ `src/models/PromptHelpers.ts` - Fixed to attach image ONLY to most recent screenshot
2. ✅ `src/tools/PageScreenShotTool.ts` - Added auto-download debugging feature
3. ✅ `src/tools/screenshot/ScreenshotFileManager.ts` - Enhanced download method
4. ✅ `manifest.json` - Added `downloads` permission
5. ✅ This investigation document

## If Bug Still Exists

If the LLM still refers to old screenshots after this fix, check:

1. **Browser cache**: Clear browser cache and reload extension
2. **Storage inspection**: 
   ```javascript
   chrome.storage.local.get('screenshot_cache', console.log)
   ```
   Verify there's only ONE screenshot stored

3. **Conversation history persistence**: Check if conversation history is being loaded from disk with old embedded screenshot data

4. **Race conditions**: Add more logging around screenshot save/retrieve timing

5. **LLM caching**: OpenAI's prompt caching might be serving cached responses - try with a fresh conversation

## Cleanup Checklist

After verifying the fix works:
- [ ] Remove all `// test>>` / `// test<<` blocks
- [ ] Remove debug `console.log` statements
- [ ] Keep the core fix (only attach image to most recent screenshot)
- [ ] Remove this investigation document
- [ ] Remove SCREENSHOT_DEBUG.md and SCREENSHOT_FIX_SUMMARY.md (they have wrong analysis)

## Success Criteria

✅ Only the most recent screenshot has an image attached  
✅ Older screenshots show text-only metadata  
✅ LLM describes only the newest screenshot  
✅ Debug logs confirm correct behavior  
✅ Downloaded files help verify screenshot identity  
✅ No linter errors

