import { writable } from 'svelte/store';

function createSchedulerStore() {
  const { subscribe, set } = writable('');

  return {
    subscribe,
    setPendingInput: (input: string) => set(input),
    clear: () => set(''),
  };
}

export const schedulerStore = createSchedulerStore();
