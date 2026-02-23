# Quickstart: Project Rename Verification

## Pre-Verification (before implementation)

```bash
# Baseline: count current "browserx" references in shared code
grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/ --include="*.ts" | wc -l

# Baseline: confirm tests pass
npm test

# Baseline: confirm build works
npm run build
```

## Post-Implementation Verification

### 1. Core Class Rename

```bash
# Verify old class is gone
grep -r "BrowserxAgent" src/core/ --include="*.ts"
# Expected: 0 results

# Verify new class exists
grep -r "PiAgent" src/core/ --include="*.ts"
# Expected: src/core/PiAgent.ts with class PiAgent

# Verify imports updated
grep -r "BrowserxAgent" src/desktop/ src/extension/ --include="*.ts"
# Expected: 0 results
```

### 2. Shared Code Clean

```bash
# Zero "browserx" in shared directories (case-insensitive)
grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/ --include="*.ts"
# Expected: 0 results
```

### 3. Extension Code Preserved

```bash
# Extension still uses "browserx" naming
grep -r "browserx" src/extension/ --include="*.ts" --include="*.svelte" --include="*.css" | head -5
# Expected: Multiple results (CSS vars, events, etc. — all correct)

# Cursor label capitalized correctly
grep "cursor-label" src/extension/content/ui_effect/CursorAnimator.svelte
# Expected: <div class="cursor-label">BrowserX</div>
```

### 4. Desktop App Branding

```bash
# Tauri config: "Apple Pi" only in user-visible fields
grep -E "productName|title" tauri/tauri.conf.json
# Expected: "Apple Pi" in productName and title only
# shortDescription/longDescription stay as "Pi" (config metadata)

# Desktop HTML title
grep "<title>" src/desktop/index.html
# Expected: <title>Apple Pi</title>

# Desktop prompt says "Apple Pi"
head -1 src/prompts/default_pi_agent_prompt.md
# Expected: "You are Apple Pi..."
```

### 5. Project Config

```bash
# Package name
grep '"name"' package.json
# Expected: "name": "pi"

# Asset renamed
ls src/static/pi_UI.png
# Expected: file exists
```

### 6. Build & Test

```bash
# All tests pass
npm test

# Lint clean
npm run lint

# Build succeeds
npm run build
```
