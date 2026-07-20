import { ComponentError } from './errors';
import type { ComponentArtifact, ComponentDefinition, ComponentPlatform } from './types';

const COMPONENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class ComponentCatalog {
  private readonly definitions = new Map<string, ComponentDefinition>();

  constructor(definitions: ComponentDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ComponentDefinition): void {
    this.validateDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new ComponentError(
        'COMPONENT_INVALID',
        `Component '${definition.id}' is already registered.`
      );
    }
    this.definitions.set(definition.id, structuredClone(definition));
  }

  list(): ComponentDefinition[] {
    return [...this.definitions.values()].map((definition) => structuredClone(definition));
  }

  get(componentId: string): ComponentDefinition {
    const definition = this.definitions.get(componentId);
    if (!definition) {
      throw new ComponentError('COMPONENT_NOT_FOUND', `Unknown WorkX component '${componentId}'.`);
    }
    return structuredClone(definition);
  }

  resolveArtifact(componentId: string, platform: ComponentPlatform): ComponentArtifact {
    const definition = this.get(componentId);
    const artifact = definition.artifacts.find((candidate) => candidate.platform === platform);
    if (!artifact) {
      throw new ComponentError(
        'COMPONENT_UNSUPPORTED',
        `${definition.displayName} is not available for ${platform}.`
      );
    }
    return artifact;
  }

  private validateDefinition(definition: ComponentDefinition): void {
    if (!COMPONENT_ID_PATTERN.test(definition.id)) {
      throw new ComponentError('COMPONENT_INVALID', `Invalid component ID '${definition.id}'.`);
    }
    if (!definition.version.trim() || !definition.displayName.trim()) {
      throw new ComponentError('COMPONENT_INVALID', 'Component name and version are required.');
    }
    if (!Object.keys(definition.entrypoints).length) {
      throw new ComponentError('COMPONENT_INVALID', 'A component must declare an entrypoint.');
    }
    if (!definition.entrypoints[definition.healthCheck.entrypoint]) {
      throw new ComponentError(
        'COMPONENT_INVALID',
        'The component health-check entrypoint is not declared.'
      );
    }
    const seenPlatforms = new Set<ComponentPlatform>();
    for (const artifact of definition.artifacts) {
      if (seenPlatforms.has(artifact.platform)) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          `Duplicate ${artifact.platform} artifact for '${definition.id}'.`
        );
      }
      seenPlatforms.add(artifact.platform);
      const url = new URL(artifact.url);
      if (url.protocol !== 'https:' || !definition.source.trustedOrigins.includes(url.origin)) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          `Untrusted artifact origin for '${definition.id}'.`
        );
      }
      if (!SHA256_PATTERN.test(artifact.sha256)) {
        throw new ComponentError('COMPONENT_INVALID', 'Artifact SHA-256 must be lowercase hex.');
      }
      if (artifact.downloadSizeBytes < 1 || artifact.archive.maxExtractedBytes < 1) {
        throw new ComponentError('COMPONENT_INVALID', 'Artifact size bounds must be positive.');
      }
      if (!definition.entrypoints[artifact.archive.targetEntrypoint]) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          `Artifact targets unknown entrypoint '${artifact.archive.targetEntrypoint}'.`
        );
      }
      const effectiveEntrypoints = {
        ...definition.entrypoints,
        ...(artifact.entrypointOverrides ?? {}),
      };
      if (
        Object.keys(effectiveEntrypoints).length !== 1 ||
        !effectiveEntrypoints[artifact.archive.targetEntrypoint]
      ) {
        throw new ComponentError(
          'COMPONENT_INVALID',
          'The current ZIP extractor supports exactly one logical entrypoint.'
        );
      }
      for (const name of Object.keys(artifact.entrypointOverrides ?? {})) {
        if (!definition.entrypoints[name]) {
          throw new ComponentError(
            'COMPONENT_INVALID',
            `Artifact overrides unknown entrypoint '${name}'.`
          );
        }
      }
    }
  }
}
