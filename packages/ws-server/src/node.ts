/**
 * Node Bridge Protocol
 *
 * Frames for `mode: 'node'` connections — worker clients that expose tools
 * for the server to invoke (reverse RPC). The first consumer is the WorkX
 * Chrome extension acting as the desktop app's live-browser executor:
 *
 *   node → server   `node.advertise`  (tool catalog, after hello-ok)
 *   server → node   `node.invoke`     (event; one tool call, correlated by invokeId)
 *   node → server   `node.result`     (result for a prior invoke)
 *   node → server   `node.heartbeat`  (keep-alive; also extends MV3 SW lifetime)
 *
 * @module server/protocol/node
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Scopes granted to node-mode connections (and nothing else)
// ─────────────────────────────────────────────────────────────────────────

export const NODE_SCOPES: readonly string[] = ['node.invoke', 'node.event'];

/** Event name for server → node tool invocations. */
export const NODE_INVOKE_EVENT = 'node.invoke';

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

/** One tool a node offers for remote invocation. `parameters` is JSON Schema. */
export const NodeToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  parameters: z.record(z.unknown()).optional(),
  readOnly: z.boolean().optional(),
});

export const NodeAdvertiseParamsSchema = z.object({
  node: z.object({
    /** Node kind, e.g. 'browser-extension'. */
    kind: z.string().min(1),
    displayName: z.string().default(''),
    version: z.string().default(''),
  }),
  tools: z.array(NodeToolDescriptorSchema),
});

/** Payload of a `node.invoke` event (server → node). */
export const NodeInvokePayloadSchema = z.object({
  invokeId: z.string().min(1),
  operation: z.enum(['tool', 'release-session', 'browser-context']).default('tool'),
  sessionId: z.string().min(1),
  toolName: z.string().min(1).optional(),
  parameters: z.record(z.unknown()).default({}),
  /** Executor-side budget; the server keeps its own (slightly longer) timer. */
  timeoutMs: z.number().int().positive().optional(),
  focusGrantId: z.string().min(1).optional(),
});

/** Params of a `node.result` request (node → server). */
export const NodeResultParamsSchema = z.object({
  invokeId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type NodeToolDescriptor = z.infer<typeof NodeToolDescriptorSchema>;
export type NodeAdvertiseParams = z.infer<typeof NodeAdvertiseParamsSchema>;
export type NodeInvokePayload = z.infer<typeof NodeInvokePayloadSchema>;
export type NodeResultParams = z.infer<typeof NodeResultParamsSchema>;
