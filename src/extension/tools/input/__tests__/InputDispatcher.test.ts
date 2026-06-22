import { describe, it, expect, vi } from 'vitest';
import { getKeyDefinition } from '../keyDefinitions';
import { dispatchKey, click, encodeModifiers, MODIFIER_BITS } from '../InputDispatcher';

describe('getKeyDefinition', () => {
  it('maps Enter with text and keyCode 13', () => {
    expect(getKeyDefinition('Enter')).toMatchObject({ code: 'Enter', keyCode: 13, text: '\r' });
  });

  it('maps Tab with keyCode 9 and no text', () => {
    const def = getKeyDefinition('Tab');
    expect(def).toMatchObject({ code: 'Tab', keyCode: 9 });
    expect(def.text).toBeUndefined();
  });

  it('maps lowercase and uppercase letters to KeyA / keyCode 65', () => {
    expect(getKeyDefinition('a')).toMatchObject({ code: 'KeyA', keyCode: 65, text: 'a' });
    expect(getKeyDefinition('A')).toMatchObject({ code: 'KeyA', keyCode: 65, text: 'A' });
  });

  it('maps digits to DigitN', () => {
    expect(getKeyDefinition('1')).toMatchObject({ code: 'Digit1', keyCode: 49, text: '1' });
  });

  it('maps navigation keys without text', () => {
    expect(getKeyDefinition('ArrowDown')).toMatchObject({ code: 'ArrowDown', keyCode: 40 });
    expect(getKeyDefinition('ArrowDown').text).toBeUndefined();
  });

  it('resolves aliases', () => {
    expect(getKeyDefinition('Esc').code).toBe('Escape');
    expect(getKeyDefinition('Up').code).toBe('ArrowUp');
    expect(getKeyDefinition('Return').code).toBe('Enter');
  });

  it('maps function keys', () => {
    expect(getKeyDefinition('F5')).toMatchObject({ code: 'F5', keyCode: 116 });
    expect(getKeyDefinition('F12')).toMatchObject({ code: 'F12', keyCode: 123 });
  });

  it('never produces the legacy KeyENTER-style code', () => {
    expect(getKeyDefinition('Enter').code).not.toBe('KeyENTER');
    expect(getKeyDefinition('Tab').code).not.toBe('KeyTAB');
  });
});

describe('encodeModifiers', () => {
  it('encodes the CDP bitmask', () => {
    expect(encodeModifiers()).toBe(0);
    expect(encodeModifiers({ ctrl: true })).toBe(MODIFIER_BITS.ctrl);
    expect(encodeModifiers({ alt: true, shift: true })).toBe(MODIFIER_BITS.alt | MODIFIER_BITS.shift);
  });
});

describe('dispatchKey', () => {
  it('sends keyDown with text + windowsVirtualKeyCode then keyUp for a printable key', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, 'Enter');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    }));
    expect(send).toHaveBeenNthCalledWith(2, 'Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyUp', code: 'Enter', windowsVirtualKeyCode: 13,
    }));
  });

  it('uses rawKeyDown with no text for navigation keys', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, 'ArrowDown');
    const first = send.mock.calls[0][1];
    expect(first.type).toBe('rawKeyDown');
    expect(first.text).toBeUndefined();
    expect(first.windowsVirtualKeyCode).toBe(40);
  });

  it('uppercases a letter when Shift is held', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, 'a', { modifiers: MODIFIER_BITS.shift });
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'keyDown', text: 'A' });
  });
});

describe('click', () => {
  it('emits mouseMoved → mousePressed → mouseReleased with correct buttons', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await click(send, 10, 20);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0,
    }));
    expect(send).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1,
    }));
    expect(send).toHaveBeenNthCalledWith(3, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1,
    }));
  });

  it('supports right-click and double-click', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await click(send, 1, 2, { button: 'right', clickCount: 2 });
    expect(send.mock.calls[1][1]).toMatchObject({ button: 'right', buttons: 2, clickCount: 2 });
    expect(send.mock.calls[2][1]).toMatchObject({ button: 'right', buttons: 0, clickCount: 2 });
  });
});
