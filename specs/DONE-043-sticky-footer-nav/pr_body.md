## Summary

- **Persistent footer nav**: Move FooterBar from Chat page to AppShell layout so it renders on every page in narrow mode (Chat, Scheduler, Skills, SchedulerCalendar)
- **Layout fix**: Change page root containers from `h-screen` to `h-full` so pages fill the constrained content area above the footer rather than claiming full viewport height
- **No changes to FooterBar.svelte itself** — it already handles wide/narrow modes correctly

## Completed Tasks (T001-T010)

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 2: Foundational | T001-T002 | Move FooterBar to AppShell, remove from Chat/Main.svelte |
| Phase 3: US1 - Persistent nav | T003-T005 | Change h-screen to h-full in Chat, Scheduler, Skills |
| Phase 4: US2 - No overlap | T006-T007 | Verify overflow handling and scroll behavior |
| Phase 5: Polish | T008-T010 | Verify wide mode unchanged, themes correct, all tests pass |

## Files Changed (4 files)

- `src/webfront/components/layout/AppShell.svelte` — Add FooterBar with flex-col layout
- `src/webfront/pages/chat/Main.svelte` — Remove FooterBar import/usage, h-screen -> h-full
- `src/webfront/pages/scheduler/Scheduler.svelte` — h-screen -> h-full
- `src/webfront/pages/skills/Skills.svelte` — h-screen -> h-full

## Test plan

- [x] All 245 test files pass (7279 tests)
- [ ] Manual: Navigate to Chat, Scheduler, Skills in narrow mode — footer visible on all pages
- [ ] Manual: Click each nav icon — navigation works, active state highlights correctly
- [ ] Manual: Scroll to bottom of each page — no content hidden behind footer
- [ ] Manual: Wide mode (>=1500px) — sidebar renders, no layout regressions
- [ ] Manual: Both terminal and modern themes render footer correctly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
