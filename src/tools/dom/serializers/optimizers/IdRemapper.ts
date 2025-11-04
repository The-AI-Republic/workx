/**
 * IdRemapper: Bidirectional mapping for sequential ID remapping
 *
 * Maps large CDP backendNodeIds (e.g., 52819) to sequential IDs (1, 2, 3...)
 * for token optimization. Maintains bidirectional mapping for action translation.
 *
 * Lifecycle:
 * 1. Created during serialization
 * 2. Registers nodes as they're serialized (sequential ID assignment)
 * 3. Persists in DomSnapshot for action translation
 * 4. Regenerated on snapshot rebuild after invalidation
 */

import { IIdRemapper } from '../../types';

export class IdRemapper implements IIdRemapper {
  private sequentialToBackend: Map<number, number> = new Map();
  private backendToSequential: Map<number, number> = new Map();
  private nextSequentialId: number = 1;

  /**
   * Register a backendNodeId and get its sequential ID
   * @param backendNodeId - CDP backend node ID
   * @returns Sequential ID (1, 2, 3...)
   */
  registerNode(backendNodeId: number): number {
    // Check if already registered
    const existing = this.backendToSequential.get(backendNodeId);
    if (existing !== undefined) {
      return existing;
    }

    // Assign next sequential ID
    const sequentialId = this.nextSequentialId++;

    // Store bidirectional mapping
    this.sequentialToBackend.set(sequentialId, backendNodeId);
    this.backendToSequential.set(backendNodeId, sequentialId);

    return sequentialId;
  }

  /**
   * Translate sequential ID → backendNodeId (for actions)
   * @param sequentialId - Sequential ID from LLM
   * @returns CDP backend node ID, or null if not found
   */
  toBackendId(sequentialId: number): number | null {
    return this.sequentialToBackend.get(sequentialId) ?? null;
  }

  /**
   * Translate backendNodeId → sequential ID (for serialization)
   * @param backendNodeId - CDP backend node ID
   * @returns Sequential ID, or null if not registered
   */
  toSequentialId(backendNodeId: number): number | null {
    return this.backendToSequential.get(backendNodeId) ?? null;
  }

  /**
   * Check if backendNodeId is already registered
   * @param backendNodeId - CDP backend node ID
   * @returns true if registered, false otherwise
   */
  hasBackendId(backendNodeId: number): boolean {
    return this.backendToSequential.has(backendNodeId);
  }

  /**
   * Get total count of registered nodes
   * @returns Number of nodes registered
   */
  getNodeCount(): number {
    return this.backendToSequential.size;
  }

  /**
   * Reset the remapper (for testing)
   */
  reset(): void {
    this.sequentialToBackend.clear();
    this.backendToSequential.clear();
    this.nextSequentialId = 1;
  }

  /**
   * Get all mappings as array (for debugging)
   */
  getMappings(): Array<{ sequentialId: number; backendNodeId: number }> {
    const mappings: Array<{ sequentialId: number; backendNodeId: number }> = [];
    for (const [sequentialId, backendNodeId] of this.sequentialToBackend) {
      mappings.push({ sequentialId, backendNodeId });
    }
    return mappings.sort((a, b) => a.sequentialId - b.sequentialId);
  }
}
