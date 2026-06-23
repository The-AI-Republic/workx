/**
 * Downscale a device-pixel PNG to CSS pixels.
 *
 * `page_vision` captures at device resolution (`Page.captureScreenshot` applies
 * no scale), yet the model is told to report image-pixel coordinates and those
 * are dispatched as CSS-pixel `Input` events. On DPR>1 displays that mismatch
 * made every vision click land at DPR× the intended position (then silently
 * clamped to the viewport edge). Downscaling the captured PNG to
 * `innerWidth × innerHeight` makes image pixels == CSS pixels == input
 * coordinates, with no DPR math downstream.
 *
 * Uses `OffscreenCanvas` / `createImageBitmap`, both available in MV3 service
 * workers. No-ops when `devicePixelRatio <= 1` or the image APIs are
 * unavailable (e.g. `chrome://`, PDF viewer, or a non-worker context), falling
 * back to the original image rather than failing the capture.
 *
 * @module extension/tools/screenshot/downscale
 */

export interface DownscaleOptions {
  /** Image MIME type to decode and re-encode as (default 'image/png'). */
  mimeType?: string;
  /** Encoder quality for lossy formats (jpeg/webp), 0–1. */
  quality?: number;
}

export async function downscalePngToCssPixels(
  base64Data: string,
  devicePixelRatio: number,
  options?: DownscaleOptions
): Promise<string> {
  if (!(devicePixelRatio > 1)) return base64Data;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return base64Data;
  }

  const mimeType = options?.mimeType ?? 'image/png';

  try {
    const bytes = base64ToBytes(base64Data);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const targetWidth = Math.max(1, Math.round(bitmap.width / devicePixelRatio));
    const targetHeight = Math.max(1, Math.round(bitmap.height / devicePixelRatio));

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return base64Data;
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close?.();

    // Preserve the requested format so a jpeg/webp capture isn't silently
    // turned into PNG bytes.
    const blob = await canvas.convertToBlob({ type: mimeType, quality: options?.quality });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch (error) {
    console.warn('[ScreenshotService] DPR downscale failed; using device-pixel image:', error);
    return base64Data;
  }
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
