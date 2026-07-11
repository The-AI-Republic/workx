/**
 * previewStore (WORKXOS-7) — backs the chat Artifact Preview Panel.
 *
 * It projects the same event stream the chat renders into a per-session map of
 * `ArtifactRecord`s (one per file the agent touched), so the panel populates
 * automatically — mirroring how Codex's task sidebar and Cowork's Artifacts
 * pane fill from agent file activity.
 *
 * Data sources (all already reaching the frontend today):
 *   - `ApplyPatchApprovalRequest` → full unified `patch` body (diff + new-file
 *     content) for approval-gated turns.
 *   - `PatchApplyBegin` / `PatchApplyEnd` → touched file path + apply status
 *     (list entry even when auto-approved, though without a diff body).
 *   - `TurnDiff` → whole-turn unified diff (defined in the protocol; once core
 *     emits it, content/diffs richen automatically with no panel change).
 *
 * Cross-component global state, so it follows the traditional writable-store
 * factory convention used by `threadStore.ts`, not component-local runes.
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import type { Event } from '@/core/protocol/types';
import type { ArtifactRecord, ArtifactChange } from '@/types/ui';
import {
  parseUnifiedDiff,
  getAddedFileContent,
  inferArtifactKind,
  type ParsedFileDiff,
} from '../lib/diffParse';

interface PreviewState {
  /** sessionId → (path → record). */
  bySession: Map<string, Map<string, ArtifactRecord>>;
  /** sessionId → selected path. */
  selected: Map<string, string>;
  activeSessionId: string;
  /** Whether the panel is docked-open / overlay-open. */
  open: boolean;
  /** Set once the user explicitly closes, to suppress further auto-open. */
  userDismissed: boolean;
}

/** Sentinel for events that arrive before any thread session id is known. */
const DEFAULT_SESSION = '__default__';

function nowMs(): number {
  return new Date().getTime();
}

function changeForFile(f: ParsedFileDiff): ArtifactChange {
  if (f.isNew) return 'added';
  if (f.isDeleted) return 'deleted';
  return 'modified';
}

function createPreviewStore() {
  const state: PreviewState = {
    bySession: new Map(),
    selected: new Map(),
    activeSessionId: DEFAULT_SESSION,
    open: false,
    userDismissed: false,
  };

  const { subscribe, set } = writable<PreviewState>(state);
  const publish = () => set(state);

  function sessionMap(sessionId: string): Map<string, ArtifactRecord> {
    let m = state.bySession.get(sessionId);
    if (!m) {
      m = new Map();
      state.bySession.set(sessionId, m);
    }
    return m;
  }

  /** Merge new fields into an existing record without clobbering richer data. */
  function upsert(
    sessionId: string,
    path: string,
    patch: Partial<Omit<ArtifactRecord, 'id' | 'path'>>,
  ): void {
    const m = sessionMap(sessionId);
    const id = `${sessionId}::${path}`;
    const existing = m.get(path);
    const next: ArtifactRecord = {
      id,
      path,
      kind: existing?.kind ?? inferArtifactKind(path),
      change: existing?.change ?? 'modified',
      diff: existing?.diff,
      content: existing?.content,
      summary: existing?.summary,
      updatedAt: nowMs(),
      ...cleaned(patch),
    };
    m.set(path, next);

    // Auto-select the first artifact for this session so the viewer is never
    // empty; keep the user's manual selection sticky afterwards.
    if (!state.selected.has(sessionId)) {
      state.selected.set(sessionId, path);
    }
    // Auto-reveal on the first artifact of the active session, unless the user
    // has closed the panel this session.
    if (sessionId === state.activeSessionId && !state.open && !state.userDismissed) {
      state.open = true;
    }
  }

  /** Drop undefined fields so a merge never overwrites good data with nothing. */
  function cleaned<T extends object>(o: T): Partial<T> {
    const out: Partial<T> = {};
    for (const k of Object.keys(o) as Array<keyof T>) {
      if (o[k] !== undefined) out[k] = o[k];
    }
    return out;
  }

  /** Ingest a full unified diff (multi-file) into the session. */
  function ingestDiff(sessionId: string, diff: string, fallbackPath?: string): void {
    const files = parseUnifiedDiff(diff);
    if (files.length === 0 && fallbackPath) {
      upsert(sessionId, fallbackPath, { diff });
      return;
    }
    for (const f of files) {
      const path = f.path || fallbackPath || '(unknown)';
      // Reconstruct this file's diff slice for the viewer.
      const fileDiff = sliceFileDiff(diff, f) ?? diff;
      const added = f.isNew ? getAddedFileContent(f) : null;
      upsert(sessionId, path, {
        change: changeForFile(f),
        diff: fileDiff,
        content: added ?? undefined,
        summary: `+${f.additions} -${f.deletions}`,
      });
    }
  }

  function process(sessionId: string, event: Event): void {
    const msg = event.msg;
    switch (msg.type) {
      case 'ApplyPatchApprovalRequest': {
        const d = msg.data;
        if (d?.patch) ingestDiff(sessionId, d.patch, d.path);
        else if (d?.path) upsert(sessionId, d.path, {});
        break;
      }
      case 'TurnDiff': {
        const d = msg.data;
        if (d?.diff) ingestDiff(sessionId, d.diff);
        break;
      }
      case 'PatchApplyBegin': {
        const d = msg.data;
        if (d?.path) upsert(sessionId, d.path, {});
        break;
      }
      case 'PatchApplyEnd': {
        const d = msg.data;
        if (d?.path) {
          upsert(sessionId, d.path, {
            summary: d.success ? undefined : d.error || 'apply failed',
          });
        }
        break;
      }
      default:
        return; // Not an artifact-bearing event.
    }
    publish();
  }

  return {
    subscribe,

    /** Collect an event into the given session's artifact set. */
    collect(sessionId: string | null, event: Event): void {
      process(sessionId || DEFAULT_SESSION, event);
    },

    /** Point the panel at a session (thread switch). */
    setActiveSession(sessionId: string | null): void {
      state.activeSessionId = sessionId || DEFAULT_SESSION;
      publish();
    },

    /** Select which artifact the viewer shows for the active session. */
    select(path: string): void {
      state.selected.set(state.activeSessionId, path);
      publish();
    },

    open(): void {
      state.open = true;
      state.userDismissed = false;
      publish();
    },

    close(): void {
      state.open = false;
      state.userDismissed = true;
      publish();
    },

    toggle(): void {
      if (state.open) this.close();
      else this.open();
    },

    /** Drop a session's artifacts (e.g. New Conversation / thread close). */
    clearSession(sessionId: string | null): void {
      const sid = sessionId || DEFAULT_SESSION;
      state.bySession.delete(sid);
      state.selected.delete(sid);
      if (sid === state.activeSessionId) {
        state.open = false;
        state.userDismissed = false;
      }
      publish();
    },

    /** Test/debug helper. */
    _snapshot(): PreviewState {
      return get({ subscribe });
    },
  };
}

