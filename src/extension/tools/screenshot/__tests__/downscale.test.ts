import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downscalePngToCssPixels } from '../downscale';

describe('downscalePngToCssPixels', () => {
  const sample = btoa('PNGDATA');
  let origBitmap: any;
  let origCanvas: any;

  beforeEach(() => {
    origBitmap = (globalThis as any).createImageBitmap;
    origCanvas = (globalThis as any).OffscreenCanvas;
  });

  afterEach(() => {
    (globalThis as any).createImageBitmap = origBitmap;
    (globalThis as any).OffscreenCanvas = origCanvas;
  });

  it('returns the input unchanged when dpr <= 1', async () => {
    expect(await downscalePngToCssPixels(sample, 1)).toBe(sample);
  });

  it('returns the input unchanged when image APIs are unavailable', async () => {
    (globalThis as any).createImageBitmap = undefined;
    (globalThis as any).OffscreenCanvas = undefined;
    expect(await downscalePngToCssPixels(sample, 2)).toBe(sample);
  });

  it('downscales by dpr using OffscreenCanvas when dpr > 1', async () => {
    const drawImage = vi.fn();
    const closed = vi.fn();
    (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 200, height: 100, close: closed }));

    let canvasW = 0;
    let canvasH = 0;
    (globalThis as any).OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        canvasW = w;
        canvasH = h;
      }
      getContext() {
        return { drawImage };
      }
      convertToBlob() {
        return Promise.resolve({ arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });
      }
    };

    const out = await downscalePngToCssPixels(sample, 2);

    // Canvas sized to CSS pixels (device / dpr).
    expect(canvasW).toBe(100);
    expect(canvasH).toBe(50);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 50);
    expect(closed).toHaveBeenCalled();
    // Output is the re-encoded bytes, not the original device-pixel image.
    expect(out).toBe(btoa(String.fromCharCode(9, 9, 9)));
    expect(out).not.toBe(sample);
  });

  it('preserves the requested image format when re-encoding', async () => {
    const convertArgs: any[] = [];
    (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() }));
    (globalThis as any).OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn() };
      }
      convertToBlob(opts: any) {
        convertArgs.push(opts);
        return Promise.resolve({ arrayBuffer: async () => new Uint8Array([1]).buffer });
      }
    };

    await downscalePngToCssPixels(sample, 2, { mimeType: 'image/jpeg', quality: 0.8 });
    expect(convertArgs[0]).toEqual({ type: 'image/jpeg', quality: 0.8 });
  });

  it('falls back to the original image if the pipeline throws', async () => {
    (globalThis as any).createImageBitmap = vi.fn(async () => {
      throw new Error('decode failed');
    });
    (globalThis as any).OffscreenCanvas = class {};
    expect(await downscalePngToCssPixels(sample, 2)).toBe(sample);
  });
});
