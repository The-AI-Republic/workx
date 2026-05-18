# Apple Pi Code Mode Claudy Parity

## Claudy Behaviors Checked

1. Workspace root: Apple Pi has `preferences.workspaceRoot`, surfaced in Settings > General and forwarded into file/search tools as the jail anchor.
2. Project instructions: Claudy uses `CLAUDE.md` at the working directory as project-local guidance. Apple Pi now loads `<workspaceRoot>/CLAUDE.md` fresh each turn and appends it to user instructions under `# CLAUDE.md instructions`.
3. Memory scopes: Claudy separates global/private memory from project/team memory. Apple Pi already had global `core-memory.md`; Apple Pi now also creates project-scoped memory at `~/.airepublic-pi/memory/projects/<workspace-key>/project-memory.md` when a workspace is selected, injects it into the prompt, and routes `save_memory` category `project` there.
4. Diff rendering: Claudy renders file edits as structured diffs. Apple Pi now renders fenced `diff`/`patch` code blocks with red deletion and green addition styling, and file edit/write tool results include compact fenced diffs.

## Deliberate Differences

- Apple Pi uses the existing web UI, not a TUI. The reusable rendering point is markdown message rendering.
- Apple Pi project memory is private per local user and workspace. Shared/team sync is not included here.
- Workspace selection is currently a text field. A native folder picker is still a useful follow-up, but the working-root primitive exists and is persisted.
