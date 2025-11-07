# Developer Quickstart: Improved DOM Serialization

**Feature**: 008-improve-dom-serialization
**Date**: 2025-11-07

## Overview

This guide helps developers set up, test, and debug the improved DOM serialization feature. Follow these steps to validate changes and verify success criteria.

## Prerequisites

- Node.js 18+ installed
- Chrome/Edge browser installed
- Git repository cloned
- On feature branch: `008-improve-dom-serialization`

---

## Setup

### 1. Install Dependencies

```bash
cd /home/rich/dev/airepublic/open_source/s1/browserx
npm install
```

### 2. Verify Branch

```bash
git branch --show-current
# Should output: 008-improve-dom-serialization
```

### 3. Run Baseline Tests

```bash
npm test
# Expected: 71/77 tests passing (current baseline)
```

---

## Development Workflow

### File Organization

**Core Files to Modify**:
```
src/tools/dom/
├── types.ts                            # Add "data-testid" field
├── utils.ts                            # Modify serializedNodeToHtml()
├── DomSnapshot.ts                      # Integrate new simplifiers
└── serializers/
    └── simplifiers/
        ├── LayoutSimplifier.ts         # Enhance with container hoisting
        ├── ClickableTextAggregator.ts  # NEW
        └── AriaLabelCleaner.ts         # NEW
```

**Test Files to Create/Modify**:
```
tests/tools/dom/__tests__/
├── DomSnapshot.test.ts                 # Add integration test cases
├── utils.test.ts                       # Add HTML rendering test cases
├── ClickableTextAggregator.test.ts     # NEW
├── AriaLabelCleaner.test.ts            # NEW
└── LayoutSimplifier.test.ts            # NEW or modify existing
```

### Development Loop

1. **Make Changes**: Edit source files in `src/tools/dom/`
2. **Run Tests**: `npm test -- --watch` (continuous testing)
3. **Type Check**: `npm run type-check` (validate TypeScript)
4. **Lint**: `npm run lint` (code quality)
5. **Build**: `npm run build` (compile extension)

---

## Testing

### Unit Tests

**Run All Tests**:
```bash
npm test
```

**Run Specific Test File**:
```bash
npm test -- ClickableTextAggregator.test.ts
```

**Run Tests in Watch Mode**:
```bash
npm test -- --watch
```

**Run Tests with Coverage**:
```bash
npm test -- --coverage
```

### Integration Testing

**Test on Real Web Pages**:

1. **Build Extension**:
   ```bash
   npm run build
   ```

2. **Load Unpacked Extension**:
   - Open Chrome/Edge
   - Navigate to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select `browserx/dist` directory

