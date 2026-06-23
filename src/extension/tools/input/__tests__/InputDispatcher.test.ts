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

  it('supports right-click', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await click(send, 1, 2, { button: 'right' });
    expect(send.mock.calls[1][1]).toMatchObject({ type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1 });
    expect(send.mock.calls[2][1]).toMatchObject({ type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1 });
  });

  it('double-click emits two full press/release cycles with incrementing clickCount', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await click(send, 1, 2, { clickCount: 2 });
    // mouseMoved, press(1), release(1), press(2), release(2)
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'mouseMoved' });
    expect(send.mock.calls[1][1]).toMatchObject({ type: 'mousePressed', clickCount: 1 });
    expect(send.mock.calls[2][1]).toMatchObject({ type: 'mouseReleased', clickCount: 1 });
    expect(send.mock.calls[3][1]).toMatchObject({ type: 'mousePressed', clickCount: 2 });
    expect(send.mock.calls[4][1]).toMatchObject({ type: 'mouseReleased', clickCount: 2 });
  });
});

describe('keyDefinitions punctuation + dispatchKey shift', () => {
  it('maps punctuation to a real code + virtual key code (not ASCII)', () => {
    expect(getKeyDefinition('.')).toMatchObject({ code: 'Period', keyCode: 190, text: '.' });
    expect(getKeyDefinition('/')).toMatchObject({ code: 'Slash', keyCode: 191, text: '/' });
    // No bogus ASCII-derived keyCode (e.g. '.' must not be 46 = VK_DELETE).
    expect(getKeyDefinition('.').keyCode).not.toBe(46);
  });

  it('encodes the Shift modifier for an already-uppercase letter', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, 'A');
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'keyDown', text: 'A', modifiers: MODIFIER_BITS.shift });
  });

  it('maps shifted number-row symbols to the digit code and encodes Shift', async () => {
    expect(getKeyDefinition('!')).toMatchObject({ code: 'Digit1', keyCode: 49, text: '!' });
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, '!');
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'keyDown', code: 'Digit1', modifiers: MODIFIER_BITS.shift });
  });

  it('encodes Shift for a shifted punctuation symbol', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, '?');
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'keyDown', code: 'Slash', modifiers: MODIFIER_BITS.shift });
  });

  it('does not encode Shift for an unshifted symbol', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchKey(send, '/');
    expect(send.mock.calls[0][1]).toMatchObject({ type: 'keyDown', code: 'Slash', modifiers: 0 });
  });
});
