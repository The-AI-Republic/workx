/**
 * Zoom Store for Side Panel UI
 *
 * Manages UI zoom level using a Svelte writable store.
 * Zoom is applied via document.documentElement.style.fontSize (percentage),
 * which scales all rem/em-based sizing.
 *
 * Range: 50–200% in steps of 10.
 * Persisted to AgentConfig user preferences.
 */

import { writable, get } from 'svelte/store';
import { AgentConfig } from '@/config/AgentConfig';

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;
const DEFAULT_ZOOM = 100;

const _zoomLevel = writable<number>(DEFAULT_ZOOM);

/**
 * Apply the zoom level to the document root element.
 */
function applyZoom(level: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${level}%`;
}

/**
 * Persist zoom level to AgentConfig preferences.
 */
async function persistZoom(level: number) {
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    await config.updateConfig({
      preferences: { ...agentConfig.preferences, zoomLevel: level },
    });
  } catch (error) {
    console.warn('[ZoomStore] Failed to persist zoom level:', error);
  }
}

// Apply zoom whenever the store value changes
_zoomLevel.subscribe((level) => {
  applyZoom(level);
});

function clamp(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export const zoomStore = {
  subscribe: _zoomLevel.subscribe,

  /**
   * Initialize from stored config value.
   */
  initialize: (stored: number | undefined) => {
    const level = stored != null ? clamp(stored) : DEFAULT_ZOOM;
    _zoomLevel.set(level);
  },

  /**
   * Increase zoom by one step (max 200%).
   */
  zoomIn: () => {
    const current = get(_zoomLevel);
    const next = clamp(current + ZOOM_STEP);
    if (next !== current) {
      _zoomLevel.set(next);
      persistZoom(next);
    }
  },

  /**
   * Decrease zoom by one step (min 50%).
   */
  zoomOut: () => {
    const current = get(_zoomLevel);
    const next = clamp(current - ZOOM_STEP);
    if (next !== current) {
      _zoomLevel.set(next);
      persistZoom(next);
    }
  },

  /**
   * Reset zoom to default (100%).
   */
  resetZoom: () => {
    _zoomLevel.set(DEFAULT_ZOOM);
    persistZoom(DEFAULT_ZOOM);
  },
};
