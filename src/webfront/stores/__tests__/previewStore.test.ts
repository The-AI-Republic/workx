import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { Event } from '@/core/protocol/types';
import {
  previewStore,
  activeArtifacts,
  selectedArtifact,
  previewPanelOpen,
  activeArtifactCount,
} from '../previewStore';

function approvalEvent(path: string, patch: string): Event {
  return {
    id: `evt_${path}`,
    msg: { type: 'ApplyPatchApprovalRequest', data: { id: 'a1', path, patch, num_files: 1 } },
  } as unknown as Event;
}

function patchBeginEvent(path: string): Event {
  return {
    id: `evt_pb_${path}`,
    msg: { type: 'PatchApplyBegin', data: { path, num_files: 1 } },
  } as unknown as Event;
}

function turnDiffEvent(diff: string, files: number): Event {
  return {
    id: 'evt_td',
    msg: { type: 'TurnDiff', data: { diff, files_changed: files } },
  } as unknown as Event;
}

const NEW_DOC = `--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+# Notes
+hello
`;

const MOD_CODE = `--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;
`;

describe('previewStore', () => {
  beforeEach(() => {
    previewStore.setActiveSession('s1');
    previewStore.clearSession('s1');
    previewStore.clearSession('s2');
  });

  it('collects an approval patch as an added markdown artifact with extracted content', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    const list = get(activeArtifacts);
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe('notes.md');
    expect(list[0].kind).toBe('markdown');
    expect(list[0].change).toBe('added');
    expect(list[0].content).toBe('# Notes\nhello');
    expect(list[0].diff).toContain('+# Notes');
  });

  it('auto-reveals the panel on the first artifact and auto-selects it', () => {
    expect(get(previewPanelOpen)).toBe(false);
    previewStore.collect('s1', approvalEvent('src/x.ts', MOD_CODE));
    expect(get(previewPanelOpen)).toBe(true);
    expect(get(selectedArtifact)?.path).toBe('src/x.ts');
    expect(get(selectedArtifact)?.change).toBe('modified');
  });

  it('keeps a manual selection sticky as more artifacts arrive', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    previewStore.select('notes.md');
    previewStore.collect('s1', approvalEvent('src/x.ts', MOD_CODE));
    expect(get(selectedArtifact)?.path).toBe('notes.md');
  });

  it('does not downgrade a rich record when a bare PatchApplyBegin follows', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    previewStore.collect('s1', patchBeginEvent('notes.md'));
    const a = get(activeArtifacts).find((x) => x.path === 'notes.md');
    expect(a?.content).toBe('# Notes\nhello'); // preserved, not cleared
    expect(get(activeArtifactCount)).toBe(1); // still one file, not duplicated
  });

  it('ingests a multi-file TurnDiff into one artifact per file', () => {
    previewStore.collect('s1', turnDiffEvent(
      `diff --git a/notes.md b/notes.md\n${NEW_DOC}diff --git a/src/x.ts b/src/x.ts\n${MOD_CODE}`,
      2,
    ));
    expect(get(activeArtifactCount)).toBe(2);
    expect(get(activeArtifacts).map((a) => a.path).sort()).toEqual(['notes.md', 'src/x.ts']);
  });

  it('isolates artifacts by session', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    previewStore.collect('s2', approvalEvent('src/x.ts', MOD_CODE));
    expect(get(activeArtifactCount)).toBe(1); // active is s1
    previewStore.setActiveSession('s2');
    expect(get(activeArtifacts)[0].path).toBe('src/x.ts');
  });

  it('close() hides the panel and suppresses auto-reveal for later artifacts', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    previewStore.close();
    expect(get(previewPanelOpen)).toBe(false);
    previewStore.collect('s1', approvalEvent('src/x.ts', MOD_CODE));
    expect(get(previewPanelOpen)).toBe(false); // stays dismissed
    previewStore.open();
    expect(get(previewPanelOpen)).toBe(true);
  });

  it('clearSession empties the active session and resets panel state', () => {
    previewStore.collect('s1', approvalEvent('notes.md', NEW_DOC));
    previewStore.clearSession('s1');
    expect(get(activeArtifactCount)).toBe(0);
    expect(get(previewPanelOpen)).toBe(false);
  });

  it('ignores non-artifact events', () => {
    previewStore.collect('s1', { id: 'e', msg: { type: 'AgentMessage', data: { message: 'hi' } } } as unknown as Event);
    expect(get(activeArtifactCount)).toBe(0);
  });
});
