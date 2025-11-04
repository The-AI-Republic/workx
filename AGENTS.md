# Repository Guidelines

## Project Structure & Module Organization
The Chrome extension source sits in `src/`: `background/` handles the service worker, `content/` drives in-page automation, and `sidepanel/` renders the Svelte UI. Shared logic lives in `src/core/`, `src/tools/`, and `src/utils/`, while prompts and models stay in `src/prompts/` and `src/models/`. Assets ship from `src/static/`, build helpers from `scripts/`, and longer references from `docs/`. Tests mirror the runtime layout under `tests/` (for example `tests/unit/tools/` or `tests/integration/dom-operations/`).

## Build, Test, and Development Commands
- `npm run dev` starts Vite with hot reload for side panel and content scripts.
- `npm run build` executes `scripts/build.js`, outputting `dist/` for `chrome://extensions`.
- `npm run build:testtool` compiles the harness in `tests/tools/e2e/` for manual tool calls.
- `npm test` runs the Vitest suite across DOM, integration, and contract configs.
- `npm run lint`, `npm run type-check`, and `npm run format` must pass before requesting review.

## Coding Style & Naming Conventions
Use two-space indentation, Prettier defaults, and the shared ESLint profile across TypeScript and Svelte files. Favor PascalCase for components, camelCase for functions and variables, and `UPPER_SNAKE_CASE` for constants. Centralize selectors, tool IDs, and protocol strings in `src/tools/` or `src/protocol/`. Tailwind utility classes are preferred; reusable styles live in `src/sidepanel/styles/`.

## Testing Guidelines
Vitest powers the suite with Svelte Testing Library for UI work. Place fast specs in `tests/unit/`, contract or boundary cases in `tests/contract/`, cross-runtime flows in `tests/integration/`, and performance checks in `tests/performance/`. Name files with the `.test.ts` suffix beside the feature folder. Use `npm test -- --watch` for iteration, add fixtures in `tests/fixtures/` for regressions, and assert on DOM effects, agent messaging, and failure handling.

## Commit & Pull Request Guidelines
Commit messages follow a concise, imperative tone (for example, `rename all the codex keyword to browserx`). Keep each commit focused, reference tracking tickets when relevant, and squash fixups locally. Pull requests should describe the scenario, link to issues, and include screenshots or logs for UI or rollout changes. Verify `npm run lint`, `npm run type-check`, and `npm test` before asking for review, and note follow-up tasks or known gaps.

## Security & Configuration Tips
Do not commit API keys, rollout credentials, or personal configuration; keep secrets local and document needed variables in `docs/`. The extension loads keys through the side panel settings, so scrub new logs and telemetry for sensitive data. When touching storage or config, update schemas in `src/config/` and add migration coverage in `tests/storage/`.
