# DOM Tool Debug Quick Reference

## Quick Console Filters

Copy and paste these into Chrome DevTools Console filter:

### See Everything
```
[Dom
```

### Only Errors and Warnings
```
❌|⚠️
```

### Track Element Lookups
```
[DomSnapshot] Looking up|not found|Found element
```

### Monitor React State
```
React|_valueTracker
```

### Watch Typing Actions
```
TYPE ACTION
```

### See Snapshot Rebuilds
```
BUILD SNAPSHOT
```

### Track Mutations
```
[MutationTracker]
```

## Quick Diagnosis

### "Element not found" Error?

Look for:
```
[DomSnapshot] ❌ node_id "xxx" not found
```

**Fix:** Snapshot is stale, check:
```
[DomSnapshot] Snapshot age: XXXXms
```

---

### Input Not Working?

Look for:
```
[InputExecutor] React would detect change: NO ❌
```

**Fix:** React detection failed, check event dispatch logs

---

### Too Many Rebuilds?

Look for:
```
[MutationTracker] Recorded XXX mutations
```

**Fix:** Page is very dynamic, consider snapshot throttling

---

### Slow Performance?

Look for:
```
[DomTool] Tree stats: { captureTime: XXXXms }
```

**Warning if:** > 2000ms

---

## Log Symbols

| Symbol | Meaning |
|--------|---------|
| ✅ | Success |
| ❌ | Error |
| ⚠️ | Warning |
| 🔍 | Check/Inspect |
| 🔧 | Modify/Fix |
| 📡 | Event |
| ♻️ | Reused |
| ✨ | New |
| 🎯 | Interactive |

## Most Important Logs

When reporting bugs, capture these:

1. **Action start:**
```
[DomTool] ========== TYPE ACTION REQUEST ==========
```

2. **Element lookup:**
```
[DomSnapshot] Looking up element with node_id: xxx
```

3. **Event dispatch:**
```
[InputExecutor] 📡 InputEvent dispatched
```

4. **React state:**
```
[InputExecutor] React would detect change: YES ✅
```

5. **Action result:**
```
[InputExecutor] ========== TYPE ACTION SUCCESS ==========
```

## Common Patterns

### Successful Type Action
```
TYPE ACTION REQUEST → Looking up element → ✅ Found element →
START TYPE ACTION → ✅ Element is typeable → Reset React tracker →
Dispatching events → React would detect: YES ✅ → TYPE ACTION SUCCESS
```

### Failed Lookup
```
TYPE ACTION REQUEST → Looking up element →
❌ node_id "xxx" not found → Error thrown
```

### React Not Detecting
```
START TYPE ACTION → Reset React tracker → Dispatching events →
React would detect: NO ❌ → TYPE ACTION SUCCESS (but no effect)
```

### Stale Snapshot
```
getSnapshot() called → Checking validity →
⚠️ Sample element "xxx" is NOT connected →
⚠️ Snapshot is invalid, rebuilding → BUILD SNAPSHOT
```
