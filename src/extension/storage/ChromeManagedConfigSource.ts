/**
 * ChromeManagedConfigSource — admin policy from Chrome enterprise policy.
 *
 * The extension's native managed tier (Track 20). Admins push policy via
 * GPO / Jamf / Workspace / Intune; it arrives read-only in
 * `chrome.storage.managed` per the `managed_storage` manifest schema. This is
 * the browser-extension analog of claudy's HKLM/plist.
 *
 * Fail-open: no managed storage, an empty policy, or a read error yields no
 * policy (never a hard-deny). Reload rides `chrome.storage.onChanged` filtered
 * to the `managed` area — the extension's existing reactive channel.
 *
 * @module extension/storage/ChromeManagedConfigSource
 */

import type { PolicySource, ResolvedPolicy } from '@/core/config/policy';

export class ChromeManagedConfigSource implements PolicySource {
  readonly origin = 'chrome-managed' as const;

  async load(): Promise<ResolvedPolicy | null> {
    try {
      const managed = (
        chrome as unknown as {
          storage?: { managed?: { get(keys: string[]): Promise<Record<string, unknown>> } };
        }
      ).storage?.managed;
      if (!managed) return null;
      const res = await managed.get(['values', 'lockedKeys']);
      // `values` arrives as a JSON-encoded string: Chrome's managed-storage
      // schema dialect rejects boolean `additionalProperties` and has no
      // any-type, so an arbitrary dot-path→value object can't be declared
      // directly in managed-schema.json. A plain object is still accepted
      // defensively (older policy pushes / tests).
      let values: Record<string, unknown> = {};
      if (typeof res.values === 'string' && res.values.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(res.values);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            values = parsed as Record<string, unknown>;
          } else {
            console.warn('[ChromeManagedConfigSource] managed values is not a JSON object — ignoring');
          }
        } catch (parseErr) {
          console.warn('[ChromeManagedConfigSource] managed values is not valid JSON — ignoring:', parseErr);
        }
      } else if (res.values && typeof res.values === 'object' && !Array.isArray(res.values)) {
        values = res.values as Record<string, unknown>;
      }
      const lockedKeys = Array.isArray(res.lockedKeys)
        ? (res.lockedKeys as unknown[]).filter(
            (k): k is string => typeof k === 'string'
          )
        : [];
      if (Object.keys(values).length === 0 && lockedKeys.length === 0) {
        return null;
      }
      return { values, lockedKeys, origin: 'chrome-managed' };
    } catch (err) {
      console.warn('[ChromeManagedConfigSource] managed read failed:', err);
      return null;
    }
  }

  subscribe(onChange: () => void): () => void {
    const onChanged = (
      chrome as unknown as {
        storage?: {
          onChanged?: {
            addListener(cb: (changes: unknown, area: string) => void): void;
            removeListener(cb: (changes: unknown, area: string) => void): void;
          };
        };
      }
    ).storage?.onChanged;
    if (!onChanged) return () => {};
    const handler = (_changes: unknown, area: string) => {
      if (area === 'managed') onChange();
    };
    onChanged.addListener(handler);
    return () => onChanged.removeListener(handler);
  }
}
