/**
 * Optional model-catalog integration seam.
 *
 * OSS WorkX always uses its bundled provider catalog. Product overlays may
 * replace this module to install and initialize another catalog source without
 * putting deployment-specific fetching or endpoint knowledge in this repo.
 */

import type { IProviderConfig } from './types';

export type ModelCatalog = Record<string, IProviderConfig>;
export type ModelCatalogLoader = () => Promise<unknown>;

/** Install a platform-owned loader. The OSS adapter intentionally ignores it. */
export function setModelCatalogLoader(loader: ModelCatalogLoader | null): void {
  void loader;
}

/** Initialize an overlay-provided catalog. The OSS adapter is a no-op. */
export async function initializeModelCatalog(): Promise<void> {}

/** Return an initialized catalog override. OSS always uses the bundled catalog. */
export function getModelCatalogOverride(): ModelCatalog | null {
  return null;
}

/**
 * Create a runtime-side loader for platforms that relay catalog data to a UI
 * process. Product overlays opt in by returning a handler.
 */
export function createRuntimeModelCatalogLoader(): (() => Promise<ModelCatalog>) | undefined {
  return undefined;
}
