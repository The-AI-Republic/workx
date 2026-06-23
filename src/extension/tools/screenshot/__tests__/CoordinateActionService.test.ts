import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoordinateActionService } from '../CoordinateActionService';

describe('CoordinateActionService', () => {
  const TAB_ID = 42;
  let mockSendCommand: ReturnType<typeof vi.fn>;
  let service: CoordinateActionService;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSendCommand = vi.fn().mockResolvedValue(undefined);
    service = new CoordinateActionService(TAB_ID, mockSendCommand);
  });

  // ==========================================================================
  // clickAt
  // ==========================================================================
  describe('clickAt', () => {
    it('sends mouseMoved, mousePressed, then mouseReleased with correct coordinates', async () => {
      await service.clickAt({ x: 100, y: 200 });

      expect(mockSendCommand).toHaveBeenCalledTimes(3);

      expect(mockSendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseMoved', x: 100, y: 200, button: 'none', buttons: 0,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(3, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseReleased', x: 100, y: 200, button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
      }));
    });

    it('uses custom button and modifiers from options', async () => {
      await service.clickAt(
        { x: 50, y: 75 },
        { button: 'right', modifiers: { shift: true } }
      );

      expect(mockSendCommand).toHaveBeenCalledTimes(3);

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', x: 50, y: 75, button: 'right', buttons: 2, clickCount: 1, modifiers: 8,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(3, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseReleased', x: 50, y: 75, button: 'right', buttons: 0, clickCount: 1, modifiers: 8,
      }));
    });

    it('double-click emits two press/release cycles (5 events)', async () => {
      await service.clickAt({ x: 1, y: 2 }, { clickCount: 2 });
      expect(mockSendCommand).toHaveBeenCalledTimes(5);
      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', clickCount: 1,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(4, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', clickCount: 2,
      }));
    });

    it('defaults button to left, clickCount to 1, modifiers to 0 when options is undefined', async () => {
      await service.clickAt({ x: 0, y: 0 });

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
      }));
    });

    it('wraps sendCommand errors with COORDINATE_CLICK_FAILED', async () => {
      mockSendCommand.mockRejectedValueOnce(new Error('CDP timeout'));

      await expect(service.clickAt({ x: 10, y: 20 })).rejects.toThrow(
        'COORDINATE_CLICK_FAILED: CDP timeout'
      );
    });
  });

  // ==========================================================================
  // encodeModifiers (tested indirectly through clickAt and keypressAt)
  // ==========================================================================
  describe('modifier encoding', () => {
    it('encodes alt as 1', async () => {
      await service.clickAt({ x: 0, y: 0 }, { modifiers: { alt: true } });

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 1 })
      );
    });

    it('encodes ctrl as 2', async () => {
      await service.clickAt({ x: 0, y: 0 }, { modifiers: { ctrl: true } });

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 2 })
      );
    });

    it('encodes meta as 4', async () => {
      await service.clickAt({ x: 0, y: 0 }, { modifiers: { meta: true } });

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 4 })
      );
    });

    it('encodes shift as 8', async () => {
      await service.clickAt({ x: 0, y: 0 }, { modifiers: { shift: true } });

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 8 })
      );
    });

    it('combines multiple modifiers using bitwise OR', async () => {
      await service.clickAt(
        { x: 0, y: 0 },
        { modifiers: { alt: true, ctrl: true, meta: true, shift: true } }
      );

      // alt(1) | ctrl(2) | meta(4) | shift(8) = 15
      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 15 })
      );
    });

    it('combines ctrl + shift as 10', async () => {
      await service.clickAt(
        { x: 0, y: 0 },
        { modifiers: { ctrl: true, shift: true } }
      );

      // ctrl(2) | shift(8) = 10
      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 10 })
      );
    });

    it('returns 0 when modifiers object is empty', async () => {
      await service.clickAt({ x: 0, y: 0 }, { modifiers: {} });

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 0 })
      );
    });

    it('returns 0 when modifiers is undefined', async () => {
      await service.clickAt({ x: 0, y: 0 }, {});

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ modifiers: 0 })
      );
    });
  });

  // ==========================================================================
  // typeAt
  // ==========================================================================
  describe('typeAt', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clicks to focus first, then sends Input.insertText', async () => {
      const promise = service.typeAt({ x: 300, y: 400 }, 'Hello World');
      // Advance past the 100ms focus wait
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // clickAt produces 3 calls (mouseMoved, mousePressed, mouseReleased), then insertText = 4 total
      expect(mockSendCommand).toHaveBeenCalledTimes(4);

      expect(mockSendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseMoved', x: 300, y: 400,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', x: 300, y: 400, button: 'left', clickCount: 1,
      }));
      expect(mockSendCommand).toHaveBeenNthCalledWith(3, 'Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseReleased', x: 300, y: 400, button: 'left', clickCount: 1,
      }));

      // Last call is the text insertion
      expect(mockSendCommand).toHaveBeenNthCalledWith(4, 'Input.insertText', {
        text: 'Hello World',
      });
    });

    it('passes clickCount: 1 to the internal click regardless of options', async () => {
      const promise = service.typeAt(
        { x: 10, y: 20 },
        'test',
        { clickCount: 3 }
      );
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Internal click (mousePressed = 2nd call) should always use clickCount: 1
      expect(mockSendCommand).toHaveBeenNthCalledWith(
        2,
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mousePressed', clickCount: 1 })
      );
    });

    it('wraps sendCommand errors with COORDINATE_TYPE_FAILED', async () => {
      mockSendCommand.mockRejectedValueOnce(new Error('Insert text failed'));

      const promise = service.typeAt({ x: 10, y: 20 }, 'abc');
      // Attach catch handler before advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow('COORDINATE_TYPE_FAILED');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    });

    it('wraps errors from insertText with COORDINATE_TYPE_FAILED', async () => {
      // Click succeeds (mouseMoved, mousePressed, mouseReleased), but insertText fails
      mockSendCommand
        .mockResolvedValueOnce(undefined) // mouseMoved
        .mockResolvedValueOnce(undefined) // mousePressed
        .mockResolvedValueOnce(undefined) // mouseReleased
        .mockRejectedValueOnce(new Error('Input domain error'));

      const promise = service.typeAt({ x: 10, y: 20 }, 'abc');
      // Attach catch handler before advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow(
        'COORDINATE_TYPE_FAILED: Input domain error'
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    });
  });

  // ==========================================================================
  // scrollTo
  // ==========================================================================
  describe('scrollTo', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Mock Runtime.evaluate for viewport bounds, pass through other commands
      mockSendCommand.mockImplementation(async (method: string, _params?: any) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 },
            },
          };
        }
        return undefined;
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('gets viewport bounds via Runtime.evaluate then sends mouseWheel event', async () => {
      const promise = service.scrollTo({ x: 500, y: 800 });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockSendCommand).toHaveBeenCalledTimes(2);

      // First call: get viewport bounds
      expect(mockSendCommand).toHaveBeenNthCalledWith(1, 'Runtime.evaluate', {
        expression:
          '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })',
        returnByValue: true,
      });

      // Second call: dispatch mouseWheel at center of viewport
      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 960,   // 1920 / 2
        y: 540,   // 1080 / 2
        deltaX: 500, // 500 - 0 (scrollX)
        deltaY: 800, // 800 - 0 (scrollY)
      });
    });

    it('calculates delta relative to current scroll position', async () => {
      mockSendCommand.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: { width: 1920, height: 1080, scrollX: 100, scrollY: 200 },
            },
          };
        }
        return undefined;
      });

      const promise = service.scrollTo({ x: 500, y: 800 });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 960,
        y: 540,
        deltaX: 400, // 500 - 100
        deltaY: 600, // 800 - 200
      });
    });

    it('handles negative scroll deltas when scrolling up/left', async () => {
      mockSendCommand.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: { width: 1920, height: 1080, scrollX: 500, scrollY: 800 },
            },
          };
        }
        return undefined;
      });

      const promise = service.scrollTo({ x: 100, y: 200 });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 960,
        y: 540,
        deltaX: -400, // 100 - 500
        deltaY: -600, // 200 - 800
      });
    });

    it('centers mouseWheel event at half of viewport dimensions', async () => {
      mockSendCommand.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
            },
          };
        }
        return undefined;
      });

      const promise = service.scrollTo({ x: 0, y: 0 });
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        2,
        'Input.dispatchMouseEvent',
        expect.objectContaining({
          x: 400, // 800 / 2
          y: 300, // 600 / 2
        })
      );
    });

    it('wraps sendCommand errors with COORDINATE_SCROLL_FAILED', async () => {
      mockSendCommand.mockRejectedValueOnce(new Error('Runtime not available'));

      const promise = service.scrollTo({ x: 0, y: 0 });
      // Attach catch handler before advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow(
        'COORDINATE_SCROLL_FAILED: Runtime not available'
      );
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    });
  });

  // ==========================================================================
  // keypressAt
  // ==========================================================================
  describe('keypressAt', () => {
    it('sends keyDown then keyUp with correct key, code, virtual key code, and text', async () => {
      await service.keypressAt('Enter');

      expect(mockSendCommand).toHaveBeenCalledTimes(2);

      expect(mockSendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        modifiers: 0,
      }));

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers: 0,
      }));
    });

    it('uses the correct physical code for a letter', async () => {
      await service.keypressAt('a');

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
      );
    });

    it('encodes modifiers correctly on keypress events', async () => {
      await service.keypressAt('c', {
        modifiers: { ctrl: true },
      });

      expect(mockSendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyDown',
        key: 'c',
        code: 'KeyC',
        modifiers: 2,
      }));

      expect(mockSendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyUp',
        key: 'c',
        code: 'KeyC',
        modifiers: 2,
      }));
    });

    it('encodes combined modifiers on keypress events', async () => {
      await service.keypressAt('v', {
        modifiers: { ctrl: true, shift: true },
      });

      // ctrl(2) | shift(8) = 10
      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ modifiers: 10 })
      );

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        2,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ modifiers: 10 })
      );
    });

    it('sends Tab keypress correctly', async () => {
      await service.keypressAt('Tab');

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      );
    });

    it('sends Escape keypress correctly', async () => {
      await service.keypressAt('Escape');

      expect(mockSendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      );
    });

    it('wraps sendCommand errors with COORDINATE_KEYPRESS_FAILED', async () => {
      mockSendCommand.mockRejectedValueOnce(new Error('Key event failed'));

      await expect(service.keypressAt('Enter')).rejects.toThrow(
        'COORDINATE_KEYPRESS_FAILED: Key event failed'
      );
    });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================
  describe('constructor', () => {
    it('creates an instance with the provided tabId and sendCommand', () => {
      const instance = new CoordinateActionService(99, mockSendCommand);
      expect(instance).toBeInstanceOf(CoordinateActionService);
    });

    it('uses the provided sendCommand function for all operations', async () => {
      const customSendCommand = vi.fn().mockResolvedValue(undefined);
      const instance = new CoordinateActionService(1, customSendCommand);

      await instance.clickAt({ x: 5, y: 10 });

      expect(customSendCommand).toHaveBeenCalled();
      expect(mockSendCommand).not.toHaveBeenCalled();
    });
  });
});
