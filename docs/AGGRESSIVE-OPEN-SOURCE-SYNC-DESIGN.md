# Aggressive Open Source Sync Strategy

**Status**: Approved for Implementation
**Decision Date**: 2025-01-29

## Decision Summary

1. **Move everything out of `open_source/`** - consolidate to repo root
2. **Open source `src/sidepanel/`** - include in public sync
3. **Simplify `open_source_mapping.json`** - exclusion list only for critical files

---

## Final Architecture

### Before (Current)
```
private-workx/
├── open_source/
│   ├── docs/
│   ├── scripts/
│   ├── src/          # Core code here
│   └── tests/
├── src/
│   └── sidepanel/    # Private UI (separate)
├── package.json
└── ...configs
```

### After (Target)
```
private-workx/
├── docs/             # Merged from open_source/
├── scripts/          # Merged from open_source/
├── src/              # All code consolidated
│   ├── background/
│   ├── config/
│   ├── core/
│   ├── models/
│   ├── sidepanel/    # Now included in sync
│   └── ...
├── tests/            # Merged from open_source/
├── package.json
└── ...configs
```

---

## Exclusion List (open_source_mapping.json)

Only these files/directories will be excluded from public sync:

```json
{
  "sync_exclude": [
    ".env",
    ".env.local",
    ".claude/",
    "node_modules/",
    "dist/",
    ".git/",
    ".github/"
  ]
}
```

---

## Implementation Steps

### Step 1: Merge Directories
```bash
# Merge open_source/src/* into src/ (sidepanel already in src/)
rsync -av open_source/src/ src/

# Merge open_source/tests/* into tests/
rsync -av open_source/tests/ tests/

# Merge open_source/docs/* into docs/
rsync -av open_source/docs/ docs/

# Merge open_source/scripts/* into scripts/
rsync -av open_source/scripts/ scripts/
```

### Step 2: Update open_source_mapping.json
Simplify to exclusion-only config.

### Step 3: Update Sync Workflow
Change from `open_source/` source to repo root with exclusions.

### Step 4: Remove open_source Directory
```bash
rm -rf open_source/
```

### Step 5: Close PR #67 and Re-sync
New sync will include all files properly.

---

## Updated Sync Workflow

```yaml
name: Sync to open source repo

on:
  pull_request:
    types: [closed]
    branches:
      - main

jobs:
  sync:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout private repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Clone public repo
        run: |
          git clone https://x-access-token:${{ secrets.PRIVATE_SYNC_TO_OSS }}@github.com/The-AI-Republic/workx.git public-repo
          cd public-repo
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Sync files from private root to public
        run: |
          # Read exclusions from mapping file
          EXCLUDES=$(jq -r '.sync_exclude[]' open_source_mapping.json 2>/dev/null || echo "")

          # Build rsync exclude args
          RSYNC_ARGS="--exclude .git --exclude .github --exclude node_modules --exclude dist --exclude public-repo"
          for pattern in $EXCLUDES; do
            RSYNC_ARGS="$RSYNC_ARGS --exclude $pattern"
          done

          # Sync entire repo (not just open_source/)
          rsync -av --delete $RSYNC_ARGS ./ public-repo/

      - name: Create branch and PR
        # ... (create PR for review)
```

---

## Verification Checklist

After implementation, verify:
- [ ] `src/` contains all code (including sidepanel)
- [ ] `tests/` contains all tests
- [ ] `docs/` contains all docs
- [ ] `open_source/` directory is deleted
- [ ] `open_source_mapping.json` has simplified exclusion list
- [ ] Sync workflow references repo root, not `open_source/`
- [ ] New sync PR includes `package.json`, `tsconfig.json`, etc.
