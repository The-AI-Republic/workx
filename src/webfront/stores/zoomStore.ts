/**
 * Zoom Store for Side Panel UI
 *
 * Manages UI zoom level using a Svelte writable store.
 * Zoom is applied via document.documentElement.style.fontSize (percentage),
 * which scales all rem/em-based sizing.
 *
 * Range: 50–200% in steps of 10. Session-only (not persisted).
 */

import { writable, get } from 'svelte/store';

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;
const DEFAULT_ZOOM = 100;

const _zoomLevel = writable<number>(DEFAULT_ZOOM);

function applyZoom(level: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${level}%`;
}

_zoomLevel.subscribe((level) => {
  applyZoom(level);
});

function clamp(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export const zoomStore = {
  subscribe: _zoomLevel.subscribe,

  zoomIn: () => {
    const current = get(_zoomLevel);
    const next = clamp(current + ZOOM_STEP);
    if (next !== current) _zoomLevel.set(next);
  },

  zoomOut: () => {
    const current = get(_zoomLevel);
    const next = clamp(current - ZOOM_STEP);
    if (next !== current) _zoomLevel.set(next);
  },

  resetZoom: () => {
    _zoomLevel.set(DEFAULT_ZOOM);
  },
};
