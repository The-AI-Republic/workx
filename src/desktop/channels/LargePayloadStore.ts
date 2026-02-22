/**
 * LargePayloadStore
 *
 * Workaround for WebView2's postMessage size limit (~1MB).
 * Since TauriChannel and TauriMessageService both run in the same WebView
 * process, large payloads can be stored here and referenced by ID instead
 * of being serialized through Tauri's IPC postMessage.
 */

const store = new Map<string, unknown>();

/** Threshold above which payloads are stored by reference (64 KB — conservative for WebView2) */
export const LARGE_PAYLOAD_THRESHOLD = 64 * 1024;

/** Marker used in Tauri events to indicate a stored payload reference */
export interface PayloadRef {
  __payloadRef: string;
}

export function isPayloadRef(value: unknown): value is PayloadRef {
  return typeof value === 'object' && value !== null && '__payloadRef' in value;
}

/** Store a payload and return its reference ID */
export function storePayload(payload: unknown): string {
  const id = crypto.randomUUID();
  store.set(id, payload);
  return id;
}

/** Retrieve and remove a payload by reference ID */
export function retrievePayload(id: string): unknown {
  const payload = store.get(id);
  store.delete(id);
  return payload;
}
