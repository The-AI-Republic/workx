/**
 * Desktop Storage (post-Track-43)
 *
 * After the runtime sidecar cutover, the only desktop-side storage helpers
 * left here are the filesystem skill/plugin providers — kept until they're
 * ported to Node and moved into the runtime (see Track 43 P3 tasks).
 *
 * The WebView credential store was deleted: credentials are runtime-owned.
 *
 * @module desktop/storage
 */
