export const DEFAULT_AUTO_COMPACT_RATIO = 0.8;
export const TOKEN_WARNING_RATIO = 0.7;
export const TOKEN_ERROR_RATIO = 0.9;
export const TOKEN_BLOCKING_RATIO = 1;

export interface TokenWarningState {
  current_tokens: number;
  context_window?: number;
  auto_compact_token_limit?: number;
  percent_used?: number;
  percent_left?: number;
  is_above_warning_threshold: boolean;
  is_above_error_threshold: boolean;
  is_above_auto_compact_threshold: boolean;
  is_at_blocking_limit: boolean;
}

export function getAutoCompactTokenLimit(
  contextWindow?: number,
  modelProvidedLimit?: number,
): number | undefined {
  if (typeof modelProvidedLimit === 'number' && modelProvidedLimit > 0) {
    return Math.floor(modelProvidedLimit);
  }
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    return undefined;
  }
  return Math.floor(contextWindow * DEFAULT_AUTO_COMPACT_RATIO);
}

export function getAutoCompactRatio(
  contextWindow?: number,
  modelProvidedLimit?: number,
): number {
  if (
    typeof contextWindow === 'number' &&
    contextWindow > 0 &&
    typeof modelProvidedLimit === 'number' &&
    modelProvidedLimit > 0
  ) {
    return Math.min(1, modelProvidedLimit / contextWindow);
  }
  return DEFAULT_AUTO_COMPACT_RATIO;
}

export function shouldAutoCompactTokens(
  currentTokens: number | undefined,
  contextWindow?: number,
  modelProvidedLimit?: number,
): boolean {
  if (typeof currentTokens !== 'number' || currentTokens <= 0) {
    return false;
  }
  const limit = getAutoCompactTokenLimit(contextWindow, modelProvidedLimit);
  return typeof limit === 'number' && currentTokens >= limit;
}

export function calculateTokenWarningState(options: {
  currentTokens?: number;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
}): TokenWarningState {
  const currentTokens = Math.max(0, options.currentTokens ?? 0);
  const contextWindow = options.contextWindow;
  const autoCompactLimit = getAutoCompactTokenLimit(
    contextWindow,
    options.autoCompactTokenLimit,
  );

  const percentUsed =
    typeof contextWindow === 'number' && contextWindow > 0
      ? (currentTokens / contextWindow) * 100
      : undefined;
  const percentLeft =
    typeof percentUsed === 'number' ? Math.max(0, 100 - percentUsed) : undefined;

  const warningThreshold =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow * TOKEN_WARNING_RATIO
      : undefined;
  const errorThreshold =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow * TOKEN_ERROR_RATIO
      : undefined;
  const blockingThreshold =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow * TOKEN_BLOCKING_RATIO
      : undefined;

  return {
    current_tokens: currentTokens,
    context_window: contextWindow,
    auto_compact_token_limit: autoCompactLimit,
    percent_used: percentUsed,
    percent_left: percentLeft,
    is_above_warning_threshold:
      typeof warningThreshold === 'number' && currentTokens >= warningThreshold,
    is_above_error_threshold:
      typeof errorThreshold === 'number' && currentTokens >= errorThreshold,
    is_above_auto_compact_threshold:
      typeof autoCompactLimit === 'number' && currentTokens >= autoCompactLimit,
    is_at_blocking_limit:
      typeof blockingThreshold === 'number' && currentTokens >= blockingThreshold,
  };
}