3. **Test on Target Sites**:
   - Navigate to X.com (https://x.com)
   - Open extension side panel
   - Execute DOM snapshot
   - Inspect serialized output in console

### Debug Output

**Enable Debug Logging** (DomSnapshot.ts lines 87-120):

The code already has debug console.log statements:
```typescript
console.log('$$$ the virtual dom is:', JSON.stringify(this.virtualDom, null, 2));
console.log('$$$ the result of the serialization pipeline is:', JSON.stringify(result, null, 2));
console.log('$$$ the document node is:', JSON.stringify(documentNode, null, 2));
console.log('$$$ the body before filter is:', JSON.stringify(bodyBeforeFilter, null, 2));
console.log('$$$ the final serlized dom body is:', JSON.stringify(body, null, 2));
console.log('$$$ the HTML representation is:\n', htmlString);
```

**View Debug Output**:
1. Open Chrome DevTools (F12)
2. Navigate to Console tab
3. Execute DOM snapshot action
4. Inspect logged JSON objects

**Save Debug Output to Files**:

Already configured in code (DomSnapshot.ts):
- `.debug/x_com_serialized_node.json` - Final serialized JSON
- `.debug/x_com_serialized_node.html` - HTML representation

---

## Validation Checklist

### Success Criteria Validation

#### SC-001: Token Count Reduction (30%)

**Measurement**:
```bash
# Navigate to X.com in browser with extension loaded
# Execute snapshot, then run in console:

# Before optimization (baseline)
const beforeSize = JSON.stringify(baselineSnapshot).length;

# After optimization (this feature)
const afterSize = JSON.stringify(optimizedSnapshot).length;

# Calculate reduction
const reduction = ((beforeSize - afterSize) / beforeSize * 100).toFixed(1);
console.log(`Token reduction: ${reduction}%`);

# Expected: ≥30%
```

#### SC-002: Nesting Depth Reduction (Max 8 Levels)

**Measurement**:
```typescript
// Add to test file or console
function measureDepth(node: SerializedNode, depth = 0): number {
  if (!node.kids || node.kids.length === 0) return depth;
  return Math.max(...node.kids.map(kid => measureDepth(kid, depth + 1)));
}

const maxDepth = measureDepth(serializedDom.page.body);
console.log(`Max nesting depth: ${maxDepth}`);

// Expected: ≤8
```

#### SC-003: Clickable Text Aggregation (100%)

**Validation**:
```typescript
// Scan for nested spans in clickable elements
function hasNestedSpans(node: SerializedNode): boolean {
  if (isClickable(node) && node.kids) {
    for (const kid of node.kids) {
      if (kid.tag === 'span') return true;
    }
  }
  if (node.kids) {
    return node.kids.some(hasNestedSpans);
  }
  return false;
}

const hasNested = hasNestedSpans(serializedDom.page.body);
console.log(`Has nested spans in clickable elements: ${hasNested}`);

// Expected: false (no nested spans in clickable elements)
```

#### SC-004: Text Node Aria-Label Removal (100%)

**Validation**:
```typescript
// Grep for aria_label in text nodes
function findTextNodeAriaLabels(node: SerializedNode): string[] {
  const results: string[] = [];

  if (node.tag === '#text' && node.aria_label) {
    results.push(`node_id: ${node.node_id}, aria_label: ${node.aria_label}`);
  }

  if (node.kids) {
    node.kids.forEach(kid => results.push(...findTextNodeAriaLabels(kid)));
  }

  return results;
}

const violations = findTextNodeAriaLabels(serializedDom.page.body);
console.log(`Text nodes with aria-labels: ${violations.length}`);
console.log(violations);

// Expected: 0 violations
```

#### SC-005: Performance Overhead (<10%)

**Benchmark**:
```typescript
// Add to DomSnapshot.test.ts
import { describe, it, expect } from 'vitest';

describe('Performance', () => {
  it('should maintain serialization performance', async () => {
    const iterations = 10;
    const results: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await domSnapshot.serialize();
      const duration = performance.now() - start;
      results.push(duration);
    }

    const avgDuration = results.reduce((a, b) => a + b) / iterations;
    console.log(`Average serialization time: ${avgDuration.toFixed(2)}ms`);

    // Baseline: ~100ms for 1000-node tree
    // Target: <110ms (10% overhead)
    expect(avgDuration).toBeLessThan(110);
  });
});
```

#### SC-006: Test Pass Rate (100%)

**Validation**:
```bash
npm test

# Expected output:
# Test Files  N passed (N)
#      Tests  71 passed (77)
```

#### SC-007: Manual Quality Check

**Sites to Test**:
1. **X.com** (https://x.com) - Nested divs, clickable spans
2. **GitHub** (https://github.com) - Code blocks, navigation
3. **Gmail** (https://gmail.com) - Complex SPA, nested containers
4. **Wikipedia** (https://en.wikipedia.org) - Traditional content, tables
5. **Amazon** (https://amazon.com) - Product listings, filters

**Quality Criteria**:
- ✅ Page structure preserved
- ✅ Clickable elements identifiable
- ✅ Text content readable
- ✅ No semantic information lost
- ✅ HTML output clean (no `<#text>` tags)

---

## Debugging

### Common Issues

#### Issue: Tests Failing

**Symptoms**: `npm test` shows failures

**Diagnosis**:
```bash
npm test -- --reporter=verbose
# Shows detailed error messages
```

**Solutions**:
- Check TypeScript compilation: `npm run type-check`
- Verify test fixtures exist
- Compare expected vs actual output

#### Issue: Type Errors

**Symptoms**: `npm run type-check` shows errors

**Diagnosis**:
```bash
npm run type-check > type-errors.txt
# Review errors in file
```

**Solutions**:
- Ensure `"data-testid"` field is quoted in SerializedNode interface
- Verify all new files have proper type imports
- Check for missing type annotations

#### Issue: Serialization Not Working

**Symptoms**: Debug output shows unchanged structure

**Diagnosis**:
1. Check if simplifiers are registered in SerializationPipeline
2. Verify simplifier logic is executing (add console.log)
3. Inspect pipeline result object

**Solutions**:
- Ensure new simplifiers are instantiated in SerializationPipeline
- Check simplifier execution order
- Verify tree modifications are in-place

### Debug Tools

**Chrome DevTools**:
```javascript
// In browser console with extension loaded

// Inspect serialized DOM
window.__browserxDebug = {
  virtualDom: null,
  serializedDom: null
};

// Capture snapshots
domService.buildSnapshot().then(snapshot => {
  window.__browserxDebug.virtualDom = snapshot.virtualDom;
  window.__browserxDebug.serializedDom = snapshot.serialize();
  console.log('Debug data captured');
});
```

**Vitest UI**:
```bash
npm test -- --ui
# Opens browser-based test explorer
```

---

## Code Review Checklist

Before submitting PR, verify:

- [ ] All tests passing (`npm test`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] No linting errors (`npm run lint`)
- [ ] Code formatted (`npm run format`)
- [ ] Success criteria validated (see checklist above)
- [ ] Debug console.log statements removed or commented
- [ ] Documentation updated (if public API changed)
- [ ] Git branch is `008-improve-dom-serialization`

---

## Performance Profiling

### Benchmark Serialization

**Create Benchmark Test** (`tests/tools/dom/__tests__/performance.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { DomSnapshot } from '../DomSnapshot';
import { createMockVirtualDom } from '../fixtures/mockDom';

describe('Serialization Performance', () => {
  it('should serialize 1000-node tree in <110ms', async () => {
    const virtualDom = createMockVirtualDom(1000); // 1000 nodes
    const snapshot = new DomSnapshot(virtualDom, mockPageContext, mockStats);

    const start = performance.now();
    const serialized = snapshot.serialize();
    const duration = performance.now() - start;

    console.log(`Serialization time: ${duration.toFixed(2)}ms`);
    console.log(`Nodes: ${countNodes(serialized.page.body)}`);
    console.log(`JSON size: ${JSON.stringify(serialized).length} bytes`);

    expect(duration).toBeLessThan(110); // <10% overhead from 100ms baseline
  });
});

function countNodes(node: SerializedNode): number {
  return 1 + (node.kids?.reduce((sum, kid) => sum + countNodes(kid), 0) || 0);
}
```

### Memory Profiling

**Chrome DevTools Heap Snapshot**:
1. Open Chrome DevTools
2. Go to Memory tab
3. Take heap snapshot before snapshot
4. Execute DOM snapshot
5. Take heap snapshot after snapshot
6. Compare memory usage

**Expected**: <10% increase in heap size

---

## Resources

- **Spec Document**: `specs/008-improve-dom-serialization/spec.md`
- **Implementation Plan**: `specs/008-improve-dom-serialization/plan.md`
- **Research Notes**: `specs/008-improve-dom-serialization/research.md`
- **Data Model**: `specs/008-improve-dom-serialization/data-model.md`
- **Vitest Documentation**: https://vitest.dev
- **TypeScript Handbook**: https://www.typescriptlang.org/docs/handbook/intro.html
- **Chrome CDP**: https://chromedevtools.github.io/devtools-protocol/

---

## Next Steps

After completing development:

1. **Run Full Test Suite**: `npm test`
2. **Validate Success Criteria**: Use validation checklist above
3. **Manual Testing**: Test on 5 target websites
4. **Performance Benchmark**: Verify <10% overhead
5. **Code Review**: Self-review against checklist
6. **Create PR**: Push to GitHub and create pull request

---

## Support

For questions or issues:
- **Code Issues**: Review existing `src/tools/dom/` implementation
- **Test Issues**: Reference existing test files in `tests/tools/dom/__tests__/`
- **Architecture Questions**: See `specs/008-improve-dom-serialization/plan.md`
