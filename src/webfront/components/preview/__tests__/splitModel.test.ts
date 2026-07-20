import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_SPLIT_PERCENT,
  MAX_CHAT_SPLIT_PERCENT,
  MIN_CHAT_SPLIT_PERCENT,
  chatSplitPercentFromClientX,
  chatSplitPercentFromKey,
  clampChatSplitPercent,
} from '../splitModel';

describe('preview split model', () => {
  it('defaults to a 60/40 split and clamps chat to the 40–80 percent range', () => {
    expect(DEFAULT_CHAT_SPLIT_PERCENT).toBe(60);
    expect(MIN_CHAT_SPLIT_PERCENT).toBe(40);
    expect(MAX_CHAT_SPLIT_PERCENT).toBe(80);
    expect(clampChatSplitPercent(39)).toBe(40);
    expect(clampChatSplitPercent(67.5)).toBe(67.5);
    expect(clampChatSplitPercent(81)).toBe(80);
    expect(clampChatSplitPercent(Number.NaN)).toBe(60);
  });

  it('derives a rounded, constrained split from the content container', () => {
    expect(chatSplitPercentFromClientX(700, 100, 1000)).toBe(60);
    expect(chatSplitPercentFromClientX(611, 100, 1000)).toBe(51.1);
    expect(chatSplitPercentFromClientX(200, 100, 1000)).toBe(40);
    expect(chatSplitPercentFromClientX(1100, 100, 1000)).toBe(80);
    expect(chatSplitPercentFromClientX(700, 100, 0)).toBe(60);
  });

  it('supports accessible keyboard resizing', () => {
    expect(chatSplitPercentFromKey(60, 'ArrowLeft')).toBe(58);
    expect(chatSplitPercentFromKey(60, 'ArrowRight')).toBe(62);
    expect(chatSplitPercentFromKey(40, 'ArrowLeft')).toBe(40);
    expect(chatSplitPercentFromKey(80, 'ArrowRight')).toBe(80);
    expect(chatSplitPercentFromKey(60, 'Home')).toBe(40);
    expect(chatSplitPercentFromKey(60, 'End')).toBe(80);
    expect(chatSplitPercentFromKey(60, 'Enter')).toBeNull();
  });
});
