/**
 * A2A Server (Stub)
 *
 * Exposes the local agent as an A2A-compatible server, enabling
 * remote agents to discover and invoke local skills.
 *
 * Status: P3 priority — deferred until P1/P2 stories are stable.
 * See specs/021-a2a-agent-protocol/server-design.md for architecture.
 */

/**
 * A2AServer placeholder.
 * Will implement:
 * - Local AgentCard generation from tool registry (T025)
 * - JSON-RPC request handler via @a2a-js/sdk/server (T026)
 * - Server lifecycle management (start/stop)
 */
export class A2AServer {
  /**
   * Generate a local AgentCard from the tool registry.
   * @stub T025
   */
  static generateAgentCard(): never {
    throw new Error('A2AServer.generateAgentCard not yet implemented (P3 - see T025)');
  }

  /**
   * Start the A2A server.
   * @stub T026
   */
  static start(): never {
    throw new Error('A2AServer.start not yet implemented (P3 - see T026)');
  }

  /**
   * Stop the A2A server.
   * @stub T026
   */
  static stop(): never {
    throw new Error('A2AServer.stop not yet implemented (P3 - see T026)');
  }
}
