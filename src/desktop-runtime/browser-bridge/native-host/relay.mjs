#!/usr/bin/env node
/**
 * WorkX native-messaging ↔ app-server WS relay.
 *
 * Chrome spawns this process (per the native-messaging host manifest) when the
 * extension calls `chrome.runtime.connectNative('com.workx.desktop')`. It bridges
 * two transports:
 *
 *   Chrome  ⇄  (native-messaging stdio framing)  ⇄  THIS RELAY  ⇄  (WebSocket)  ⇄  desktop app-server
 *
 * Why a relay at all: the WorkX desktop is a long-lived process; Chrome can only
 * spawn a *new* short-lived host over stdio. So this host forwards frames to the
 * already-running app-server (ws://127.0.0.1:<port>) and pipes results back.
 *
 * Security / pairing: the extension→relay hop is authorized by Chrome via the
 * manifest's `allowed_origins` (the pinned extension id). The relay→app-server
 * hop uses the capability token the desktop writes to a 0600 local file — so the
 * user never copies a token, and no token is exposed to the browser. The relay
 * INJECTS that token into the `connect` frame; every other frame passes verbatim.
 *
 * Liveness: no heartbeat. When the extension/browser goes away Chrome closes our
 * stdin (EOF) → we close the WS → the app-server's NodeBridge drops the node
 * immediately. When the desktop goes away the WS closes → we exit → Chrome sees
 * the port disconnect. Chrome's port lifecycle is the single source of truth.
 *
 * Native-messaging framing: each message is a uint32 little-endian byte length
 * followed by that many bytes of UTF-8 JSON. Chrome caps a single host→extension
 * message at 1 MB (extension→host is effectively unbounded); the browser tool
 * bulk (DOM/screenshots) flows extension→desktop, the unbounded direction.
 *
 * @module desktop-runtime/browser-bridge/native-host/relay
 */

/* global process, Buffer -- Node ≥22 script (Chrome spawns it via the bundled
   sidecar node); the repo ESLint config assumes browser globals for src/
   files, which lack the Node ones. WebSocket is global in both. */

import { readFileSync } from 'node:fs';

const APP_SERVER_URL = process.env.WORKX_APP_SERVER_URL || 'ws://127.0.0.1:18101';
const TOKEN_FILE = process.env.WORKX_BRIDGE_TOKEN_FILE || '';
const MAX_MSG_BYTES = 64 * 1024 * 1024; // hard cap; guards against a bad length prefix

/** Read the capability token the desktop wrote for the relay→app-server hop. */
function readToken() {
  if (!TOKEN_FILE) return '';
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Frame a JS object as a native-messaging message on stdout. */
function sendToChrome(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

/**
 * Parse the native-messaging framing off a growing buffer, invoking `onMessage`
 * for each complete message. Returns the leftover (incomplete) buffer.
 */
function drain(buffer, onMessage) {
  let buf = buffer;
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len > MAX_MSG_BYTES) {
      // Corrupt/hostile length — bail hard; Chrome will restart the host.
      process.stderr.write(`[relay] message length ${len} exceeds cap; exiting\n`);
      process.exit(1);
    }
    if (buf.length < 4 + len) break; // wait for the rest
    const json = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    try {
      onMessage(JSON.parse(json));
    } catch {
      // Ignore a single malformed frame rather than killing the pipe.
    }
  }
  return buf;
}

function main() {
  const token = readToken();
  let ws;
  let wsOpen = false;
  const outbox = []; // frames from Chrome awaiting the WS OPEN

  const flush = () => {
    if (!wsOpen) return;
    while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
  };

  // Inject the capability token into the extension's tokenless `connect` frame.
  const forwardToDesktop = (frame) => {
    if (frame && frame.type === 'req' && frame.method === 'connect') {
      frame.params = frame.params || {};
      frame.params.auth = { ...(frame.params.auth || {}), token };
    }
    outbox.push(frame);
    flush();
  };

  // ── Chrome (stdin) → desktop ──────────────────────────────────────────────
  let stdinBuf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    stdinBuf = drain(Buffer.concat([stdinBuf, chunk]), forwardToDesktop);
  });
  process.stdin.on('end', () => shutdown('chrome stdin closed'));
  process.stdin.on('error', () => shutdown('chrome stdin error'));

  // ── desktop (WS) → Chrome ─────────────────────────────────────────────────
  try {
    ws = new WebSocket(APP_SERVER_URL);
  } catch (err) {
    process.stderr.write(`[relay] WS construct failed: ${err}\n`);
    process.exit(1);
  }
  ws.addEventListener('open', () => {
    wsOpen = true;
    flush();
  });
  ws.addEventListener('message', (ev) => {
    let frame;
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    sendToChrome(frame);
  });
  ws.addEventListener('close', () => shutdown('app-server WS closed'));
  ws.addEventListener('error', () => shutdown('app-server WS error'));

  let exiting = false;
  function shutdown(reason) {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`[relay] shutdown: ${reason}\n`);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    // Give stdout a tick to flush the last framed message, then exit.
    setTimeout(() => process.exit(0), 10);
  }
}

main();
