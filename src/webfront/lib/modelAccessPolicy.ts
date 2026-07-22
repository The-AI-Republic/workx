/**
 * Product-neutral model access seam.
 *
 * OSS WorkX does not impose subscription tiers or restrict built-in models.
 * Product distributions may replace this module through their source overlay
 * to provide account-specific availability, preferred defaults, and copy.
 */

export interface ModelAccessTarget {
  modelKey: string;
  isCustom?: boolean;
}

export type PreferredModelPurpose = 'initial' | 'access-fallback';

export interface ModelAccessPolicy {
  isLocked(target: ModelAccessTarget): boolean;
  getPreferredModelId(purpose: PreferredModelPurpose): string | null;
  lockedCopy: {
    chatInline: string;
    chatTooltip: string;
    settingsTooltip: string;
  };
}

export const modelAccessPolicy: ModelAccessPolicy = {
  isLocked: () => false,
  getPreferredModelId: () => null,
  lockedCopy: {
    chatInline: 'This model is unavailable for your account',
    chatTooltip: 'This model is unavailable for your account',
    settingsTooltip: 'This model is unavailable for your account',
  },
};
