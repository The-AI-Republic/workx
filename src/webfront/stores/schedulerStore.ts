import { writable } from 'svelte/store';

export interface ScheduledResult {
  taskInput: string;
  scheduledTime: number;
}

let lastScheduledResult: ScheduledResult | null = null;

function createSchedulerStore() {
  const { subscribe, set } = writable('');

  return {
    subscribe,
    setPendingInput: (input: string) => set(input),
    clear: () => set(''),
    setResult: (info: ScheduledResult) => {
      lastScheduledResult = info;
    },
    getAndClearResult: (): ScheduledResult | null => {
      const result = lastScheduledResult;
      lastScheduledResult = null;
      return result;
    },
  };
}

export const schedulerStore = createSchedulerStore();
