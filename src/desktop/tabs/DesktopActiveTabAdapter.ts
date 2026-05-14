/**
 * DesktopActiveTabAdapter — Tauri-side adapter for ActiveTabService.
 *
 * Status (v1): **inert stub**. The Tauri shell does not yet emit URL-change
 * events that we can subscribe to, so this adapter exists for symmetry with
 * the Chrome adapter and to give the bootstrap a concrete dispose() it can
 * own. As a result, domain-conditional skills are effectively unconditional
 * on desktop today: with no snapshots flowing into ActiveTabService, the
 * SkillDomainFilter never promotes them and they stay dormant.
 *
 * To wire this up properly when the Tauri webview gains URL-change events:
 *   1. Subscribe to the event source
 *   2. Parse the URL into hostname (skip about:/file:/tauri:// schemes)
 *   3. service.setSnapshot({ url, hostname, tabId? })
 *   4. Return a real dispose() that unsubscribes
 */

import type { ActiveTabService } from '@/core/tabs/ActiveTabService';

export function startDesktopActiveTabAdapter(service: ActiveTabService): () => void {
  // Intentionally inert. See file header for activation steps.
  // `service` accepted to keep the call signature stable across targets;
  // touched here so callers know it's deliberately retained.
  void service;
  console.info(
    '[DesktopActiveTabAdapter] inert stub — domain-conditional skills will not activate on desktop',
  );
  return () => undefined;
}
