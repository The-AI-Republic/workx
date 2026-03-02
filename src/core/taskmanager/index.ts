/**
 * Task Manager Module
 *
 * Barrel export + singleton accessor for TaskStore.
 *
 * @module core/taskmanager
 */

export type {
  Task,
  TaskSummary,
  TaskStatus,
  SessionPlanData,
  PlanningCommand,
} from './types';

export { TaskStore } from './TaskStore';

import { TaskStore } from './TaskStore';
import { getStorageProvider } from '../storage';

let _taskStore: TaskStore | null = null;

/**
 * Get the singleton TaskStore instance.
 * Lazily creates it using the global StorageProvider.
 */
export function getTaskStore(): TaskStore {
  if (!_taskStore) {
    _taskStore = new TaskStore(getStorageProvider());
  }
  return _taskStore;
}
