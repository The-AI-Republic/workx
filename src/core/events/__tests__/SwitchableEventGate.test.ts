import { describe, expect, it, vi } from 'vitest';
import { SwitchableEventGate } from '../SwitchableEventGate';
import type { Event } from '../../protocol/types';

function event(id: string): Event {
  return { id, msg: { type: 'BackgroundEvent', data: { message: id } } };
}

describe('SwitchableEventGate', () => {
  it('buffers initialization events and drains them in capture order after activation', async () => {
    const delivered: Event[] = [];
    const gate = new SwitchableEventGate((value) => { delivered.push(value); });
    gate.dispatcher(event('one'));
    gate.dispatcher(event('two'));
    expect(delivered).toEqual([]);
    gate.activate();
    gate.dispatcher(event('three'));
    await gate.flush();
    expect(delivered.map((value) => value.id)).toEqual(['one', 'two', 'three']);
    expect(delivered.map((value) => value.eventSeq)).toEqual([1, 2, 3]);
    expect(new Set(delivered.map((value) => value.runtimeEpoch)).size).toBe(1);
  });

  it('survives a rejecting destination and delivers later events', async () => {
    const delivered: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = new SwitchableEventGate((value) => {
      delivered.push(value.id);
      if (value.id === 'bad') return Promise.reject(new Error('send failed'));
    });
    gate.activate();
    gate.dispatcher(event('bad'));
    gate.dispatcher(event('good'));
    await gate.flush();
    expect(delivered).toEqual(['bad', 'good']);
    warn.mockRestore();
  });

  it('bounds replay, reports only a real cursor gap, and closes without leaking buffered events', async () => {
    const gate = new SwitchableEventGate(() => undefined, 2, 100_000);
    gate.activate();
    gate.dispatcher(event('one'));
    gate.dispatcher(event('two'));
    gate.dispatcher(event('three'));
    await gate.flush();
    const epoch = gate.currentCursor().runtimeEpoch;
    expect(gate.replay({ runtimeEpoch: epoch, eventSeq: 0 })?.truncated).toBe(true);
    expect(gate.replay({ runtimeEpoch: epoch, eventSeq: 1 })?.events.map((row) => row.event.id))
      .toEqual(['two', 'three']);
    expect(gate.replay({ runtimeEpoch: epoch, eventSeq: 1 })?.truncated).toBe(false);
    expect(gate.replay({ runtimeEpoch: 'old', eventSeq: 0 })).toBeNull();

    const closed = new SwitchableEventGate(() => { throw new Error('must not deliver'); });
    closed.dispatcher(event('buffered'));
    closed.close();
    closed.activate();
    expect(closed.currentCursor().eventSeq).toBe(0);
  });
});
