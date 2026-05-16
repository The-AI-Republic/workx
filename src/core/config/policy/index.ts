/**
 * Managed / Policy Settings Tier (Track 20) — public barrel.
 *
 * One shared resolver feeds both BrowserX config systems via the post-merge
 * pin ({@link applyPolicy}) and the write-surface guards. Platform-native
 * sources live with their platform; this barrel exposes the shared core.
 *
 * @module core/config/policy
 */

export type {
  PolicyOrigin,
  PolicyNamespace,
  ResolvedPolicy,
  PolicySource,
  PolicySummary,
} from './types';
export { PolicyLockedError } from './types';

export {
  registerPolicySources,
  resolveActivePolicy,
  getActivePolicySync,
  onPolicyChanged,
  getPolicyOrigin,
  getLockedKeys,
  isLockedFor,
  getActivePolicySummary,
  __resetPolicyResolverForTests,
} from './PolicyResolver';

export { applyPolicy } from './applyPolicy';

export { ManagedFileSource, defaultManagedFilePath } from './ManagedFileSource';

export { isKeyLocked, assertWritable, stripLockedWrites } from './guards';

export {
  deepClone,
  getByPath,
  setByPath,
  deleteByPath,
  isPathLockedBy,
  flattenLeafPaths,
} from './pathUtils';
