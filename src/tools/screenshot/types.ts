/**
 * Type definitions for PageVisionTool
 * CDP-based screenshot capture and coordinate-based interaction
 */

// ============================================================================
// Request Types
// ============================================================================

export type ScreenshotAction = 'screenshot' | 'click' | 'type' | 'scroll' | 'keypress';

export interface Coordinates {
  x: number;
  y: number;
}

export interface ScrollOffset {
  x?: number;
  y?: number;
}

export interface KeyModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface ActionOptions {
  button?: 'left' | 'right' | 'middle';
  modifiers?: KeyModifiers;
  wait_after_action?: number;
  block?: 'start' | 'center' | 'end' | 'nearest';
  inline?: 'start' | 'center' | 'end' | 'nearest';
}

export interface ScreenshotToolRequest {
  action: ScreenshotAction;
  tab_id?: number;
  coordinates?: Coordinates;
  text?: string;
  key?: string;
  scroll_offset?: ScrollOffset;
  options?: ActionOptions;
}

// ============================================================================
// Response Types
// ============================================================================

export interface ViewportBounds {
  width: number;
  height: number;
  scroll_x: number;
  scroll_y: number;
}

export interface ScreenshotResponseData {
  image_file_id: string;
  width: number;
  height: number;
  format: 'png';
  viewport_bounds: ViewportBounds;
}

export interface ActionResponseData {
  coordinates_used?: Coordinates; // Optional - keypress action doesn't use coordinates
  action_timestamp: string;
}

export type ResponseData = ScreenshotResponseData | ActionResponseData;

export interface ErrorDetails {
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface ResponseMetadata {
  duration_ms: number;
  tab_id: number;
  timestamp: string;
  tool_version: string;
}

export interface ScreenshotToolResponse {
  success: boolean;
  action: string;
  data?: ResponseData;
  error?: ErrorDetails;
  metadata: ResponseMetadata;
}

// ============================================================================
// Service Types
// ============================================================================

export interface ScreenshotCaptureOptions {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  scroll_offset?: ScrollOffset;
}

export interface CoordinateActionOptions {
  button?: 'left' | 'right' | 'middle';
  modifiers?: KeyModifiers;
  clickCount?: number;
  waitAfter?: number;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED',
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  CDP_CONNECTION_LOST: 'CDP_CONNECTION_LOST',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  FILE_STORAGE_ERROR: 'FILE_STORAGE_ERROR',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// ============================================================================
// Constants
// ============================================================================

export const SCREENSHOT_CACHE_KEY = 'screenshot_cache';
export const MAX_SCREENSHOT_SIZE_MB = 10;
export const DEFAULT_WAIT_AFTER_ACTION_MS = 100;
