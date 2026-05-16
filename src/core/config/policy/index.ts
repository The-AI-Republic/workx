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
export { ManagedDirSource, defaultManagedDirPath } from './ManagedDirSource';

export {
  isKeyLocked,
  assertWritable,
  assertWritableSubtree,
  stripLockedWrites,
} from './guards';

export {
  assessPolicyChange,
  assessAndRecord,
  redactSecrets,
  __resetSecurityCheckForTests,
} from './securityCheck';
export type { PolicyChangeAssessment } from './securityCheck';

export { RemotePolicySource } from '../remotePolicy/RemotePolicySource';
export type { RemotePolicySourceOptions } from '../remotePolicy/RemotePolicySource';
export {
  fetchRemotePolicy,
  computePolicyChecksum,
  startPolicyPoll,
  stopPolicyPoll,
} from '../remotePolicy/RemotePolicyFetcher';
export type { RemoteFetchResult } from '../remotePolicy/RemotePolicyFetcher';

export {
  deepClone,
  getByPath,
  setByPath,
  deleteByPath,
  isPathLockedBy,
  flattenLeafPaths,
} from './pathUtils';
