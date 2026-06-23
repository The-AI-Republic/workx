/**
 * DownloadWatcher — surface browser downloads to the agent.
 *
 * Tracks `chrome.downloads.onCreated/onChanged` into a small state machine and
 * emits `started/completed/interrupted` events (with filename + url) so an agent
 * that clicks "Export CSV" can learn whether/where the file landed. Active only
 * while browser control is active (start/stop), per design §3.9.
 *
 * Events are delivered via the injected `emit` callback; the service worker
 * connects this to the session event bus (Session.emitEvent — §1.6 #9), NOT to
 * a per-tool-call onProgress which is gone by the time a download completes.
 *
 * @module extension/background/DownloadWatcher
 */

export type DownloadStatus = 'started' | 'completed' | 'interrupted';

export interface DownloadEvent {
  id: number;
  filename: string;
  url: string;
  status: DownloadStatus;
}

export class DownloadWatcher {
  private readonly tracked = new Map<number, { filename: string; url: string }>();
  private active = false;
  private readonly onCreatedBound = (item: chrome.downloads.DownloadItem) => this.onCreated(item);
  private readonly onChangedBound = (delta: chrome.downloads.DownloadDelta) => this.onChanged(delta);

  constructor(private readonly emit: (event: DownloadEvent) => void) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    chrome.downloads?.onCreated.addListener(this.onCreatedBound);
    chrome.downloads?.onChanged.addListener(this.onChangedBound);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    chrome.downloads?.onCreated.removeListener(this.onCreatedBound);
    chrome.downloads?.onChanged.removeListener(this.onChangedBound);
    this.tracked.clear();
  }

  /** Last-N tracked downloads (for a browser_downloads tool action / tool result). */
  recent(limit = 10): Array<{ id: number; filename: string; url: string }> {
    const entries = [...this.tracked.entries()].slice(-limit);
    return entries.map(([id, v]) => ({ id, ...v }));
  }

  private onCreated(item: chrome.downloads.DownloadItem): void {
    if (!this.active) return;
    const url = item.finalUrl || item.url || '';
    const filename = item.filename || '';
    this.tracked.set(item.id, { filename, url });
    this.emit({ id: item.id, filename, url, status: 'started' });
  }

  private onChanged(delta: chrome.downloads.DownloadDelta): void {
    if (!this.active) return;
    const entry = this.tracked.get(delta.id);
    if (!entry) return;

    if (delta.filename?.current) {
      entry.filename = delta.filename.current;
    }

    const state = delta.state?.current;
    if (state === 'complete') {
      this.emit({ id: delta.id, filename: entry.filename, url: entry.url, status: 'completed' });
      this.tracked.delete(delta.id);
    } else if (state === 'interrupted') {
      this.emit({ id: delta.id, filename: entry.filename, url: entry.url, status: 'interrupted' });
      this.tracked.delete(delta.id);
    }
  }
}
