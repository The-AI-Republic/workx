export const DEFAULT_CHAT_SPLIT_PERCENT = 60;
export const MIN_CHAT_SPLIT_PERCENT = 40;
export const MAX_CHAT_SPLIT_PERCENT = 80;
export const KEYBOARD_SPLIT_STEP_PERCENT = 2;

export function clampChatSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_SPLIT_PERCENT;
  return Math.min(MAX_CHAT_SPLIT_PERCENT, Math.max(MIN_CHAT_SPLIT_PERCENT, value));
}

export function chatSplitPercentFromClientX(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return DEFAULT_CHAT_SPLIT_PERCENT;
  }
  const percent = ((clientX - containerLeft) / containerWidth) * 100;
  return clampChatSplitPercent(Math.round(percent * 10) / 10);
}

export function chatSplitPercentFromKey(current: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampChatSplitPercent(current - KEYBOARD_SPLIT_STEP_PERCENT);
    case 'ArrowRight':
      return clampChatSplitPercent(current + KEYBOARD_SPLIT_STEP_PERCENT);
    case 'Home':
      return MIN_CHAT_SPLIT_PERCENT;
    case 'End':
      return MAX_CHAT_SPLIT_PERCENT;
    default:
      return null;
  }
}