export const previewStore = createPreviewStore();

/** Artifacts for the active session, newest first. */
export const activeArtifacts: Readable<ArtifactRecord[]> = derived(previewStore, ($s) => {
  const m = $s.bySession.get($s.activeSessionId);
  if (!m) return [];
  return Array.from(m.values()).sort((a, b) => b.updatedAt - a.updatedAt);
});

/** The currently-selected artifact for the active session, if any. */
export const selectedArtifact: Readable<ArtifactRecord | null> = derived(previewStore, ($s) => {
  const m = $s.bySession.get($s.activeSessionId);
  if (!m) return null;
  const path = $s.selected.get($s.activeSessionId);
  if (path && m.has(path)) return m.get(path)!;
  // Fall back to the most recent when the selection is stale/missing.
  const list = Array.from(m.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  return list[0] ?? null;
});

/** Whether the panel should be shown (open AND the active session has content). */
export const previewPanelOpen: Readable<boolean> = derived(previewStore, ($s) => {
  const m = $s.bySession.get($s.activeSessionId);
  return $s.open && !!m && m.size > 0;
});

/** Number of artifacts in the active session (for the toggle badge). */
export const activeArtifactCount: Readable<number> = derived(previewStore, ($s) => {
  return $s.bySession.get($s.activeSessionId)?.size ?? 0;
});

/**
 * Best-effort slice of a single file's diff out of a multi-file unified diff, so
 * the viewer shows only the selected file. Returns null if boundaries can't be
 * found (caller then shows the whole diff).
 */
function sliceFileDiff(diff: string, file: ParsedFileDiff): string | null {
  const lines = diff.split('\n');
  // In git-format diffs each file carries BOTH a `diff --git` and a `--- `
  // header; splitting on both would cut every file after its two header lines.
  // Prefer `diff --git` as the boundary and only fall back to `--- ` for plain
  // unified diffs that lack it.
  const hasGitHeaders = lines.some((l) => l.startsWith('diff --git'));
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (hasGitHeaders ? l.startsWith('diff --git') : l.startsWith('--- ')) starts.push(i);
  });
  if (starts.length <= 1) return null;
  const wanted = file.newPath || file.oldPath || file.path;
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(begin, end).join('\n');
    if (wanted && block.includes(wanted)) return block;
  }
  return null;
}
