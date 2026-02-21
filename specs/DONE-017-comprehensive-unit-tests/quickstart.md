# Quickstart: Comprehensive Unit Tests & CI Pipeline

## Prerequisites

- Node.js 18+
- npm (with package-lock.json)
- Git

## Running Tests Locally

```bash
# Install dependencies
npm install

# Run full test suite once
npm run test:all

# Run tests in watch mode (development)
npm test

# Run tests with coverage report
npm run test:all -- --coverage

# Run a specific test file
npx vitest run src/core/__tests__/Session.test.ts

# Run tests matching a pattern
npx vitest run --reporter=verbose "BrowserxAgent"
```

## Viewing Coverage Reports

After running with `--coverage`, reports are generated in:
- `coverage/` directory (HTML report)
- Open `coverage/index.html` in a browser to view

## Test File Conventions

All tests are co-located with their source modules:

```
src/core/Session.ts           → src/core/__tests__/Session.test.ts
src/tools/BaseTool.ts         → src/tools/__tests__/BaseTool.test.ts
src/config/AgentConfig.ts     → src/config/__tests__/AgentConfig.test.ts
```

Test file naming:
- Unit tests: `*.test.ts`
- Integration tests: `*.integration.test.ts`
- Contract tests: `*.contract.test.ts`
- Performance tests: `*.perf.test.ts`

## Adding a New Test

1. Create `__tests__/` directory next to the source file (if absent)
2. Create `ModuleName.test.ts` in that directory
3. Import from the source using relative paths or `@/` aliases
4. Use `vi.mock()` for external dependencies

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyModule } from '../MyModule';

describe('MyModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should do something', () => {
    const result = new MyModule();
    expect(result).toBeDefined();
  });
});
```

## Shared Test Utilities

Shared mocks and fixtures live in `src/__test-utils__/`:

```typescript
// Use Chrome storage mock
import { mockChromeStorage } from '@/__test-utils__/chrome-storage-mock';

// Global setup is automatic via vitest.config.mjs setupFiles
// Chrome APIs (runtime, storage, tabs) are mocked globally
```

## CI Pipeline

The GitHub Actions CI pipeline runs automatically on:
- New pull request opened against `pi-dev`
- New commit pushed to an open PR
- PR reopened

Pipeline steps:
1. Lint (`npm run lint`)
2. Type check (`npm run type-check`)
3. Test with coverage (`npm run test:all -- --coverage`)
4. Upload coverage report as artifact

View CI results on the GitHub PR page under "Checks".

## Troubleshooting

**Tests fail with "chrome is not defined"**:
The global setup file should mock Chrome APIs. Ensure
`vitest.config.mjs` has `setupFiles: ['src/__test-utils__/setup.ts']`.

**Import alias `@/` not resolving**:
Check that `vitest.config.mjs` resolve aliases match `tsconfig.json`
path mappings.

**Coverage below 70%**:
Run `npm run test:all -- --coverage` and check `coverage/index.html`
to identify untested code paths.
